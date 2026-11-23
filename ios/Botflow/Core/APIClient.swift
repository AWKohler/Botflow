import Foundation

struct APIError: LocalizedError, Sendable {
    var status: Int
    var message: String
    var code: String?
    var payload: JSONValue?

    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }
    var isPlanLimit: Bool { code == "limit_reached" || payload?["limitType"] != nil }

    static func from(status: Int, data: Data) -> APIError {
        let payload = try? JSONDecoder().decode(JSONValue.self, from: data)
        // Some errors carry a code in `error` and the sentence in `message`.
        let sentence = payload?["message"]?.stringValue ?? payload?["error"]?.stringValue
        let fallback: String
        switch status {
        case 401: fallback = "Your session has ended. Sign in again."
        case 403: fallback = "You don't have access to that."
        case 404: fallback = "That couldn't be found."
        case 429: fallback = "Too many requests. Try again in a moment."
        case 500...: fallback = "Botflow is having trouble right now. Try again."
        default: fallback = "Something went wrong (\(status))."
        }
        return APIError(
            status: status,
            message: (sentence?.isEmpty == false ? sentence! : fallback),
            code: payload?["error"]?.stringValue ?? payload?["reason"]?.stringValue,
            payload: payload
        )
    }
}

extension Notification.Name {
    static let botflowSessionExpired = Notification.Name("botflow.sessionExpired")
}

/// HTTP transport for the Botflow web API. The session is the same cookie the
/// website uses, kept in this app's cookie store, so the server needs no
/// second way to recognise a signed-in user.
final class APIClient: @unchecked Sendable {
    static let shared = APIClient()

    let session: URLSession
    private let streamSession: URLSession

    var baseURL: URL { AppConfig.baseURL }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self), let date = DateParsing.parse(s) { return date }
            if let n = try? c.decode(Double.self) { return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n) }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unrecognised date")
        }
        return d
    }()

    init() {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 60
        config.waitsForConnectivity = true
        config.httpAdditionalHeaders = ["User-Agent": AppConfig.userAgent, "X-Botflow-Client": "ios"]
        session = URLSession(configuration: config)

        let streaming = URLSessionConfiguration.default
        streaming.httpCookieStorage = .shared
        streaming.timeoutIntervalForRequest = 330
        streaming.timeoutIntervalForResource = 60 * 60
        streaming.httpAdditionalHeaders = config.httpAdditionalHeaders
        streamSession = URLSession(configuration: streaming)
    }

    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        if !items.isEmpty { components.queryItems = items.sorted { $0.name < $1.name } }
        return components.url!
    }

    func makeRequest(_ method: String, _ path: String, query: [String: String?] = [:], body: JSONValue? = nil, timeout: TimeInterval? = nil) -> URLRequest {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            // State-changing routes check the origin the way a browser would send it.
            request.setValue(AppConfig.origin, forHTTPHeaderField: "Origin")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONEncoder().encode(body)
        }
        if let timeout { request.timeoutInterval = timeout }
        return request
    }

    @discardableResult
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, message: "No response from Botflow.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = APIError.from(status: http.statusCode, data: data)
            if error.isUnauthorized {
                await MainActor.run { NotificationCenter.default.post(name: .botflowSessionExpired, object: nil) }
            }
            throw error
        }
        return (data, http)
    }

    func json(_ method: String, _ path: String, query: [String: String?] = [:], body: JSONValue? = nil, timeout: TimeInterval? = nil) async throws -> JSONValue {
        let (data, _) = try await send(makeRequest(method, path, query: query, body: body, timeout: timeout))
        if data.isEmpty { return .null }
        return (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
    }

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await send(makeRequest("GET", path, query: query))
        return try Self.decoder.decode(T.self, from: data)
    }

    func decode<T: Decodable>(_ value: JSONValue, as type: T.Type = T.self) throws -> T {
        try Self.decoder.decode(T.self, from: JSONEncoder().encode(value))
    }

    /// Server-sent events from a streaming route. Ends when the server closes
    /// the stream; a 204 (nothing to follow) ends it at once with no chunks.
    func events(_ path: String, query: [String: String?] = [:]) -> AsyncThrowingStream<StreamChunk, Error> {
        var request = makeRequest("GET", path, query: query)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let streamSession = self.streamSession
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await streamSession.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "No response from Botflow.") }
                    if http.statusCode == 204 {
                        continuation.finish()
                        return
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        var data = Data()
                        for try await byte in bytes { data.append(byte); if data.count > 16_384 { break } }
                        throw APIError.from(status: http.statusCode, data: data)
                    }
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        if payload == "[DONE]" { break }
                        if let chunk = StreamChunk(line: payload) { continuation.yield(chunk) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// A stream that names its events (`event: status` / `data: …`), as the
    /// publish and terminal routes send.
    func namedEvents(_ request: URLRequest) -> AsyncThrowingStream<(event: String, data: String), Error> {
        var request = request
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let streamSession = self.streamSession
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await streamSession.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "No response from Botflow.") }
                    guard (200..<300).contains(http.statusCode) else {
                        var data = Data()
                        for try await byte in bytes { data.append(byte); if data.count > 16_384 { break } }
                        throw APIError.from(status: http.statusCode, data: data)
                    }
                    var event = "message"
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            let data = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                            continuation.yield((event, data))
                            event = "message"
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func upload(_ path: String, fields: [String: String], fileField: String, filename: String, mimeType: String, data fileData: Data) async throws -> JSONValue {
        let boundary = "botflow-\(UUID().uuidString)"
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue(AppConfig.origin, forHTTPHeaderField: "Origin")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        for (name, value) in fields {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\r\nContent-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        let (data, _) = try await send(request)
        return (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
    }

    // MARK: Session cookie

    var hasSessionCookie: Bool {
        sessionCookies.contains { $0.name.hasSuffix("session_token") }
    }

    var sessionCookies: [HTTPCookie] {
        HTTPCookieStorage.shared.cookies(for: baseURL) ?? []
    }

    func clearSession() {
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where baseURL.host.map({ cookie.domain.hasSuffix($0) }) ?? false {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }

    /// Adopt a session cookie handed over by the sign-in exchange (or, in
    /// debug builds, by a test launch argument).
    func adoptSession(name: String, value: String, expires: Date?) {
        guard let host = baseURL.host else { return }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: host,
            .path: "/",
        ]
        if baseURL.scheme == "https" { properties[.secure] = "TRUE" }
        properties[.expires] = expires ?? Date().addingTimeInterval(60 * 60 * 24 * 7)
        if let cookie = HTTPCookie(properties: properties) {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }
}
