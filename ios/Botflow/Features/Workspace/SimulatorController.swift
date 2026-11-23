import AVFoundation
import Foundation
import SwiftUI

/// Runs one cloud simulator session for a Swift project: starts it, follows
/// the build, shows the video and sends touches back.
@MainActor
final class SimulatorController: ObservableObject {
    enum Phase: Equatable {
        case stopped
        case starting(String)
        case building
        case installing
        case live
        case failed(String)
        case ended(String)

        var isActive: Bool {
            switch self {
            case .starting, .building, .installing, .live: return true
            default: return false
            }
        }
    }

    let projectId: String
    private let service: BotflowService

    @Published private(set) var phase: Phase = .stopped
    @Published var device: SimDevice = .iPhone
    @Published private(set) var landscape = false
    @Published private(set) var videoSize = CGSize(width: 1206, height: 2622)
    @Published private(set) var diagnostics: [SimDiagnostic] = []
    @Published private(set) var logTail: [String] = []
    @Published private(set) var buildStartedAt: Date?
    @Published private(set) var hasFrame = false
    /// Vertical drags scroll the page as the finger moves (the default). Off,
    /// every drag is sent as a swipe when the finger lifts.
    @Published var liveScroll = UserDefaults.standard.object(forKey: "sim.liveScroll") as? Bool ?? true {
        didSet { UserDefaults.standard.set(liveScroll, forKey: "sim.liveScroll") }
    }
    /// Whether the one-time note on how touch works has been read.
    @Published var touchHintSeen = UserDefaults.standard.bool(forKey: "sim.touchHintSeen") {
        didSet { UserDefaults.standard.set(touchHintSeen, forKey: "sim.touchHintSeen") }
    }

    /// The layer the video is drawn into; the view hosts it.
    let displayLayer = AVSampleBufferDisplayLayer()

    private var client: SimStreamClient?
    private var sessionId: String?
    private let decoder = H264Decoder()
    private let decodeQueue = DispatchQueue(label: "io.botflow.sim.decode", qos: .userInteractive)
    private var desiredTask: Task<Void, Never>?
    private var buildId: String?
    private var buildState: String?
    private var diagnosticsFinal = false
    private var isDemo = false

    init(projectId: String, service: BotflowService = Services.shared) {
        self.projectId = projectId
        self.service = service
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = UIColor.black.cgColor
    }

    deinit {
        desiredTask?.cancel()
        client?.close()
    }

    var errors: [SimDiagnostic] { diagnostics.filter(\.isError) }
    var warnings: [SimDiagnostic] { diagnostics.filter { !$0.isError } }

    /// Size of the device screen as shown, after rotation.
    /// The simulated screen in its own points (the stream is its pixels: 3×
    /// on a phone, 2× on an iPad).
    var logicalSize: CGSize {
        let scale: CGFloat = min(videoSize.width, videoSize.height) > 1500 ? 2 : 3
        return CGSize(width: displaySize.width / scale, height: displaySize.height / scale)
    }

    var displaySize: CGSize {
        landscape ? CGSize(width: videoSize.height, height: videoSize.width) : videoSize
    }

    // MARK: Agent control

    /// While the workspace is open, the agent's `startSimulator` /
    /// `stopSimulator` tools reach the simulator through here.
    func watchAgentRequests() {
        guard desiredTask == nil else { return }
        desiredTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if let action = await self.service.simulatorDesired(projectId: self.projectId) {
                    if action == "start" {
                        if self.sessionId != nil, self.phase == .live || { if case .failed = self.phase { return true } else { return false } }() {
                            await self.rebuild()
                        } else if !self.phase.isActive {
                            await self.start()
                        }
                    } else if action == "stop" {
                        await self.stop()
                    }
                }
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            }
        }
    }

    func stopWatching() {
        desiredTask?.cancel()
        desiredTask = nil
    }

    // MARK: Lifecycle

    func start() async {
        guard !phase.isActive else { return }
        setPhase(.starting("Reserving"))
        diagnostics = []
        logTail = []
        hasFrame = false
        do {
            let session = try await service.startSimulator(projectId: projectId, device: device, landscape: landscape)
            sessionId = session.sessionId
            if session.wsUrl.hasPrefix("demo://") {
                isDemo = true
                await playDemo()
                return
            }
            guard let url = URL(string: session.wsUrl) else { throw APIError(status: 500, message: "The simulator returned a bad address.") }
            setPhase(.starting("Connecting"))
            connect(url)
        } catch {
            setPhase(.failed(error.localizedDescription))
        }
    }

    func stop() async {
        client?.close()
        client = nil
        let id = sessionId
        sessionId = nil
        flushDisplay()
        hasFrame = false
        setPhase(.stopped)
        if let id, !isDemo { await service.stopSimulator(projectId: projectId, sessionId: id) }
    }

    /// Build the project's current code into the running session.
    func rebuild() async {
        guard let sessionId, !isDemo else {
            await start()
            return
        }
        buildStartedAt = Date()
        diagnostics = []
        setPhase(.building)
        do {
            try await service.rebuildSimulator(projectId: projectId, sessionId: sessionId)
        } catch {
            setPhase(.failed(error.localizedDescription))
        }
    }

    func setDevice(_ device: SimDevice) async {
        guard device != self.device else { return }
        self.device = device
        videoSize = device == .iPhone ? CGSize(width: 1206, height: 2622) : CGSize(width: 2064, height: 2752)
        if phase.isActive {
            await stop()
            await start()
        }
    }

    func toggleOrientation() {
        landscape.toggle()
        client?.setOrientation(landscape: landscape)
        Haptics.tap()
    }

    // MARK: Input

    /// A touch in the view, normalised to the device screen as displayed.
    /// In landscape the stream is still the portrait surface turned a quarter
    /// turn, so coordinates are turned back before they are sent.
    private func surface(_ x: Double, _ y: Double) -> (Double, Double) {
        let cx = min(1, max(0, x)), cy = min(1, max(0, y))
        return landscape ? (1 - cy, cx) : (cx, cy)
    }

    func tap(x: Double, y: Double) {
        let point = surface(x, y)
        client?.send(.tap(x: point.0, y: point.1))
    }

    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double) {
        let start = surface(fromX, fromY), end = surface(toX, toY)
        client?.send(.swipe(startX: start.0, startY: start.1, endX: end.0, endY: end.1))
    }

    func scroll(x: Double, y: Double, deltaX: Double, deltaY: Double) {
        let point = surface(x, y)
        let delta = landscape ? (-deltaY, deltaX) : (deltaX, deltaY)
        client?.send(.scroll(x: point.0, y: point.1, deltaX: delta.0, deltaY: delta.1))
    }

    func type(_ text: String) {
        if text == "\n" { client?.send(.key("Enter")) }
        else { client?.send(.text(text)) }
    }

    func key(_ name: String) {
        client?.send(.key(name))
    }

    // MARK: Stream

    private func connect(_ url: URL) {
        decoder.reset()
        let client = SimStreamClient(url: url) { [weak self] event in
            if case .video(let data, let keyframe, _) = event {
                self?.enqueue(data, keyframe: keyframe)
                return
            }
            Task { @MainActor in self?.handle(event) }
        }
        self.client = client
        client.start()
    }

    private nonisolated func enqueue(_ data: Data, keyframe: Bool) {
        decodeQueue.async { [weak self] in
            guard let self else { return }
            let renderer = self.displayLayer.sampleBufferRenderer
            if renderer.status == .failed {
                // A decode error: clear the pipeline and resume at the next keyframe.
                renderer.flush()
                self.decoder.reset()
            }
            guard let sample = self.decoder.sampleBuffer(from: data, keyframe: keyframe) else { return }
            renderer.enqueue(sample)
            let dimensions = self.decoder.dimensions
            Task { @MainActor in
                if !self.hasFrame { withAnimation(.easeOut(duration: 0.5)) { self.hasFrame = true } }
                if let dimensions, dimensions.width > 0, CGFloat(dimensions.width) != self.videoSize.width || CGFloat(dimensions.height) != self.videoSize.height {
                    self.videoSize = CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height))
                }
            }
        }
    }

    private func flushDisplay() {
        decodeQueue.async { [displayLayer, decoder] in
            displayLayer.sampleBufferRenderer.flush(removingDisplayedImage: true, completionHandler: nil)
            decoder.reset()
        }
    }

    private func handle(_ event: SimEvent) {
        switch event {
        case .open:
            if case .starting = phase { setPhase(.starting("Starting")) }
        case .state(let state, let queuePosition, let reason):
            switch state {
            case "queued":
                setPhase(.starting(queuePosition.map { "In line, #\($0)" } ?? "Reserving"))
            case "building":
                if phase != .building {
                    buildStartedAt = buildStartedAt ?? Date()
                    setPhase(.building)
                }
            case "starting":
                setPhase(.installing)
            case "streaming":
                setPhase(.live)
                Haptics.success()
            case "ended":
                client?.close()
                client = nil
                sessionId = nil
                setPhase(.ended(reason == "inactivity" ? "Closed after 3 minutes without input." : "The simulator session ended."))
            case "error":
                if case .failed = phase {} else { setPhase(.failed("The simulator session failed.")) }
            default:
                break
            }
        case .videoConfig(let width, let height):
            if width > 0, height > 0 { videoSize = CGSize(width: width, height: height) }
        case .video:
            break
        case .status:
            break
        case .error(let message):
            setPhase(.failed(message))
        case .buildStatus(let state, let exitCode, let message):
            switch state {
            case "started":
                buildStartedAt = Date()
                diagnostics = []
                logTail = []
                diagnosticsFinal = false
                buildId = UUID().uuidString.lowercased()
                buildState = "started"
                publishBuild()
                setPhase(.building)
            case "succeeded":
                buildState = "succeeded"
                publishBuild(message: message)
                setPhase(.installing)
            case "failed":
                buildState = "failed"
                publishBuild(exitCode: exitCode, message: message ?? "Build failed")
                setPhase(.failed(message ?? "The build failed."))
                Haptics.error()
            default:
                break
            }
        case .buildLog(let line):
            logTail = Array((logTail + [line]).suffix(200))
        case .diagnostics(let list, let final):
            if final {
                diagnostics = list
                diagnosticsFinal = true
            } else {
                diagnostics.append(contentsOf: list)
            }
            publishBuild()
        case .orientation(let isLandscape):
            landscape = isLandscape
        case .closed:
            if phase.isActive {
                client = nil
                sessionId = nil
                setPhase(.ended("The connection to the simulator was lost."))
            }
        }
    }

    private func setPhase(_ next: Phase) {
        guard next != phase else { return }
        // Not animated here: each view animates the part of itself that changes.
        phase = next
        let state: String
        switch next {
        case .stopped, .ended: state = "stopped"
        case .starting: state = "starting"
        case .building: state = "building"
        case .installing: state = "installing"
        case .live: state = "live"
        case .failed: state = "failed"
        }
        guard !isDemo else { return }
        Task { await service.publishSimulator(projectId: projectId, body: .object(["state": .string(state), "deviceModel": .string(device.rawValue)])) }
    }

    /// Report the build outcome so the agent's `startSimulator` tool, which
    /// waits on it, can read the compiler errors.
    private func publishBuild(exitCode: Int? = nil, message: String? = nil) {
        guard let buildId, let buildState, !isDemo else { return }
        let capped = diagnostics.sorted { $0.isError && !$1.isError }.prefix(80).map { item -> JSONValue in
            .object([
                "severity": .string(item.isError ? "error" : "warning"),
                "file": item.file.map(JSONValue.string) ?? .null,
                "line": item.line.map { .number(Double($0)) } ?? .null,
                "column": item.column.map { .number(Double($0)) } ?? .null,
                "message": .string(String(item.message.prefix(600))),
            ])
        }
        var build: [String: JSONValue] = [
            "buildId": .string(buildId),
            "state": .string(buildState),
            "diagnostics": .array(Array(capped)),
            "finalized": .bool(diagnosticsFinal),
        ]
        if let exitCode { build["exitCode"] = .number(Double(exitCode)) }
        if let message { build["message"] = .string(message) }
        Task { await service.publishSimulator(projectId: projectId, body: .object(["build": .object(build)])) }
    }

    private func playDemo() async {
        setPhase(.building)
        buildStartedAt = Date()
        try? await Task.sleep(nanoseconds: 900_000_000)
        setPhase(.installing)
        try? await Task.sleep(nanoseconds: 500_000_000)
        hasFrame = true
        setPhase(.live)
    }

    var isDemoSession: Bool { isDemo }
}
