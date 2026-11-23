import Foundation

/// Everything the app asks of the Botflow backend. `LiveService` talks to the
/// web API; `DemoService` serves fixtures for previews, UI tests and screenshots.
protocol BotflowService: AnyObject, Sendable {
    // Account
    func me() async throws -> UserProfile
    func connections() async throws -> Connections
    func saveKey(field: String, value: String?) async throws
    func credits() async throws -> Credits
    func claudePlan() async throws -> ClaudePlanUsage
    func subscription() async throws -> Subscription?
    func signOut() async

    // Projects
    func projects() async throws -> [Project]
    func project(_ id: String) async throws -> Project
    func createProject(name: String, platform: ProjectPlatform, model: String, backend: String) async throws -> Project
    func deleteProject(_ id: String) async throws
    func publicProjects(sort: String, platform: String?) async throws -> [PublicProject]
    func toggleStar(slug: String) async throws -> (starred: Bool, count: Int)

    // Threads and turns
    func threads(projectId: String, viewing: String?) async throws -> ThreadsResponse
    func createThread(projectId: String, model: String?) async throws -> ThreadSummary
    func updateThread(projectId: String, threadId: String, title: String?, model: String?, archived: Bool?) async throws
    func deleteThread(projectId: String, threadId: String) async throws
    func markViewed(projectId: String, threadId: String) async
    func history(projectId: String, threadId: String) async throws -> ChatHistory
    /// Save a finished assistant message (an idempotent upsert by message id).
    func saveMessage(projectId: String, threadId: String, message: JSONValue) async
    func send(projectId: String, threadId: String, messageId: String, text: String, images: [ImageAttachment]) async throws -> SendOutcome
    func turnStatus(projectId: String, threadId: String) async throws -> TurnStatus
    func followTurn(projectId: String, threadId: String, turnId: String?) -> AsyncThrowingStream<StreamChunk, Error>
    func stop(projectId: String, threadId: String) async throws
    func cancelQueued(projectId: String, threadId: String, queueId: String) async throws
    func answerQuestion(projectId: String, toolCallId: String, selectedIds: [String], selectedLabels: [String], text: String?, dismissed: Bool) async throws
    func uploadImage(projectId: String, data: Data, mimeType: String) async throws -> ImageAttachment
    func activeAgents() async throws -> [AgentActivity]

    // Sandbox
    func bootSandbox(projectId: String) async throws
    func files(projectId: String) async throws -> [SandboxFile]
    func readFile(projectId: String, path: String) async throws -> FileContent
    func writeFile(projectId: String, path: String, content: String, baseHash: String?) async throws -> String?
    func startDevServer(projectId: String) async throws -> DevServer
    func searchFiles(projectId: String, pattern: String) async throws -> [SearchHit]
    func run(projectId: String, command: String) -> AsyncThrowingStream<TerminalEvent, Error>
    func envVars(projectId: String) async throws -> [EnvVar]
    func setEnvVar(projectId: String, key: String, value: String, secret: Bool) async throws
    func deleteEnvVar(projectId: String, key: String) async throws
    func publish(projectId: String) -> AsyncThrowingStream<PublishEvent, Error>
    func members(projectId: String) async throws -> [ProjectMember]
    func invite(projectId: String, email: String) async throws

    // Simulator
    func startSimulator(projectId: String, device: SimDevice, landscape: Bool) async throws -> SimulatorSession
    func stopSimulator(projectId: String, sessionId: String) async
    func rebuildSimulator(projectId: String, sessionId: String) async throws
    /// What the agent last asked of the simulator ("start" / "stop"), delivered once.
    func simulatorDesired(projectId: String) async -> String?
    /// Tell the server (and so the agent) what the simulator is doing.
    func publishSimulator(projectId: String, body: JSONValue) async

    // Devices, notifications, purchases
    /// Returns whether the server is able to push to this device.
    func registerDevice(token: String, environment: String) async -> Bool
    func registerLiveActivity(token: String, projectId: String, threadId: String, startedAt: Date) async
    func syncPurchase(signedTransaction: String) async throws -> Tier

    /// A plain call to a web API route, for the less common account flows
    /// (connecting Claude, ChatGPT and GitHub).
    func raw(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue
}

struct SearchHit: Hashable, Identifiable, Sendable {
    var path: String
    var line: Int
    var text: String
    var id: String { "\(path):\(line)" }
}

enum TerminalEvent: Sendable {
    case output(String, isError: Bool)
    case exit(Int)
    case failed(String)
}

enum PublishEvent: Sendable {
    case status(String)
    case output(String)
    case failed(String)
    case published(url: String)
}

enum SimDevice: String, CaseIterable, Sendable {
    case iPhone = "iPhone-16-Pro"
    case iPad = "iPad-Pro"

    var label: String { self == .iPhone ? "iPhone" : "iPad" }
    var symbol: String { self == .iPhone ? "iphone" : "ipad" }
}

enum Services {
    static let shared: BotflowService = AppConfig.isDemo ? DemoService() : LiveService()
}
