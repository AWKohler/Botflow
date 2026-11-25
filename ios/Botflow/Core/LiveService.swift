import Foundation

final class LiveService: BotflowService, @unchecked Sendable {
    private let api = APIClient.shared

    private func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s
    }

    // MARK: Account

    func me() async throws -> UserProfile {
        let raw = try await api.json("GET", "api/identity/me")
        guard let user = raw["user"], let id = user["id"]?.stringValue else {
            throw APIError(status: 401, message: "Your session has ended. Sign in again.")
        }
        let email = user["primaryEmailAddress"]?["emailAddress"]?.stringValue
            ?? user["emailAddresses"]?[0]?["emailAddress"]?.stringValue
            ?? user["email"]?.stringValue
        return UserProfile(
            id: id,
            fullName: user["fullName"]?.stringValue ?? user["name"]?.stringValue,
            firstName: user["firstName"]?.stringValue,
            username: user["username"]?.stringValue,
            imageUrl: user["imageUrl"]?.stringValue,
            email: email
        )
    }

    func connections() async throws -> Connections {
        try await api.get("api/user-settings")
    }

    func saveKey(field: String, value: String?) async throws {
        _ = try await api.json("POST", "api/user-settings", body: .object([field: value.map(JSONValue.string) ?? .null]))
    }

    func credits() async throws -> Credits {
        try await api.get("api/usage/credits")
    }

    func claudePlan() async throws -> ClaudePlanUsage {
        try await api.get("api/usage/claude-plan")
    }

    func subscription() async throws -> Subscription? {
        let raw = try await api.json("GET", "api/billing/status")
        if let apple = raw["appStore"], apple != .null, let plan = apple["plan"]?.stringValue {
            return Subscription(
                plan: plan,
                status: "active",
                interval: apple["interval"]?.stringValue,
                periodEnd: apple["expiresAt"]?.stringValue.flatMap(DateParsing.parse),
                cancelAtPeriodEnd: false,
                viaAppStore: true
            )
        }
        guard let sub = raw["subscription"], sub != .null else { return nil }
        return try api.decode(sub)
    }

    func signOut() async {
        _ = try? await api.json("DELETE", "api/native/devices")
        _ = try? await api.json("POST", "api/auth/sign-out", body: .object([:]))
        api.clearSession()
    }

    // MARK: Projects

    func projects() async throws -> [Project] {
        try await api.get("api/projects")
    }

    func project(_ id: String) async throws -> Project {
        try await api.get("api/projects/\(enc(id))")
    }

    func createProject(name: String, platform: ProjectPlatform, model: String, backend: String) async throws -> Project {
        let raw = try await api.json("POST", "api/projects", body: .object([
            "name": .string(name),
            "platform": .string(platform == .swift ? "swift" : "sandboxed-web"),
            "model": .string(model),
            "backendType": .string(backend),
        ]))
        return try api.decode(raw)
    }

    func deleteProject(_ id: String) async throws {
        _ = try await api.json("DELETE", "api/projects/\(enc(id))", timeout: 120)
    }

    func publicProjects(sort: String, platform: String?) async throws -> [PublicProject] {
        let raw = try await api.json("GET", "api/public/projects", query: ["sort": sort, "platform": platform, "limit": "48"])
        return try api.decode(raw["projects"] ?? .array([]))
    }

    func toggleStar(slug: String) async throws -> (starred: Bool, count: Int) {
        let raw = try await api.json("POST", "api/public/projects/\(enc(slug))/star", body: .object([:]))
        return (raw["starred"]?.boolValue ?? false, raw["starCount"]?.intValue ?? 0)
    }

    // MARK: Threads and turns

    func threads(projectId: String, viewing: String?) async throws -> ThreadsResponse {
        try await api.get("api/projects/\(enc(projectId))/threads", query: ["viewing": viewing])
    }

    func createThread(projectId: String, model: String?) async throws -> ThreadSummary {
        let raw = try await api.json("POST", "api/projects/\(enc(projectId))/threads", body: .object(model.map { ["model": .string($0)] } ?? [:]))
        return try api.decode(raw["thread"] ?? .null)
    }

    func updateThread(projectId: String, threadId: String, title: String?, model: String?, archived: Bool?) async throws {
        var body: [String: JSONValue] = [:]
        if let title { body["title"] = .string(title) }
        if let model { body["model"] = .string(model) }
        if let archived { body["archived"] = .bool(archived) }
        _ = try await api.json("PATCH", "api/projects/\(enc(projectId))/threads/\(enc(threadId))", body: .object(body))
    }

    func deleteThread(projectId: String, threadId: String) async throws {
        _ = try await api.json("DELETE", "api/projects/\(enc(projectId))/threads/\(enc(threadId))")
    }

    func markViewed(projectId: String, threadId: String) async {
        _ = try? await api.json("POST", "api/projects/\(enc(projectId))/threads/\(enc(threadId))/viewed", body: .object([:]))
    }

    func history(projectId: String, threadId: String) async throws -> ChatHistory {
        let raw = try await api.json("GET", "api/chat", query: ["projectId": projectId, "threadId": threadId, "includeAllSegments": "true"])
        return ChatHistory(
            threadId: raw["threadId"]?.stringValue ?? threadId,
            model: raw["model"]?.stringValue ?? ModelCatalog.defaultId,
            title: raw["title"]?.stringValue,
            messages: (raw["messages"]?.arrayValue ?? []).compactMap(StoredMessage.decode),
            currentSegmentId: raw["currentSegmentId"]?.stringValue
        )
    }

    func saveMessage(projectId: String, threadId: String, message: JSONValue) async {
        _ = try? await api.json("POST", "api/chat", body: .object([
            "projectId": .string(projectId), "threadId": .string(threadId), "message": message,
        ]))
    }

    /// Every prompt goes through the thread's server-side queue. An idle agent
    /// starts on it at once; a busy one takes it when its turn ends. Either
    /// way the turn belongs to the server, so it survives this app being
    /// suspended, and the app only ever follows a turn, never owns one.
    func send(projectId: String, threadId: String, messageId: String, text: String, images: [ImageAttachment]) async throws -> SendOutcome {
        let message = StoredMessage.encodeUserMessage(id: messageId, text: text, images: images)
        let raw = try await api.json(
            "POST",
            "api/projects/\(enc(projectId))/threads/\(enc(threadId))/queue",
            body: .object(["message": message]),
            timeout: 300
        )
        let drain = raw["drain"]
        if drain?["started"]?.boolValue == true, let turnId = drain?["turnId"]?.stringValue {
            return .started(turnId: turnId)
        }
        if drain?["why"]?.stringValue == "failed" {
            // The reason is recorded on the queue row.
            let queueId = raw["queueId"]?.stringValue
            let listing = try? await threads(projectId: projectId, viewing: threadId)
            let reason = listing?.queue?.first { $0.id == queueId }?.error
            return .failed(reason ?? "The agent could not start. Try again.")
        }
        return .queued
    }

    func turnStatus(projectId: String, threadId: String) async throws -> TurnStatus {
        try await api.get("api/agent/claude-code/turn-status", query: ["projectId": projectId, "threadId": threadId])
    }

    func followTurn(projectId: String, threadId: String, turnId: String?) -> AsyncThrowingStream<StreamChunk, Error> {
        api.events("api/agent/claude-code/reattach", query: ["projectId": projectId, "threadId": threadId, "turnId": turnId])
    }

    func stop(projectId: String, threadId: String) async throws {
        _ = try await api.json("POST", "api/agent/claude-code/stop", body: .object([
            "projectId": .string(projectId), "threadId": .string(threadId), "clearQueue": .bool(true),
        ]))
    }

    func cancelQueued(projectId: String, threadId: String, queueId: String) async throws {
        _ = try await api.json("DELETE", "api/projects/\(enc(projectId))/threads/\(enc(threadId))/queue/\(enc(queueId))")
    }

    func answerQuestion(projectId: String, toolCallId: String, selectedIds: [String], selectedLabels: [String], text: String?, dismissed: Bool) async throws {
        var body: [String: JSONValue] = [
            "toolCallId": .string(toolCallId),
            "selectedIds": .array(selectedIds.map(JSONValue.string)),
            "selectedLabels": .array(selectedLabels.map(JSONValue.string)),
            "dismissed": .bool(dismissed),
        ]
        if let text, !text.isEmpty { body["text"] = .string(text) }
        _ = try await api.json("POST", "api/projects/\(enc(projectId))/chat/questions/answer", body: .object(body))
    }

    func uploadImage(projectId: String, data: Data, mimeType: String) async throws -> ImageAttachment {
        let ext = mimeType == "image/png" ? "png" : mimeType == "image/webp" ? "webp" : "jpg"
        let raw = try await api.upload(
            "api/chat-images/upload",
            fields: ["projectId": projectId],
            fileField: "file",
            filename: "photo.\(ext)",
            mimeType: mimeType,
            data: data
        )
        guard let url = raw["url"]?.stringValue else { throw APIError(status: 500, message: "The image could not be uploaded.") }
        return ImageAttachment(url: url, mediaType: mimeType)
    }

    func activeAgents() async throws -> [AgentActivity] {
        let raw = try await api.json("GET", "api/native/agents")
        return try api.decode(raw["agents"] ?? .array([]))
    }

    // MARK: Sandbox

    func bootSandbox(projectId: String) async throws {
        _ = try await api.json("POST", "api/projects/\(enc(projectId))/sandbox/session", body: .object([:]), timeout: 180)
        _ = try? await api.json("POST", "api/projects/\(enc(projectId))/sandbox/seed", body: .object([:]), timeout: 180)
    }

    func files(projectId: String) async throws -> [SandboxFile] {
        let raw = try await api.json("GET", "api/projects/\(enc(projectId))/sandbox/files", timeout: 120)
        let entries = raw["files"]?.objectValue ?? [:]
        return entries
            .map { SandboxFile(path: $0.key, isDirectory: $0.value["type"]?.stringValue == "folder") }
            .sorted { $0.path < $1.path }
    }

    func readFile(projectId: String, path: String) async throws -> FileContent {
        try await api.get("api/projects/\(enc(projectId))/sandbox/files", query: ["path": path])
    }

    func writeFile(projectId: String, path: String, content: String, baseHash: String?) async throws -> String? {
        var body: [String: JSONValue] = ["path": .string(path), "content": .string(content)]
        if let baseHash { body["baseHash"] = .string(baseHash) }
        let raw = try await api.json("PUT", "api/projects/\(enc(projectId))/sandbox/files", body: .object(body))
        return raw["hash"]?.stringValue
    }

    func startDevServer(projectId: String) async throws -> DevServer {
        let raw = try await api.json(
            "POST",
            "api/projects/\(enc(projectId))/sandbox/devserver",
            body: .object(["port": .number(5173), "installFirst": .bool(true)]),
            timeout: 300
        )
        guard let url = raw["previewUrl"]?.stringValue else {
            throw APIError(status: 500, message: "The preview did not start.")
        }
        return DevServer(previewUrl: url, port: raw["port"]?.intValue)
    }

    func searchFiles(projectId: String, pattern: String) async throws -> [SearchHit] {
        let raw = try await api.json("POST", "api/projects/\(enc(projectId))/sandbox/search", body: .object([
            "pattern": .string(pattern), "caseInsensitive": .bool(true), "maxResults": .number(80),
        ]))
        return (raw["results"]?.arrayValue ?? []).compactMap { hit in
            guard let file = hit["file"]?.stringValue else { return nil }
            return SearchHit(path: file, line: hit["line"]?.intValue ?? 0, text: hit["text"]?.stringValue ?? "")
        }
    }

    func run(projectId: String, command: String) -> AsyncThrowingStream<TerminalEvent, Error> {
        let request = api.makeRequest("POST", "api/projects/\(enc(projectId))/sandbox/exec", body: .object([
            "cmd": .string("sh"), "args": .array([.string("-c"), .string(command)]),
        ]), timeout: 300)
        let source = api.namedEvents(request)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await (event, data) in source {
                        // Each payload is a JSON string.
                        let text = (try? JSONDecoder().decode(String.self, from: Data(data.utf8))) ?? data
                        switch event {
                        case "stdout": continuation.yield(.output(text, isError: false))
                        case "stderr": continuation.yield(.output(text, isError: true))
                        case "exit": continuation.yield(.exit(Int(text) ?? 0))
                        case "error": continuation.yield(.failed(text))
                        default: break
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func envVars(projectId: String) async throws -> [EnvVar] {
        let raw = try await api.json("GET", "api/projects/\(enc(projectId))/env")
        let user = raw["envVars"]?.arrayValue ?? []
        let system = raw["systemEnvVars"]?.arrayValue ?? []
        return (system + user).compactMap { item in
            guard let key = item["key"]?.stringValue else { return nil }
            return EnvVar(key: key, value: item["value"]?.stringValue, isSecret: item["isSecret"]?.boolValue, isSystem: item["isSystem"]?.boolValue)
        }
    }

    func setEnvVar(projectId: String, key: String, value: String, secret: Bool) async throws {
        _ = try await api.json("POST", "api/projects/\(enc(projectId))/env", body: .object([
            "key": .string(key), "value": .string(value), "isSecret": .bool(secret),
        ]))
    }

    func deleteEnvVar(projectId: String, key: String) async throws {
        _ = try await api.json("DELETE", "api/projects/\(enc(projectId))/env", body: .object(["key": .string(key)]))
    }

    func publish(projectId: String) -> AsyncThrowingStream<PublishEvent, Error> {
        let request = api.makeRequest("POST", "api/projects/\(enc(projectId))/sandbox/publish", body: .object([:]), timeout: 600)
        let source = api.namedEvents(request)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await (event, data) in source {
                        let text = data.replacingOccurrences(of: "\\n", with: "\n")
                        switch event {
                        case "status": continuation.yield(.status(text))
                        case "output": continuation.yield(.output(text))
                        case "build_error": continuation.yield(.failed(text))
                        case "published":
                            let payload = try? JSONDecoder().decode(JSONValue.self, from: Data(data.utf8))
                            continuation.yield(.published(url: payload?["url"]?.stringValue ?? ""))
                        default: break
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func members(projectId: String) async throws -> [ProjectMember] {
        let raw = try await api.json("GET", "api/projects/\(enc(projectId))/members")
        return try api.decode(raw["members"] ?? .array([]))
    }

    func invite(projectId: String, email: String) async throws {
        _ = try await api.json("POST", "api/projects/\(enc(projectId))/members", body: .object(["email": .string(email)]))
    }

    // MARK: Simulator

    func simulatorDevices() async -> [SimDevice] {
        guard let raw = try? await api.json("GET", "api/swift-preview/config") else { return SimDevice.base }
        let listed = (raw["devices"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(SimDevice.init(rawValue:)) }
        return listed.isEmpty ? SimDevice.base : listed
    }

    func startSimulator(projectId: String, device: SimDevice, landscape: Bool) async throws -> SimulatorSession {
        let raw = try await api.json(
            "POST",
            "api/projects/\(enc(projectId))/swift-preview/start",
            body: .object(["deviceModel": .string(device.rawValue), "orientation": .string(landscape ? "landscape" : "portrait")]),
            timeout: 150
        )
        return try api.decode(raw)
    }

    func stopSimulator(projectId: String, sessionId: String) async {
        _ = try? await api.json("DELETE", "api/projects/\(enc(projectId))/swift-preview/\(enc(sessionId))")
    }

    func rebuildSimulator(projectId: String, sessionId: String) async throws {
        _ = try await api.json("POST", "api/projects/\(enc(projectId))/swift-preview/rebuild", query: ["sessionId": sessionId], body: .object([:]), timeout: 150)
    }

    func simulatorDesired(projectId: String) async -> String? {
        let raw = try? await api.json("GET", "api/projects/\(enc(projectId))/swift-preview/state")
        return raw?["desired"]?["action"]?.stringValue
    }

    func publishSimulator(projectId: String, body: JSONValue) async {
        _ = try? await api.json("POST", "api/projects/\(enc(projectId))/swift-preview/state", body: body)
    }

    // MARK: Devices, notifications, purchases

    func registerDevice(token: String, environment: String) async -> Bool {
        let raw = try? await api.json("POST", "api/native/devices", body: .object([
            "token": .string(token), "environment": .string(environment), "bundleId": .string(AppConfig.bundleId),
        ]))
        return raw?["push"]?.boolValue ?? false
    }

    func registerLiveActivity(token: String, projectId: String, threadId: String, startedAt: Date) async {
        _ = try? await api.json("POST", "api/native/live-activity", body: .object([
            "token": .string(token), "projectId": .string(projectId), "threadId": .string(threadId),
            "environment": .string(AppConfig.apnsEnvironment),
            "startedAt": .number((startedAt.timeIntervalSince1970 * 1000).rounded()),
        ]))
    }

    func syncPurchase(signedTransaction: String) async throws -> Tier {
        let raw = try await api.json("POST", "api/native/purchases/apple", body: .object(["signedTransaction": .string(signedTransaction)]))
        return Tier(rawValue: raw["tier"]?.stringValue ?? "free") ?? .free
    }

    func raw(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue {
        try await api.json(method, path, body: body ?? (method == "GET" ? nil : .object([:])))
    }
}
