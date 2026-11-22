import Foundation

/// Fixture backend for previews, UI tests and screenshots. Nothing here
/// touches the network; a scripted agent turn plays back with real timing so
/// streaming, the Live Activity and notifications can all be exercised.
final class DemoService: BotflowService, @unchecked Sendable {
    private let lock = NSLock()
    private var projectList: [Project]
    private var threadMap: [String: [ThreadSummary]]
    private var histories: [String: [ChatMessage]] = [:]
    private var starred: Set<String> = ["harbor"]
    private var keys = Connections(hasOpenAIKey: false, hasAnthropicKey: false, hasClaudeOAuth: true, hasCodexOAuth: false)

    init() {
        let now = Date()
        func ago(_ hours: Double) -> Date { now.addingTimeInterval(-hours * 3600) }
        projectList = [
            Project(id: "p-tidewater", name: "Tidewater Coffee", platform: "sandboxed-web", model: "claude-sonnet-5-5", backendType: "user", isPublic: false, lastOpened: ago(0.2), cloudflareDeploymentUrl: "https://tidewater-coffee.botflow.app"),
            Project(id: "p-ledger", name: "Pocket Ledger", platform: "swift", model: "claude-opus-5-5", backendType: "none", isPublic: false, lastOpened: ago(3)),
            Project(id: "p-harbor", name: "Harbor — crew scheduling", platform: "sandboxed-web", model: "claude-sonnet-5-5", backendType: "user", isPublic: true, publicSlug: "harbor", starCount: 12, lastOpened: ago(26), cloudflareDeploymentUrl: "https://harbor.botflow.app"),
            Project(id: "p-trail", name: "Trailhead", platform: "swift", model: "gpt-6.1-sol", backendType: "none", isPublic: false, lastOpened: ago(50)),
            Project(id: "p-flowsync", name: "Flowsync", platform: "sandboxed-web", model: "gpt-6-luna", backendType: "none", isPublic: false, lastOpened: ago(96)),
            Project(id: "p-studio", name: "Studio Notes", platform: "sandboxed-web", model: "gpt-6-luna", backendType: "none", isPublic: false, lastOpened: ago(200), shared: true),
        ]
        func thread(_ id: String, _ title: String, _ model: String, _ status: ThreadStatus, unread: Bool = false, hours: Double, queued: Int = 0) -> ThreadSummary {
            ThreadSummary(id: id, title: title, model: model, status: status, unread: unread, createdBy: "u-demo", archived: false, createdAt: ago(hours + 1), updatedAt: ago(hours), lastTurnEndedAt: status == .running ? nil : ago(hours), liveTurnId: status == .running ? "turn-\(id)" : nil, queued: queued)
        }
        threadMap = [
            "p-tidewater": [
                thread("t-order", "Add online ordering with a cart and checkout", "claude-sonnet-5-5", .running, hours: 0.02, queued: 1),
                thread("t-menu", "Which menu layout should the homepage use?", "claude-sonnet-5-5", .needsInput, hours: 0.1),
                thread("t-hero", "Build the single-page Tidewater Coffee landing site", "claude-sonnet-5-5", .idle, unread: true, hours: 2),
                thread("t-seo", "Tighten the SEO tags and add an Open Graph image", "gpt-6-luna", .idle, hours: 30),
            ],
            "p-ledger": [
                thread("t-charts", "Add a monthly spending chart with Swift Charts", "claude-opus-5-5", .running, hours: 0.05),
                thread("t-onboard", "Design a three-step onboarding flow", "claude-opus-5-5", .idle, hours: 5),
            ],
            "p-harbor": [
                thread("t-shift", "Let managers drag shifts between crew members", "claude-sonnet-5-5", .idle, unread: true, hours: 26),
            ],
            "p-trail": [
                thread("t-map", "Show nearby trails on a map with difficulty filters", "gpt-6.1-sol", .error, hours: 50),
            ],
            "p-flowsync": [thread("t-fs", "Add a testimonials grid and a demo call-to-action", "gpt-6-luna", .idle, hours: 96)],
            "p-studio": [thread("t-sn", "Markdown editor with live preview", "gpt-6-luna", .idle, hours: 200)],
        ]
    }

    private func delay(_ seconds: Double = 0.25) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    // MARK: Account

    func me() async throws -> UserProfile {
        UserProfile(id: "u-demo", fullName: "Sam Rivera", firstName: "Sam", username: "samrivera", imageUrl: nil, email: "sam@example.com")
    }

    func connections() async throws -> Connections { lock.withLock { keys } }

    func saveKey(field: String, value: String?) async throws {
        await delay()
        lock.withLock {
            let on = value?.isEmpty == false
            switch field {
            case "openaiApiKey": keys.hasOpenAIKey = on
            case "anthropicApiKey": keys.hasAnthropicKey = on
            case "googleApiKey": keys.hasGoogleKey = on
            case "xaiApiKey": keys.hasXaiKey = on
            case "fireworksApiKey": keys.hasFireworksKey = on
            case "togetherApiKey": keys.hasTogetherKey = on
            default: break
            }
        }
    }

    func credits() async throws -> Credits {
        Credits(tier: .pro, weeklyUsed: 3_800_000, weeklyLimit: 10_000_000, monthlyUsed: 14_200_000, monthlyLimit: 40_000_000, pct: 38, monthlyPct: 36, models: [
            .init(model: "claude-sonnet-5-5", credits: 9_100_000, turns: 64),
            .init(model: "gpt-6-luna", credits: 3_300_000, turns: 121),
            .init(model: "claude-opus-5-5", credits: 1_800_000, turns: 9),
        ])
    }

    func claudePlan() async throws -> ClaudePlanUsage { ClaudePlanUsage(available: true, fiveHour: 48, sevenDay: 21) }

    func subscription() async throws -> Subscription? {
        Subscription(plan: "pro", status: "active", amount: 2600, currency: "usd", interval: "month", periodEnd: Date().addingTimeInterval(86400 * 19), cancelAtPeriodEnd: false)
    }

    func signOut() async {}

    // MARK: Projects

    func projects() async throws -> [Project] {
        await delay(0.15)
        return lock.withLock { projectList }
    }

    func project(_ id: String) async throws -> Project {
        guard let project = lock.withLock({ projectList.first { $0.id == id } }) else {
            throw APIError(status: 404, message: "That project couldn't be found.")
        }
        return project
    }

    func createProject(name: String, platform: ProjectPlatform, model: String, backend: String) async throws -> Project {
        await delay(0.5)
        let project = Project(id: "p-\(UUID().uuidString.prefix(6).lowercased())", name: name, platform: platform == .swift ? "swift" : "sandboxed-web", model: model, backendType: backend, lastOpened: Date())
        lock.withLock {
            projectList.insert(project, at: 0)
            threadMap[project.id] = []
        }
        return project
    }

    func deleteProject(_ id: String) async throws {
        await delay()
        lock.withLock { projectList.removeAll { $0.id == id } }
    }

    func publicProjects(sort: String, platform: String?) async throws -> [PublicProject] {
        await delay(0.2)
        let all = [
            PublicProject(id: "x1", name: "Harbor — crew scheduling", publicSlug: "harbor", publicDescription: "Drag-and-drop shift planning for small crews.", platform: "sandboxed-web", starCount: 212, author: .init(name: "Sam Rivera")),
            PublicProject(id: "x2", name: "Pixelblast", publicSlug: "pixelblast", publicDescription: "A neo-brutalist AI image studio.", platform: "sandboxed-web", starCount: 187, author: .init(name: "Mina Okafor")),
            PublicProject(id: "x3", name: "Sunrise Habits", publicSlug: "sunrise", publicDescription: "A gentle habit tracker with streaks and widgets.", platform: "swift", starCount: 143, author: .init(name: "Jonas Weber")),
            PublicProject(id: "x4", name: "Ledgerline", publicSlug: "ledgerline", publicDescription: "Invoices and expenses for freelancers.", platform: "sandboxed-web", starCount: 98, author: .init(name: "Priya Shah")),
            PublicProject(id: "x5", name: "Tide Times", publicSlug: "tides", publicDescription: "Surf and tide forecasts, beautifully charted.", platform: "swift", starCount: 76, author: .init(name: "Leo Martin")),
            PublicProject(id: "x6", name: "Kanbanana", publicSlug: "kanbanana", publicDescription: "A playful kanban board with real-time sync.", platform: "sandboxed-web", starCount: 54, author: .init(name: "Ada Lindqvist")),
        ]
        let filtered = all.filter { platform == nil || (platform == "swift") == ($0.platform == "swift") }
        return filtered.map { item in
            var copy = item
            copy.hasStarred = lock.withLock { starred.contains(item.publicSlug ?? "") }
            return copy
        }
    }

    func toggleStar(slug: String) async throws -> (starred: Bool, count: Int) {
        let now = lock.withLock { () -> Bool in
            if starred.contains(slug) { starred.remove(slug); return false }
            starred.insert(slug)
            return true
        }
        return (now, now ? 213 : 211)
    }

    // MARK: Threads and turns

    func threads(projectId: String, viewing: String?) async throws -> ThreadsResponse {
        let list = lock.withLock { threadMap[projectId] ?? [] }
        let queue: [QueueItem] = viewing == "t-order" ? [QueueItem(id: "q1", userId: "u-demo", text: "Then add a tip selector to the checkout", hasImages: false, status: "queued", error: nil, createdAt: Date())] : []
        return ThreadsResponse(
            threads: list,
            viewers: [:],
            people: ["u-demo": ThreadPerson(name: "Sam Rivera", initials: "SR", imageUrl: nil)],
            me: "u-demo",
            queue: queue
        )
    }

    func createThread(projectId: String, model: String?) async throws -> ThreadSummary {
        let thread = ThreadSummary(id: "t-\(UUID().uuidString.prefix(6).lowercased())", title: nil, model: model ?? ModelCatalog.defaultId, status: .idle, unread: false, createdBy: "u-demo", archived: false, createdAt: Date(), updatedAt: Date(), lastTurnEndedAt: nil, liveTurnId: nil, queued: 0)
        lock.withLock { threadMap[projectId, default: []].insert(thread, at: 0) }
        return thread
    }

    private func mutate(_ projectId: String, _ threadId: String, _ change: (inout ThreadSummary) -> Void) {
        lock.withLock {
            guard var list = threadMap[projectId], let index = list.firstIndex(where: { $0.id == threadId }) else { return }
            change(&list[index])
            threadMap[projectId] = list
        }
    }

    func updateThread(projectId: String, threadId: String, title: String?, model: String?, archived: Bool?) async throws {
        mutate(projectId, threadId) { thread in
            if let title { thread.title = title }
            if let model { thread.model = model }
            if let archived { thread.archived = archived }
        }
    }

    func deleteThread(projectId: String, threadId: String) async throws {
        lock.withLock { threadMap[projectId]?.removeAll { $0.id == threadId } }
    }

    func markViewed(projectId: String, threadId: String) async {
        mutate(projectId, threadId) { $0.unread = false }
    }

    func history(projectId: String, threadId: String) async throws -> ChatHistory {
        await delay(0.12)
        let stored = lock.withLock { histories[threadId] }
        let messages = stored ?? DemoContent.history(for: threadId)
        let thread = lock.withLock { threadMap[projectId]?.first { $0.id == threadId } }
        return ChatHistory(threadId: threadId, model: thread?.model ?? ModelCatalog.defaultId, title: thread?.title, messages: messages, currentSegmentId: "seg")
    }

    func saveMessage(projectId: String, threadId: String, message: JSONValue) async {
        guard let decoded = StoredMessage.decode(message) else { return }
        lock.withLock {
            var list = histories[threadId] ?? DemoContent.history(for: threadId)
            list.removeAll { $0.id == decoded.id }
            list.append(decoded)
            histories[threadId] = list
        }
    }

    func send(projectId: String, threadId: String, messageId: String, text: String, images: [ImageAttachment]) async throws -> SendOutcome {
        await delay(0.6)
        let turnId = "turn-\(UUID().uuidString.prefix(8).lowercased())"
        mutate(projectId, threadId) { thread in
            if thread.title == nil { thread.title = String(text.prefix(80)) }
            thread.status = .running
            thread.liveTurnId = turnId
            thread.updatedAt = Date()
        }
        return .started(turnId: turnId)
    }

    func turnStatus(projectId: String, threadId: String) async throws -> TurnStatus {
        let thread = lock.withLock { threadMap[projectId]?.first { $0.id == threadId } }
        let live = thread?.status == .running
        return TurnStatus(ok: true, active: live, endedNormally: false, turnId: thread?.liveTurnId, startedAt: Date().timeIntervalSince1970 * 1000 - 42_000, userMessageId: nil)
    }

    func followTurn(projectId: String, threadId: String, turnId: String?) -> AsyncThrowingStream<StreamChunk, Error> {
        let script = DemoContent.turnScript(threadId: threadId, turnId: turnId ?? "turn-\(threadId)")
        return AsyncThrowingStream { continuation in
            let task = Task { [weak self] in
                for step in script {
                    try? await Task.sleep(nanoseconds: UInt64(step.delay * 1_000_000_000))
                    if Task.isCancelled { break }
                    continuation.yield(step.chunk)
                }
                if !Task.isCancelled {
                    self?.mutate(projectId, threadId) { thread in
                        thread.status = .idle
                        thread.liveTurnId = nil
                        thread.lastTurnEndedAt = Date()
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func stop(projectId: String, threadId: String) async throws {
        mutate(projectId, threadId) { thread in
            thread.status = .idle
            thread.liveTurnId = nil
        }
    }

    func cancelQueued(projectId: String, threadId: String, queueId: String) async throws {}

    func answerQuestion(projectId: String, toolCallId: String, selectedIds: [String], selectedLabels: [String], text: String?, dismissed: Bool) async throws {
        await delay()
        mutate(projectId, "t-menu") { $0.status = .running }
    }

    func uploadImage(projectId: String, data: Data, mimeType: String) async throws -> ImageAttachment {
        await delay(0.4)
        return ImageAttachment(url: "demo://image/\(UUID().uuidString)", mediaType: mimeType)
    }

    func activeAgents() async throws -> [AgentActivity] {
        lock.withLock {
            projectList.flatMap { project in
                (threadMap[project.id] ?? [])
                    .filter { $0.status != .idle || $0.unread }
                    .map { AgentActivity(projectId: project.id, projectName: project.name, platform: project.platform, thread: $0) }
            }
        }
    }

    // MARK: Sandbox

    func bootSandbox(projectId: String) async throws { await delay(0.5) }

    func files(projectId: String) async throws -> [SandboxFile] {
        let swift = lock.withLock { projectList.first { $0.id == projectId }?.isSwift ?? false }
        let paths = swift ? DemoContent.swiftFiles : DemoContent.webFiles
        return paths.map { SandboxFile(path: $0, isDirectory: !$0.contains(".")) }
    }

    func readFile(projectId: String, path: String) async throws -> FileContent {
        await delay(0.1)
        return FileContent(content: DemoContent.source(for: path), binary: false, hash: "demo")
    }

    func writeFile(projectId: String, path: String, content: String, baseHash: String?) async throws -> String? {
        await delay()
        return "demo"
    }

    func startDevServer(projectId: String) async throws -> DevServer {
        await delay(0.8)
        return DevServer(previewUrl: "demo://preview", port: 5173)
    }

    func searchFiles(projectId: String, pattern: String) async throws -> [SearchHit] {
        [SearchHit(path: "src/App.tsx", line: 12, text: "export default function App() {"), SearchHit(path: "src/components/Menu.tsx", line: 4, text: "const items = useQuery(api.menu.list)")]
    }

    func run(projectId: String, command: String) -> AsyncThrowingStream<TerminalEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.output("$ \(command)\n", isError: false))
            continuation.yield(.output("vite v7.1.4 building for production...\n✓ 148 modules transformed.\ndist/index.html   0.62 kB\n✓ built in 1.84s\n", isError: false))
            continuation.yield(.exit(0))
            continuation.finish()
        }
    }

    func envVars(projectId: String) async throws -> [EnvVar] {
        [
            EnvVar(key: "VITE_CONVEX_URL", value: "https://happy-otter-123.convex.cloud", isSecret: false, isSystem: true),
            EnvVar(key: "VITE_MAPS_KEY", value: "pk_live_4f9a…", isSecret: false, isSystem: false),
            EnvVar(key: "STRIPE_SECRET_KEY", value: "sk_live_…", isSecret: true, isSystem: false),
        ]
    }

    func setEnvVar(projectId: String, key: String, value: String, secret: Bool) async throws { await delay() }
    func deleteEnvVar(projectId: String, key: String) async throws { await delay() }

    func publish(projectId: String) -> AsyncThrowingStream<PublishEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
                for status in ["Starting build…", "Running pnpm build", "Uploading 42 files…", "Deploying…"] {
                    continuation.yield(.status(status))
                    try? await Task.sleep(nanoseconds: 700_000_000)
                }
                continuation.yield(.published(url: "https://tidewater-coffee.botflow.app"))
                continuation.finish()
            }
        }
    }

    func members(projectId: String) async throws -> [ProjectMember] {
        [
            ProjectMember(id: "m1", email: "mina@example.com", name: "Mina Okafor", role: "editor", status: "active"),
            ProjectMember(id: "m2", email: "leo@example.com", name: "leo@example.com", role: "editor", status: "pending"),
        ]
    }

    func invite(projectId: String, email: String) async throws { await delay() }

    // MARK: Simulator

    func startSimulator(projectId: String, device: SimDevice, landscape: Bool) async throws -> SimulatorSession {
        await delay(0.8)
        return SimulatorSession(sessionId: "demo-sim", wsUrl: "demo://simulator")
    }

    func stopSimulator(projectId: String, sessionId: String) async {}
    func rebuildSimulator(projectId: String, sessionId: String) async throws {}
    func simulatorDesired(projectId: String) async -> String? { nil }
    func publishSimulator(projectId: String, body: JSONValue) async {}

    func registerDevice(token: String, environment: String) async {}
    func registerLiveActivity(token: String, projectId: String, threadId: String, startedAt: Date) async {}
    func syncPurchase(signedTransaction: String) async throws -> Tier { .pro }

    func raw(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue {
        await delay(0.4)
        switch path {
        case "api/oauth/codex/start":
            return .object(["user_code": .string("KDTP-93QX"), "verification_url": .string("https://auth.openai.com/codex/device"), "device_auth_id": .string("demo"), "interval": .number(3)])
        case "api/oauth/codex/poll":
            lock.withLock { keys.hasCodexOAuth = true }
            return .object(["status": .string("success")])
        case "api/oauth/claude/start":
            return .object(["authUrl": .string("https://claude.ai/oauth/authorize"), "verifier": .string("demo")])
        case "api/oauth/claude/exchange":
            lock.withLock { keys.hasClaudeOAuth = true }
            return .object(["ok": .bool(true)])
        case "api/oauth/claude/disconnect":
            lock.withLock { keys.hasClaudeOAuth = false }
            return .object(["ok": .bool(true)])
        case "api/oauth/codex/disconnect":
            lock.withLock { keys.hasCodexOAuth = false }
            return .object(["ok": .bool(true)])
        case "api/oauth/github/status":
            return .object(["connected": .bool(true), "username": .string("samrivera")])
        default:
            return .object(["ok": .bool(true)])
        }
    }
}
