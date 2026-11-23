import Foundation
import SwiftUI

/// Everything about one open project: its threads (polled while visible), the
/// sandbox, and the conversation on screen.
@MainActor
final class WorkspaceStore: ObservableObject {
    enum SandboxState: Equatable {
        case idle, booting, ready
        case failed(String)
    }

    let projectId: String
    let service: BotflowService

    @Published var project: Project
    @Published private(set) var threads: [ThreadSummary] = []
    @Published private(set) var people: [String: ThreadPerson] = [:]
    @Published private(set) var queue: [QueueItem] = []
    @Published private(set) var me: String?
    @Published var currentThreadId: String?
    @Published private(set) var session: ThreadSession?
    @Published private(set) var sandbox: SandboxState = .idle
    @Published private(set) var threadsLoaded = false
    @Published var loadError: String?

    // Code
    @Published private(set) var files: [SandboxFile] = []
    @Published private(set) var filesLoading = false

    // Web preview
    @Published private(set) var previewURL: URL?
    @Published private(set) var previewStarting = false
    @Published var previewError: String?
    @Published var previewReloadToken = 0

    /// The project's cloud simulator (Swift projects). Owned here so the app
    /// pane and the full-screen view show the same session.
    let simulator: SimulatorController

    private var pollTask: Task<Void, Never>?
    private var pendingPrompt: String?

    init(project: Project, service: BotflowService = Services.shared, initialPrompt: String? = nil) {
        self.project = project
        self.projectId = project.id
        self.service = service
        self.pendingPrompt = initialPrompt
        self.simulator = SimulatorController(projectId: project.id, service: service)
    }

    deinit {
        pollTask?.cancel()
    }

    var openThreads: [ThreadSummary] { threads.filter { !$0.archived } }
    var archivedThreads: [ThreadSummary] { threads.filter { $0.archived } }
    var currentThread: ThreadSummary? { threads.first { $0.id == currentThreadId } }
    var runningElsewhere: [ThreadSummary] {
        openThreads.filter { $0.id != currentThreadId && ($0.status == .running || $0.status == .needsInput) }
    }

    // MARK: Lifecycle

    func open(threadId preferred: String? = nil) async {
        async let fresh = try? service.project(projectId)
        await refreshThreads()
        if let fresh = await fresh { project = fresh }

        let stored = UserDefaults.standard.string(forKey: "thread:\(projectId)")
        let target = [preferred, stored].compactMap { $0 }.first { id in openThreads.contains { $0.id == id } }
            ?? openThreads.first?.id
        if let target {
            await select(threadId: target)
        } else {
            await newThread()
        }
        startPolling()
        Task { await bootSandbox() }

        if let prompt = pendingPrompt, let session {
            pendingPrompt = nil
            await session.send(text: prompt, images: [])
            await refreshThreads()
        }
    }

    func close() {
        pollTask?.cancel()
        pollTask = nil
        simulator.stopWatching()
        // A cloud simulator is held for this workspace; hand it back.
        if simulator.phase.isActive { Task { [simulator] in await simulator.stop() } }
        PushManager.shared.visibleThreadId = nil
    }

    func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                // Quicker while an agent works, slower when everything is idle.
                let busy = await self?.hasActivity ?? false
                try? await Task.sleep(nanoseconds: busy ? 3_000_000_000 : 8_000_000_000)
                if Task.isCancelled { return }
                await self?.refreshThreads()
            }
        }
    }

    private var hasActivity: Bool {
        threads.contains { $0.status == .running || $0.status == .needsInput } || (session?.phase.isBusy ?? false)
    }

    func refreshThreads() async {
        do {
            let response = try await service.threads(projectId: projectId, viewing: currentThreadId)
            let previous = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0.status) })
            withAnimation(.snappy(duration: 0.25)) {
                threads = response.threads
                people = response.people ?? [:]
                queue = response.queue ?? []
                me = response.me
            }
            threadsLoaded = true
            loadError = nil

            if let current = currentThread, let session {
                if current.status == .running, previous[current.id] != .running {
                    session.noticeRunning(turnId: current.liveTurnId)
                } else if current.status != .running, previous[current.id] == .running {
                    await session.refreshIfIdle()
                }
            }
            // A background thread just finished or asked for something.
            for thread in response.threads where thread.id != currentThreadId {
                guard let before = previous[thread.id], before != thread.status else { continue }
                if thread.status == .needsInput {
                    ToastCenter.shared.show("“\(thread.displayTitle)” needs your input", symbol: "questionmark.bubble.fill", tone: .warning)
                } else if before == .running, thread.status == .idle {
                    ToastCenter.shared.show("“\(thread.displayTitle)” finished", symbol: "checkmark.circle.fill", tone: .success)
                } else if thread.status == .error {
                    ToastCenter.shared.show("“\(thread.displayTitle)” stopped with an error", symbol: "exclamationmark.triangle.fill", tone: .danger)
                }
            }
        } catch {
            if !threadsLoaded { loadError = error.localizedDescription }
        }
    }

    // MARK: Threads

    func select(threadId: String) async {
        guard let thread = threads.first(where: { $0.id == threadId }) else { return }
        if session?.threadId == threadId { return }
        currentThreadId = threadId
        UserDefaults.standard.set(threadId, forKey: "thread:\(projectId)")
        PushManager.shared.visibleThreadId = threadId
        let next = ThreadSession(projectId: projectId, projectName: project.name, thread: thread, service: service)
        next.onTurnEnded = { [weak self] in
            Task {
                await self?.refreshThreads()
                self?.previewReloadToken += 1
                await self?.loadFiles()
            }
        }
        session = next
        await next.load(isRunning: thread.status == .running, liveTurnId: thread.liveTurnId)
        if let index = threads.firstIndex(where: { $0.id == threadId }) { threads[index].unread = false }
    }

    @discardableResult
    func newThread(model: String? = nil) async -> ThreadSummary? {
        do {
            let thread = try await service.createThread(projectId: projectId, model: model ?? currentThread?.model ?? project.model)
            withAnimation(.snappy) { threads.insert(thread, at: 0) }
            await select(threadId: thread.id)
            return thread
        } catch {
            ToastCenter.shared.error(error)
            return nil
        }
    }

    func rename(_ thread: ThreadSummary, to title: String) async {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if let index = threads.firstIndex(where: { $0.id == thread.id }) { threads[index].title = clean }
        do { try await service.updateThread(projectId: projectId, threadId: thread.id, title: clean, model: nil, archived: nil) }
        catch { ToastCenter.shared.error(error) }
    }

    func setArchived(_ thread: ThreadSummary, _ archived: Bool) async {
        if let index = threads.firstIndex(where: { $0.id == thread.id }) {
            withAnimation(.snappy) { threads[index].archived = archived }
        }
        do {
            try await service.updateThread(projectId: projectId, threadId: thread.id, title: nil, model: nil, archived: archived)
            if archived, thread.id == currentThreadId {
                if let next = openThreads.first { await select(threadId: next.id) } else { await newThread() }
            }
        } catch { ToastCenter.shared.error(error) }
    }

    func delete(_ thread: ThreadSummary) async {
        do {
            try await service.deleteThread(projectId: projectId, threadId: thread.id)
            withAnimation(.snappy) { threads.removeAll { $0.id == thread.id } }
            if thread.id == currentThreadId {
                session = nil
                currentThreadId = nil
                if let next = openThreads.first { await select(threadId: next.id) } else { await newThread() }
            }
        } catch { ToastCenter.shared.error(error) }
    }

    func setModel(_ modelId: String) async {
        guard let thread = currentThread else { return }
        if let index = threads.firstIndex(where: { $0.id == thread.id }) { threads[index].model = modelId }
        session?.model = modelId
        project.model = modelId
        do { try await service.updateThread(projectId: projectId, threadId: thread.id, title: nil, model: modelId, archived: nil) }
        catch { ToastCenter.shared.error(error) }
    }

    func cancelQueued(_ item: QueueItem) async {
        guard let threadId = currentThreadId else { return }
        withAnimation(.snappy) { queue.removeAll { $0.id == item.id } }
        try? await service.cancelQueued(projectId: projectId, threadId: threadId, queueId: item.id)
    }

    // MARK: Sandbox, files and preview

    func bootSandbox() async {
        guard sandbox == .idle || { if case .failed = sandbox { return true } else { return false } }() else { return }
        sandbox = .booting
        do {
            try await service.bootSandbox(projectId: projectId)
            sandbox = .ready
            await loadFiles()
        } catch {
            sandbox = .failed(error.localizedDescription)
        }
    }

    func loadFiles() async {
        guard sandbox == .ready else { return }
        filesLoading = files.isEmpty
        defer { filesLoading = false }
        if let list = try? await service.files(projectId: projectId) { files = list }
    }

    func startPreview(force: Bool = false) async {
        guard !project.isSwift, !previewStarting, force || previewURL == nil else { return }
        previewStarting = true
        previewError = nil
        defer { previewStarting = false }
        do {
            if sandbox != .ready { await bootSandbox() }
            let server = try await service.startDevServer(projectId: projectId)
            previewURL = URL(string: server.previewUrl)
            previewReloadToken += 1
        } catch {
            previewError = error.localizedDescription
        }
    }
}
