import ActivityKit
import Foundation

/// Keeps a Live Activity in step with each running agent, so its tool calls
/// show in the Dynamic Island and on the Lock Screen while you are elsewhere.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private struct Tracked {
        var activity: Activity<AgentActivityAttributes>
        var state: AgentActivityAttributes.ContentState
        var lastPush = Date.distantPast
        var pending: Task<Void, Never>?
        /// The step in progress, so it can be recorded as done when the next begins.
        var currentStep: (tool: String, detail: String)?
        var alertOnNextPush = false
    }

    private var tracked: [String: Tracked] = [:]
    private var tokenTasks: [String: Task<Void, Never>] = [:]

    var isAvailable: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    static var isEnabledByUser: Bool {
        get { UserDefaults.standard.object(forKey: "liveActivitiesEnabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "liveActivitiesEnabled") }
    }

    func start(projectId: String, projectName: String, threadId: String, threadTitle: String, modelName: String, startedAt: Date = Date()) {
        guard isAvailable, Self.isEnabledByUser else { return }
        if tracked[threadId] != nil { return }
        // Adopt one that outlived the app process instead of starting a second.
        if let existing = Activity<AgentActivityAttributes>.activities.first(where: { $0.attributes.threadId == threadId && $0.activityState == .active }) {
            tracked[threadId] = Tracked(activity: existing, state: existing.content.state)
            observeToken(existing)
            return
        }
        let attributes = AgentActivityAttributes(projectId: projectId, threadId: threadId, projectName: projectName, threadTitle: threadTitle, modelName: modelName)
        let state = AgentActivityAttributes.ContentState(phase: .starting, action: "Starting", detail: modelName, symbol: "sparkles", steps: 0, recent: [], startedAt: startedAt, endedAt: nil)
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(60 * 30), relevanceScore: 80)
        do {
            let activity: Activity<AgentActivityAttributes>
            do {
                // With a push token the server can keep the island moving after iOS suspends the app.
                activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
            } catch {
                activity = try Activity.request(attributes: attributes, content: content, pushType: nil)
            }
            tracked[threadId] = Tracked(activity: activity, state: state)
            observeToken(activity)
        } catch {
            // Activities are off, or the system's limit is reached. The chat still works without one.
        }
    }

    private func observeToken(_ activity: Activity<AgentActivityAttributes>) {
        let threadId = activity.attributes.threadId
        let projectId = activity.attributes.projectId
        let startedAt = activity.content.state.startedAt
        tokenTasks[threadId]?.cancel()
        tokenTasks[threadId] = Task {
            for await token in activity.pushTokenUpdates {
                let hex = token.map { String(format: "%02x", $0) }.joined()
                await Services.shared.registerLiveActivity(token: hex, projectId: projectId, threadId: threadId, startedAt: startedAt)
            }
        }
    }

    /// Report the agent's latest step. Updates are coalesced to about one a second.
    func step(threadId: String, toolName: String, detail: String, steps: Int) {
        guard var entry = tracked[threadId] else { return }
        let info = ToolPresentation.info(for: toolName)
        var state = entry.state
        let asking = toolName == "ask_question"
        let becameQuestion = asking && state.phase != .needsInput
        if entry.currentStep?.tool != toolName || entry.currentStep?.detail != detail {
            Self.completeCurrentStep(of: entry, into: &state)
        }
        entry.currentStep = (toolName, detail)
        state.phase = asking ? .needsInput : .working
        state.action = info.verb
        state.detail = detail
        state.symbol = info.symbol
        state.steps = steps
        entry.state = state
        // A question brings the island forward and lights the Lock Screen: the agent is stuck until answered.
        if becameQuestion { entry.alertOnNextPush = true }
        tracked[threadId] = entry
        schedule(threadId)
    }

    /// The step that was running is done: it joins the finished ones in the past tense.
    private static func completeCurrentStep(of entry: Tracked, into state: inout AgentActivityAttributes.ContentState) {
        guard let previous = entry.currentStep else { return }
        let done = ToolPresentation.info(for: previous.tool).past
        let line = previous.detail.isEmpty ? done : "\(done) \(previous.detail)"
        if state.recent.last != line { state.recent = Array((state.recent + [line]).suffix(3)) }
    }

    func writing(threadId: String) {
        guard var entry = tracked[threadId], entry.state.phase != .needsInput else { return }
        guard entry.state.action != "Writing a reply" else { return }
        Self.completeCurrentStep(of: entry, into: &entry.state)
        entry.currentStep = nil
        entry.state.phase = .working
        entry.state.action = "Writing a reply"
        entry.state.detail = ""
        entry.state.symbol = "text.bubble"
        tracked[threadId] = entry
        schedule(threadId)
    }

    private func schedule(_ threadId: String) {
        guard var entry = tracked[threadId] else { return }
        let wait = max(0, 1.0 - Date().timeIntervalSince(entry.lastPush))
        entry.pending?.cancel()
        entry.pending = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            await self?.flush(threadId)
        }
        tracked[threadId] = entry
    }

    private func flush(_ threadId: String) async {
        guard var entry = tracked[threadId] else { return }
        entry.lastPush = Date()
        entry.pending = nil
        tracked[threadId] = entry
        var alert: AlertConfiguration?
        if entry.alertOnNextPush {
            alert = AlertConfiguration(
                title: "\(entry.activity.attributes.projectName) needs your answer",
                body: LocalizedStringResource(stringLiteral: entry.state.detail.isEmpty ? "The agent has a question for you." : entry.state.detail),
                sound: .default
            )
            entry.alertOnNextPush = false
            tracked[threadId] = entry
        }
        await entry.activity.update(
            ActivityContent(state: entry.state, staleDate: Date().addingTimeInterval(60 * 30), relevanceScore: entry.state.phase == .needsInput ? 100 : 80),
            alertConfiguration: alert
        )
    }

    /// The turn ended. The activity shows the outcome briefly, then goes away.
    func finish(threadId: String, failed: Bool, summary: String) async {
        guard var entry = tracked.removeValue(forKey: threadId) else { return }
        entry.pending?.cancel()
        tokenTasks.removeValue(forKey: threadId)?.cancel()
        entry.state.phase = failed ? .failed : .done
        entry.state.action = failed ? "Stopped" : "Finished"
        entry.state.detail = summary
        entry.state.symbol = failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
        entry.state.endedAt = Date()
        let content = ActivityContent(state: entry.state, staleDate: nil, relevanceScore: 60)
        await entry.activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(failed ? 60 * 10 : 60 * 2)))
    }

    func cancel(threadId: String) async {
        guard let entry = tracked.removeValue(forKey: threadId) else { return }
        entry.pending?.cancel()
        tokenTasks.removeValue(forKey: threadId)?.cancel()
        await entry.activity.end(nil, dismissalPolicy: .immediate)
    }

    func endAll() async {
        tracked.removeAll()
        tokenTasks.values.forEach { $0.cancel() }
        tokenTasks.removeAll()
        for activity in Activity<AgentActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func isTracking(_ threadId: String) -> Bool { tracked[threadId] != nil }
}
