import AVFoundation
import CoreMedia
import Foundation

// MARK: - Protocol

struct SimDiagnostic: Hashable, Identifiable, Sendable {
    var isError: Bool
    var file: String?
    var line: Int?
    var column: Int?
    var message: String

    var id: String { "\(file ?? ""):\(line ?? 0):\(message)" }
    var location: String? {
        guard let file else { return nil }
        return line.map { "\(file):\($0)" } ?? file
    }
}

enum SimInput: Sendable {
    /// `holdMs` keeps the finger down that long (hosts with "gesture-duration").
    case tap(x: Double, y: Double, holdMs: Double? = nil)
    /// `durationMs` is how long the swipe takes (hosts with "gesture-duration").
    case swipe(startX: Double, startY: Double, endX: Double, endY: Double, durationMs: Double? = nil)
    case scroll(x: Double, y: Double, deltaX: Double, deltaY: Double)
    case text(String)
    case key(String)

    var json: JSONValue {
        switch self {
        case .tap(let x, let y, let holdMs):
            var fields: [String: JSONValue] = ["kind": .string("tap"), "normX": .number(x), "normY": .number(y)]
            if let holdMs { fields["durationMs"] = .number(holdMs.rounded()) }
            return .object(fields)
        case .swipe(let sx, let sy, let ex, let ey, let durationMs):
            var fields: [String: JSONValue] = ["kind": .string("swipe"), "startX": .number(sx), "startY": .number(sy), "endX": .number(ex), "endY": .number(ey)]
            if let durationMs { fields["durationMs"] = .number(durationMs.rounded()) }
            return .object(fields)
        case .scroll(let x, let y, let dx, let dy):
            return .object(["kind": .string("scroll"), "normX": .number(x), "normY": .number(y), "deltaX": .number(dx), "deltaY": .number(dy)])
        case .text(let text):
            return .object(["kind": .string("text"), "text": .string(text)])
        case .key(let key):
            return .object(["kind": .string("key"), "key": .string(key)])
        }
    }
}

enum SimEvent: Sendable {
    case open
    case state(String, queuePosition: Int?, reason: String?)
    case videoConfig(width: Int, height: Int)
    /// The simulated screen's size in its own points, and the optional input
    /// fields this session's host honours (empty for hosts that predate them).
    case calibration(logicalWidth: Double?, logicalHeight: Double?, features: [String])
    case video(Data, keyframe: Bool, timestampMs: UInt64)
    case status(String)
    case error(String)
    case buildStatus(state: String, exitCode: Int?, message: String?)
    case buildLog(String)
    case diagnostics([SimDiagnostic], final: Bool)
    case orientation(landscape: Bool)
    case closed(code: Int)
}

/// WebSocket client for a Mac simulator session: JSON control messages plus
/// binary H.264 frames (`[ver=1][flags][timestamp u64 BE][Annex B]`).
final class SimStreamClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pingTimer: Timer?
    private var closedByUs = false
    private let onEvent: @Sendable (SimEvent) -> Void

    init(url: URL, onEvent: @escaping @Sendable (SimEvent) -> Void) {
        self.url = url
        self.onEvent = onEvent
    }

    func start() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 16 * 1024 * 1024
        self.task = task
        task.resume()
        receive()
        DispatchQueue.main.async { [weak self] in
            self?.pingTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
                self?.sendJSON(.object(["type": .string("ping")]))
            }
        }
    }

    func close() {
        closedByUs = true
        DispatchQueue.main.async { [weak self] in self?.pingTimer?.invalidate() }
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }

    func send(_ input: SimInput) {
        sendJSON(.object(["type": .string("input"), "input": input.json]))
    }

    func setOrientation(landscape: Bool) {
        sendJSON(.object(["type": .string("set_orientation"), "orientation": .string(landscape ? "landscape" : "portrait")]))
    }

    private func sendJSON(_ value: JSONValue) {
        guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.data(let data)):
                self.handleBinary(data)
                self.receive()
            case .success(.string(let text)):
                self.handleText(text)
                self.receive()
            case .success:
                self.receive()
            case .failure:
                if !self.closedByUs { self.onEvent(.closed(code: self.task?.closeCode.rawValue ?? 1006)) }
            }
        }
    }

    private func handleBinary(_ data: Data) {
        guard data.count > 10, data[data.startIndex] == 1 else { return }
        let flags = data[data.startIndex + 1]
        var timestamp: UInt64 = 0
        for offset in 2..<10 { timestamp = (timestamp << 8) | UInt64(data[data.startIndex + offset]) }
        onEvent(.video(data.subdata(in: (data.startIndex + 10)..<data.endIndex), keyframe: flags & 1 == 1, timestampMs: timestamp))
    }

    private func handleText(_ text: String) {
        guard let data = text.data(using: .utf8), let message = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
        switch message["type"]?.stringValue {
        case "state":
            onEvent(.state(message["state"]?.stringValue ?? "", queuePosition: message["queuePosition"]?.intValue, reason: message["reason"]?.stringValue))
        case "video_config":
            onEvent(.videoConfig(width: message["width"]?.intValue ?? 0, height: message["height"]?.intValue ?? 0))
        case "calibration":
            let logical = message["deviceLogical"]
            let features = message["features"]?.arrayValue?.compactMap(\.stringValue) ?? []
            onEvent(.calibration(logicalWidth: logical?["w"]?.doubleValue, logicalHeight: logical?["h"]?.doubleValue, features: features))
        case "status":
            onEvent(.status(message["message"]?.stringValue ?? ""))
        case "error":
            onEvent(.error(message["message"]?.stringValue ?? "Simulator error"))
        case "build_status":
            onEvent(.buildStatus(state: message["state"]?.stringValue ?? "", exitCode: message["exitCode"]?.intValue, message: message["message"]?.stringValue))
        case "build_log":
            onEvent(.buildLog(message["line"]?.stringValue ?? ""))
        case "build_diagnostics":
            let list = (message["diagnostics"]?.arrayValue ?? []).map { item in
                SimDiagnostic(
                    isError: item["severity"]?.stringValue != "warning",
                    file: item["file"]?.stringValue,
                    line: item["line"]?.intValue,
                    column: item["column"]?.intValue,
                    message: item["message"]?.stringValue ?? ""
                )
            }
            onEvent(.diagnostics(list, final: message["final"]?.boolValue ?? false))
        case "orientation":
            onEvent(.orientation(landscape: message["orientation"]?.stringValue == "landscape"))
        default:
            break
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onEvent(.open)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if !closedByUs { onEvent(.closed(code: closeCode.rawValue)) }
    }
}

// MARK: - H.264

/// Turns Annex B H.264 access units into sample buffers for an
/// `AVSampleBufferDisplayLayer`, which decodes them in hardware.
final class H264Decoder {
    private var formatDescription: CMVideoFormatDescription?
    private var sps: Data?
    private var pps: Data?
    private var waitingForKeyframe = true
    private(set) var dimensions: CMVideoDimensions?

    func reset() {
        waitingForKeyframe = true
    }

    /// Split an Annex B buffer on its start codes (`00 00 01` / `00 00 00 01`).
    static func nalUnits(in data: Data) -> [Data] {
        var units: [Data] = []
        let bytes = [UInt8](data)
        let count = bytes.count
        var start = -1
        var i = 0
        while i + 2 < count {
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 {
                if start >= 0 {
                    var end = i
                    if end > start, bytes[end - 1] == 0 { end -= 1 } // the fourth byte of a long start code
                    if end > start { units.append(Data(bytes[start..<end])) }
                }
                start = i + 3
                i += 3
            } else {
                i += 1
            }
        }
        if start >= 0, start < count { units.append(Data(bytes[start..<count])) }
        return units
    }

    func sampleBuffer(from accessUnit: Data, keyframe: Bool) -> CMSampleBuffer? {
        var payload = Data()
        var sawIDR = false
        for nal in Self.nalUnits(in: accessUnit) {
            guard let header = nal.first else { continue }
            switch header & 0x1f {
            case 7:
                if sps != nal { sps = nal; formatDescription = nil }
            case 8:
                if pps != nal { pps = nal; formatDescription = nil }
            case 5:
                sawIDR = true
                appendLengthPrefixed(nal, to: &payload)
            case 1:
                appendLengthPrefixed(nal, to: &payload)
            default:
                break // SEI, access unit delimiters: not needed to display
            }
        }
        if formatDescription == nil, let sps, let pps {
            formatDescription = Self.makeFormat(sps: sps, pps: pps)
            if let formatDescription { dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription) }
        }
        guard let formatDescription, !payload.isEmpty else { return nil }
        if waitingForKeyframe {
            guard sawIDR || keyframe else { return nil }
            waitingForKeyframe = false
        }

        var blockBuffer: CMBlockBuffer?
        let length = payload.count
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: length, blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil, offsetToData: 0, dataLength: length, flags: 0, blockBufferOut: &blockBuffer
        ) == noErr, let blockBuffer else { return nil }
        let copied = payload.withUnsafeBytes { pointer in
            CMBlockBufferReplaceDataBytes(with: pointer.baseAddress!, blockBuffer: blockBuffer, offsetIntoDestination: 0, dataLength: length)
        }
        guard copied == noErr else { return nil }

        var sampleBuffer: CMSampleBuffer?
        var sampleSize = length
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .invalid, decodeTimeStamp: .invalid)
        guard CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: blockBuffer, formatDescription: formatDescription,
            sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &sampleBuffer
        ) == noErr, let sampleBuffer else { return nil }

        // A live stream: show each frame as soon as it is decoded.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true) {
            let dictionary = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                dictionary,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }
        return sampleBuffer
    }

    private func appendLengthPrefixed(_ nal: Data, to payload: inout Data) {
        var length = UInt32(nal.count).bigEndian
        withUnsafeBytes(of: &length) { payload.append(contentsOf: $0) }
        payload.append(nal)
    }

    private static func makeFormat(sps: Data, pps: Data) -> CMVideoFormatDescription? {
        var description: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { spsPointer in
            pps.withUnsafeBytes { ppsPointer in
                let pointers: [UnsafePointer<UInt8>] = [
                    spsPointer.bindMemory(to: UInt8.self).baseAddress!,
                    ppsPointer.bindMemory(to: UInt8.self).baseAddress!,
                ]
                let sizes = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointers,
                    parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &description
                )
            }
        }
        return status == noErr ? description : nil
    }
}
