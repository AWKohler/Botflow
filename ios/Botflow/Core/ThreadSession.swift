import Foundation
import SwiftUI

/// One open conversation with an agent: its messages, the live turn being
/// followed, and the prompt in flight.
@MainActor
final class ThreadSession: ObservableObject {
    enum Phase: Equatable {
        case loading
        case idle
        /// The prompt is on its way and the agent is starting up.
        case starting
        case streaming
        case failed(String)

        var isBusy: Bool { self == .starting || self == .streaming }
    }

    let projectId: String
    let threadId: String
    private let service: BotflowService
    private(set) var projectName: String
    private(set) var threadTitle: String

    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var phase: Phase = .loading
    @Published private(set) var usage: ContextUsage?
    @Published private(set) var loadError: String?
    @Published var model: String
    /// The assistant message being written, kept apart from `messages` so
    /// only one row re-renders while text streams in.
    @Published private(set) var live: ChatMessage?

    /// Called when a turn ends, so the thread list can refresh.
    var onTurnEnded: (() -> Void)?

    private var followTask: Task<Void, Never>?
    private var turnStartedAt: Date?
    private var lastReportedTool: String?

    init(projectId: String, projectName: String, thread: ThreadSummary, service: BotflowService = Services.shared) {
        self.projectId = projectId
        self.projectName = projectName
        self.threadId = thread.id
        self.threadTitle = thread.displayTitle
        self.model = thread.model
        self.service = service
    }

    deinit {
        followTask?.cancel()
    }

    var allMessages: [ChatMessage] {
        guard let live else { return messages }
        return messages.filter { $0.id != live.id } + [live]
    }

    var pendingQuestion: ToolCall? {
        let source = live ?? messages.last
        guard let source, source.role == .assistant else { return nil }
        return source.toolCalls.last { $0.name == "ask_question" && $0.state == .running }
    }

    // MARK: Loading

    func load(isRunning: Bool, liveTurnId: String?) async {
        do {
            let history = try await service.history(projectId: projectId, threadId: threadId)
            messages = history.messages
            model = history.model
            loadError = nil
            if phase == .loading { phase = .idle }
        } catch {
            loadError = error.localizedDescription
            if phase == .loading { phase = .idle }
        }
        await service.markViewed(projectId: projectId, threadId: threadId)
        if isRunning, followTask == nil {
            follow(turnId: liveTurnId, startedAt: nil)
        }
    }

    func refreshIfIdle() async {
        guard !phase.isBusy else { return }
        if let history = try? await service.history(projectId: projectId, threadId: threadId) {
            messages = history.messages
        }
    }

    /// The thread list says this thread started running (someone else's
    /// prompt, a queued message, or another device): follow along.
    func noticeRunning(turnId: String?) {
        guard !phase.isBusy, followTask == nil else { return }
        follow(turnId: turnId, startedAt: nil)
    }

    // MARK: Sending

    func send(text: String, images: [ImageAttachment]) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty else { return }
        let messageId = UUID().uuidString.lowercased()
        var parts: [ChatPart] = images.map { .image($0) }
        if !trimmed.isEmpty { parts.append(.text(id: messageId, text: trimmed)) }

        let wasBusy = phase.isBusy
        if !wasBusy {
            withAnimation(.snappy) {
                messages.append(ChatMessage(id: messageId, role: .user, parts: parts, createdAt: Date()))
                phase = .starting
            }
            if threadTitle == "New chat" { threadTitle = String(trimmed.prefix(80)) }
            LiveActivityManager.shared.start(
                projectId: projectId,
                projectName: projectName,
                threadId: threadId,
                threadTitle: threadTitle,
                modelName: ModelCatalog.name(model)
            )
        }
        Haptics.soft()

        do {
            let outcome = try await service.send(projectId: projectId, threadId: threadId, messageId: messageId, text: trimmed, images: images)
            switch outcome {
            case .started(let turnId):
                follow(turnId: turnId, startedAt: Date())
            case .queued:
                // It waits its turn; the queue strip shows it.
                if !wasBusy {
                    messages.removeAll { $0.id == messageId }
                    phase = .idle
                    await LiveActivityManager.shared.cancel(threadId: threadId)
                }
                onTurnEnded?()
            case .failed(let reason):
                if !wasBusy {
                    phase = .failed(reason)
                    await LiveActivityManager.shared.cancel(threadId: threadId)
                }
                Haptics.error()
                onTurnEnded?()
            }
        } catch {
            if !wasBusy {
                phase = .failed(error.localizedDescription)
                await LiveActivityManager.shared.cancel(threadId: threadId)
            }
            Haptics.error()
        }
    }

    func stop() async {
        Haptics.firm()
        followTask?.cancel()
        followTask = nil
        try? await service.stop(projectId: projectId, threadId: threadId)
        if var message = live {
            message.streaming = false
            message.parts.append(.notice(id: "stopped", text: "You stopped the agent.", isError: false))
            commit(message)
        }
        live = nil
        phase = .idle
        await LiveActivityManager.shared.cancel(threadId: threadId)
        onTurnEnded?()
    }

    func dismissFailure() {
        if case .failed = phase { phase = .idle }
    }

    func answer(question: ToolCall, selectedIds: [String], selectedLabels: [String], text: String?) async {
        do {
            try await service.answerQuestion(projectId: projectId, toolCallId: question.id, selectedIds: selectedIds, selectedLabels: selectedLabels, text: text, dismissed: false)
            Haptics.success()
        } catch {
            ToastCenter.shared.error(error)
        }
    }

    // MARK: Following a turn

    private func follow(turnId: String?, startedAt: Date?) {
        followTask?.cancel()
        turnStartedAt = startedAt ?? Date()
        if phase != .starting { phase = .streaming }
        followTask = Task { [weak self] in
            await self?.runFollow(turnId: turnId)
        }
    }

    private func runFollow(turnId: String?) async {
        var turnId = turnId
        var attempts = 0
        var assembler = MessageAssembler(messageId: turnId.map { "turn-\($0)" } ?? "turn-live")

        while !Task.isCancelled {
            // A reattach replays the turn from its first event, so each pass
            // rebuilds the message from scratch.
            assembler = MessageAssembler(messageId: turnId.map { "turn-\($0)" } ?? "turn-live")
            var sawAnything = false
            var dirty = false
            var lastPublish = Date.distantPast
            do {
                for try await chunk in service.followTurn(projectId: projectId, threadId: threadId, turnId: turnId) {
                    if Task.isCancelled { return }
                    sawAnything = true
                    assembler.apply(chunk)
                    report(chunk, assembler: assembler)
                    dirty = true
                    // Publish at most ~20 times a second: a replay arrives in one burst.
                    if Date().timeIntervalSince(lastPublish) > 0.05 {
                        publish(assembler)
                        lastPublish = Date()
                        dirty = false
                    }
                }
            } catch {
                if Task.isCancelled { return }
            }
            if Task.isCancelled { return }
            if dirty { publish(assembler) }
            if assembler.finished { break }

            // The stream ended without a finish: the connection dropped, the
            // route hit its time limit, or there was nothing to follow yet.
            attempts += 1
            let status = try? await service.turnStatus(projectId: projectId, threadId: threadId)
            if let status, status.active, !(status.endedNormally && sawAnything == false && attempts > 3) {
                if let current = status.turnId { turnId = current }
                try? await Task.sleep(nanoseconds: UInt64(min(4.0, 0.6 * Double(attempts)) * 1_000_000_000))
                continue
            }
            if status == nil, attempts < 6 {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                continue
            }
            break
        }
        await finishFollow(assembler)
    }

    private func publish(_ assembler: MessageAssembler) {
        if phase == .starting { phase = .streaming }
        if assembler.message.parts.isEmpty { return }
        live = assembler.message
        if let usage = assembler.usage { self.usage = usage }
    }

    private func report(_ chunk: StreamChunk, assembler: MessageAssembler) {
        switch chunk.type {
        case "tool-input-available":
            guard let name = chunk.payload["toolName"]?.stringValue, name != "endTurn",
                  let id = chunk.payload["toolCallId"]?.stringValue, id != lastReportedTool else { return }
            lastReportedTool = id
            let call = ToolCall(id: id, name: name, input: chunk.payload["input"] ?? .null, state: .running)
            LiveActivityManager.shared.step(
                threadId: threadId,
                toolName: name,
                detail: ToolSummary.detail(for: call),
                steps: assembler.message.toolCalls.count
            )
        case "text-start":
            LiveActivityManager.shared.writing(threadId: threadId)
        default:
            break
        }
    }

    private func finishFollow(_ assembler: MessageAssembler) async {
        var assembler = assembler
        assembler.finish()
        let failed = assembler.errorText != nil
        let needsInput = assembler.message.toolCalls.contains { $0.name == "ask_question" && $0.output == nil && $0.errorText == nil } && !assembler.sawEndTurn
        if !assembler.message.parts.isEmpty { commit(assembler.message) }
        live = nil
        followTask = nil
        phase = .idle
        lastReportedTool = nil

        let summary = Self.summary(of: assembler.message)
        await LiveActivityManager.shared.finish(threadId: threadId, failed: failed, summary: summary)
        PushManager.shared.notifyTurnEnded(
            projectId: projectId,
            projectName: projectName,
            threadId: threadId,
            threadTitle: threadTitle,
            outcome: failed ? .error : needsInput ? .needsInput : .idle,
            summary: summary
        )
        failed ? Haptics.warning() : Haptics.success()

        // The server saved the same turn under the same id; take its copy.
        if let history = try? await service.history(projectId: projectId, threadId: threadId), !history.messages.isEmpty {
            messages = history.messages
        }
        await service.markViewed(projectId: projectId, threadId: threadId)
        onTurnEnded?()
    }

    private func commit(_ message: ChatMessage) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
        } else {
            messages.append(message)
        }
    }

    /// The first sentence or two of the agent's closing text.
    nonisolated static func summary(of message: ChatMessage) -> String {
        let texts = message.parts.compactMap { part -> String? in
            if case .text(_, let text) = part, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
            return nil
        }
        guard let last = texts.last else {
            if let error = message.parts.compactMap({ part -> String? in
                if case .notice(_, let text, true) = part { return text }
                return nil
            }).last { return error }
            return "Open Botflow to see what changed."
        }
        let plain = last
            .replacingOccurrences(of: #"[*_`#>]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return plain.count > 160 ? String(plain.prefix(157)) + "…" : plain
    }
}

/// One-line descriptions of tool calls, shared by the chat rows, the Live
/// Activity and notifications.
enum ToolSummary {
    static func detail(for call: ToolCall) -> String {
        let input = call.input
        func string(_ keys: String...) -> String? {
            for key in keys {
                if let value = input[key]?.stringValue, !value.isEmpty { return value }
            }
            return nil
        }
        if let path = string("file_path", "filePath", "path", "notebook_path") {
            return shortPath(path)
        }
        if let command = string("command", "cmd") {
            return firstLine(command, limit: 60)
        }
        if let pattern = string("pattern", "query", "regex") { return "“\(firstLine(pattern, limit: 40))”" }
        if let url = string("url") { return URL(string: url)?.host ?? url }
        if let description = string("description", "prompt", "title") { return firstLine(description, limit: 60) }
        if call.name == "ask_question", let question = AgentQuestion.parse(input).first?.question { return firstLine(question, limit: 60) }
        return ""
    }

    static func shortPath(_ path: String) -> String {
        let trimmed = path.replacingOccurrences(of: "/vercel/sandbox/", with: "")
        let parts = trimmed.split(separator: "/")
        return parts.count > 3 ? "…/" + parts.suffix(2).joined(separator: "/") : trimmed
    }

    static func firstLine(_ text: String, limit: Int) -> String {
        let line = text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? text
        return line.count > limit ? String(line.prefix(limit - 1)) + "…" : line
    }
}
