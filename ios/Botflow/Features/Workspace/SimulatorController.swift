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

    // MARK: iPhone Duo
    // The Duo has two screens and a hinge. Its pictures go on a 3D model
    // (Features/Workspace/Duo) instead of the layer above: one decoder per
    // panel hands frames to whichever Duo views are on screen.

    /// The devices this person can start: the iPhone and the iPad, plus the
    /// Duo when a host that has it serves them.
    @Published private(set) var availableDevices: [SimDevice] = SimDevice.base
    /// The host's report of the Duo's hinge and panels. Nil until it streams.
    @Published private(set) var duoState: SimDuoState?
    /// The latest picture of each panel, for a Duo view that appears mid-session.
    private(set) var duoFrames: [DuoDisplay: DuoFrame] = [:]
    /// How the Duo was last left (fold, attitude, zoom), shared by the views
    /// of it: the pane and full screen show the same device, not two.
    var duoPosture = DuoSceneView.Posture()
    private var duoSinks: [UUID: (DuoDisplay, DuoFrame) -> Void] = [:]
    private let duoDecoders: [DuoDisplay: DuoVideoDecoder]
    private let duoRelay = DuoFrameRelay()
    /// The hinge angle and held orientation last asked of the host, to avoid repeats.
    private var duoHingeSent: Double?
    private var duoOrientationSent: String?
    private var duoHingeTimer: Timer?
    private var duoHingePending: Double?
    private var duoHingeSentAt: Date = .distantPast

    private var client: SimStreamClient?
    private var sessionId: String?
    private let decoder = H264Decoder()
    private let decodeQueue = DispatchQueue(label: "io.botflow.sim.decode", qos: .userInteractive)
    private var desiredTask: Task<Void, Never>?
    private var buildId: String?
    private var buildState: String?
    private var diagnosticsFinal = false
    private var isDemo = false
    /// Whether the running session is an iPhone Duo's. Read on the decode queue.
    private nonisolated(unsafe) var isDuoSession = false

    init(projectId: String, service: BotflowService = Services.shared) {
        self.projectId = projectId
        self.service = service
        let relay = duoRelay
        duoDecoders = Dictionary(uniqueKeysWithValues: DuoDisplay.allCases.map { display in
            (display, DuoVideoDecoder(display: display) { display, frame in relay.deliver(display, frame) })
        })
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = UIColor.black.cgColor
        relay.handler = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                for (display, frame) in relay.take() { self.deliverDuoFrame(display, frame) }
            }
        }
        // Back from the background the decoders start over: ask for each
        // panel's picture again instead of waiting for its next keyframe,
        // which on a still screen is seconds away.
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.resyncDuoVideo() }
        }
        #if DEBUG
        // `-BotflowSimDevice iPhone-Duo` starts on a given device, for tests and screenshots.
        if let raw = UserDefaults.standard.string(forKey: "BotflowSimDevice"), let chosen = SimDevice(rawValue: raw) {
            device = chosen
            if chosen == .duo { videoSize = Duo.innerPixels }
        }
        #endif
    }

    deinit {
        desiredTask?.cancel()
        client?.close()
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
    }

    private var foregroundObserver: NSObjectProtocol?

    private func resyncDuoVideo() {
        guard device == .duo, phase == .live, !isDemo else { return }
        let decoders = duoDecoders
        decodeQueue.async { for decoder in decoders.values { decoder.reset() } }
        client?.resyncVideo()
    }

    /// Ask which devices this person can start (once per controller).
    func loadDevices() async {
        let devices = await service.simulatorDevices()
        availableDevices = devices
        // The Duo was picked last time but no host with one serves them now.
        if !devices.contains(device), !phase.isActive { device = .iPhone }
    }

    /// Hand each panel's frames to a Duo view. Returns a token to stop with.
    func addDuoSink(_ sink: @escaping (DuoDisplay, DuoFrame) -> Void) -> UUID {
        let id = UUID()
        duoSinks[id] = sink
        for (display, frame) in duoFrames { sink(display, frame) }
        return id
    }

    func removeDuoSink(_ id: UUID) {
        duoSinks[id] = nil
    }

    private func deliverDuoFrame(_ display: DuoDisplay, _ frame: DuoFrame) {
        guard device == .duo, phase.isActive else { return }
        duoFrames[display] = frame
        for sink in duoSinks.values { sink(display, frame) }
        if !hasFrame { withMotion(.easeOut(duration: 0.5)) { hasFrame = true } }
    }

    private var hostTakesDuoInput: Bool { device == .duo && (isDemo || hostFeatures.contains("duo-displays")) }

    /// One finger on one of the Duo's panels, as it moves.
    func duoTouch(_ display: DuoDisplay, phase: String, x: Double, y: Double, finger: Int) {
        guard hostTakesDuoInput, finger == 0 || hostFeatures.contains("multi-touch") else { return }
        client?.send(.touch(display: display.rawValue, phase: phase, x: min(1, max(0, x)), y: min(1, max(0, y)), finger: finger))
    }

    /// Fold the Duo. While the hinge is being dragged the angle is sent about
    /// thirty times a second; `settled` sends the final one at once.
    func setDuoHinge(_ hinge: Double, settled: Bool) {
        guard device == .duo else { return }
        if isDemo {
            // No host to answer: light the panel a real Duo would.
            let open = hinge > 90
            duoState = SimDuoState(hingeAngle: hinge, hingeMoving: false, orientation: duoOrientationSent, coverLit: !open, innerLit: open)
            return
        }
        guard phase == .live, hostFeatures.contains("duo-hinge") else { return }
        if settled {
            duoHingeTimer?.invalidate()
            duoHingeTimer = nil
            duoHingePending = nil
            sendDuoHinge(hinge)
            return
        }
        duoHingePending = hinge
        guard duoHingeTimer == nil else { return }
        let wait = max(0, 0.033 - Date().timeIntervalSince(duoHingeSentAt))
        duoHingeTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.duoHingeTimer = nil
                if let pending = self.duoHingePending { self.sendDuoHinge(pending) }
                self.duoHingePending = nil
            }
        }
    }

    private func sendDuoHinge(_ hinge: Double) {
        let rounded = (hinge * 10).rounded() / 10
        duoHingeSentAt = Date()
        guard duoHingeSent != rounded else { return }
        duoHingeSent = rounded
        client?.send(.hinge(rounded))
    }

    /// How the Duo is held: iOS turns the interface to match.
    func setDuoOrientation(_ orientation: DuoHeldOrientation) {
        guard device == .duo, duoOrientationSent != orientation.rawValue else { return }
        if isDemo {
            duoOrientationSent = orientation.rawValue
            return
        }
        guard phase == .live, hostFeatures.contains("device-orientation") else { return }
        duoOrientationSent = orientation.rawValue
        client?.send(.deviceOrientation(orientation.rawValue))
    }

    /// A hardware button: "home", "lock", "volumeUp", "volumeDown".
    func pressButton(_ button: String) {
        guard phase == .live, hostFeatures.contains("hardware-buttons") else { return }
        if button.hasPrefix("volume"), !hostFeatures.contains("volume-buttons") { return }
        client?.send(.button(button))
        Haptics.tap()
    }

    private func resetDuo() {
        duoState = nil
        duoFrames = [:]
        duoHingeSent = nil
        duoOrientationSent = nil
        duoHingeTimer?.invalidate()
        duoHingeTimer = nil
        duoHingePending = nil
        let decoders = duoDecoders
        decodeQueue.async { for decoder in decoders.values { decoder.reset() } }
    }

    var errors: [SimDiagnostic] { diagnostics.filter(\.isError) }
    var warnings: [SimDiagnostic] { diagnostics.filter { !$0.isError } }

    /// Size of the device screen as shown, after rotation.
    /// Optional input fields this session's host honours, as it reports them.
    @Published private(set) var hostFeatures: Set<String> = []
    /// The host can hold a press and replay a swipe over a given time.
    var hostTakesDurations: Bool { hostFeatures.contains("gesture-duration") }
    /// The host can rest a finger at the end of a swipe before lifting it, so
    /// a scroll stops where it was left.
    var hostRestsSwipes: Bool { hostFeatures.contains("swipe-end-hold") }
    private var reportedLogicalSize: CGSize?

    /// The simulated screen in its own points: as the host reports it, or
    /// worked out from the stream (its pixels: 3× on a phone, 2× on an iPad).
    var logicalSize: CGSize {
        if let reported = reportedLogicalSize {
            let portrait = CGSize(width: min(reported.width, reported.height), height: max(reported.width, reported.height))
            return landscape ? CGSize(width: portrait.height, height: portrait.width) : portrait
        }
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
        resetDuo()
        isDuoSession = device == .duo
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
        resetDuo()
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
        switch device {
        case .iPhone: videoSize = CGSize(width: 1206, height: 2622)
        case .iPad: videoSize = CGSize(width: 2064, height: 2752)
        case .duo: videoSize = Duo.innerPixels   // not laid out from this: the Duo is a 3D model
        }
        landscape = false
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

    /// A press held in place. Only hosts that take durations can do it.
    func hold(x: Double, y: Double, milliseconds: Double) {
        guard hostTakesDurations else { return }
        let point = surface(x, y)
        client?.send(.tap(x: point.0, y: point.1, holdMs: milliseconds))
    }

    /// `seconds` is how long the finger took, and `rest` how long it stayed
    /// still before lifting. Hosts that take durations replay the swipe at
    /// that pace; hosts that can rest a finger also hold it at the end. Older
    /// hosts replay at their own fixed speed and let go.
    func swipe(fromX: Double, fromY: Double, toX: Double, toY: Double, seconds: Double? = nil, rest: Double? = nil) {
        let start = surface(fromX, fromY), end = surface(toX, toY)
        let duration = hostTakesDurations ? seconds.map { min(3000, max(60, $0 * 1000)) } : nil
        let hold = hostRestsSwipes ? rest.map { min(1000, max(0, $0 * 1000)) } : nil
        client?.send(.swipe(startX: start.0, startY: start.1, endX: end.0, endY: end.1, durationMs: duration, endHoldMs: hold))
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
            if case .video(let data, let keyframe, _, let stream) = event {
                self?.enqueue(data, keyframe: keyframe, stream: stream)
                return
            }
            Task { @MainActor in self?.handle(event) }
        }
        self.client = client
        client.start()
    }

    private nonisolated func enqueue(_ data: Data, keyframe: Bool, stream: Int) {
        decodeQueue.async { [weak self] in
            guard let self else { return }
            // An iPhone Duo: one stream per panel, decoded to textures for the 3D model.
            if let decoder = self.duoDecoder(forStream: stream) {
                decoder.decode(data, keyframe: keyframe)
                return
            }
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
                if !self.hasFrame { withMotion(.easeOut(duration: 0.5)) { self.hasFrame = true } }
                if let dimensions, dimensions.width > 0, CGFloat(dimensions.width) != self.videoSize.width || CGFloat(dimensions.height) != self.videoSize.height {
                    self.videoSize = CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height))
                }
            }
        }
    }

    /// The Duo decoder for a stream, or nil when the session is not a Duo's.
    /// (Called on the decode queue; the flag it reads is set on the main actor
    /// before any frame of a session can arrive.)
    private nonisolated func duoDecoder(forStream stream: Int) -> DuoVideoDecoder? {
        guard isDuoSession else { return nil }
        return duoDecoders[stream == 1 ? .inner : .cover]
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
        case .videoConfig(let width, let height, let display):
            // A Duo's two streams are sized by its model, not by this.
            if display == nil, width > 0, height > 0 { videoSize = CGSize(width: width, height: height) }
        case .duoState(let state):
            duoState = state
        case .calibration(let width, let height, let features):
            hostFeatures = Set(features)
            if let width, let height, width > 0, height > 0 { reportedLogicalSize = CGSize(width: width, height: height) }
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
        if device == .duo {
            // Stand-in pictures for both panels, and the panel an open Duo lights.
            // (Unless the device was already folded while this "built": then that stands.)
            duoState = duoState ?? SimDuoState(hingeAngle: 180, hingeMoving: false, orientation: nil, coverLit: false, innerLit: true)
            for (display, frame) in DuoDemoFrames.make() { deliverDuoFrameForDemo(display, frame) }
        }
        hasFrame = true
        setPhase(.live)
    }

    private func deliverDuoFrameForDemo(_ display: DuoDisplay, _ frame: DuoFrame) {
        duoFrames[display] = frame
        for sink in duoSinks.values { sink(display, frame) }
    }

    var isDemoSession: Bool { isDemo }
}

/// Carries decoded Duo frames from the decoders (made before the controller
/// exists as `self`) to the controller.
///
/// Frames arrive on VideoToolbox's threads, up to 120 a second, each holding a
/// buffer of many megabytes. Only the newest of each panel is kept, and at most
/// one hop to the main actor is pending at a time: if the main thread stalls,
/// frames are dropped here instead of piling up behind it.
final class DuoFrameRelay: @unchecked Sendable {
    /// Called (on any thread) when there are frames to `take`.
    var handler: (@Sendable () -> Void)?
    private let lock = NSLock()
    private var latest: [DuoDisplay: DuoFrame] = [:]
    private var hopPending = false

    func deliver(_ display: DuoDisplay, _ frame: DuoFrame) {
        lock.lock()
        latest[display] = frame
        let hop = !hopPending
        hopPending = true
        lock.unlock()
        if hop { handler?() }
    }

    /// The newest frame of each panel since the last call.
    func take() -> [DuoDisplay: DuoFrame] {
        lock.lock()
        defer { lock.unlock() }
        let frames = latest
        latest = [:]
        hopPending = false
        return frames
    }
}
