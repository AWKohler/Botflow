import Foundation
import SwiftUI

/// Every agent across the account that is running, waiting on you, failed or
/// finished unread. Feeds the Agents tab and its badge.
@MainActor
final class AgentsHub: ObservableObject {
    @Published private(set) var agents: [AgentActivity] = []
    @Published private(set) var loaded = false
    @Published private(set) var error: String?

    private let service: BotflowService
    private var task: Task<Void, Never>?

    init(service: BotflowService = Services.shared) {
        self.service = service
    }

    var running: [AgentActivity] { agents.filter { $0.thread.status == .running } }
    var needsInput: [AgentActivity] { agents.filter { $0.thread.status == .needsInput } }
    var failed: [AgentActivity] { agents.filter { $0.thread.status == .error } }
    var finished: [AgentActivity] { agents.filter { $0.thread.status == .idle && $0.thread.unread } }

    /// What deserves the badge: agents blocked on you, or stopped.
    var attentionCount: Int { needsInput.count + failed.count }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                let busy = await (self?.running.isEmpty == false)
                try? await Task.sleep(nanoseconds: busy ? 5_000_000_000 : 15_000_000_000)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    func refresh() async {
        do {
            let list = try await service.activeAgents()
            let sorted = list.sorted { a, b in
                (a.thread.updatedAt ?? .distantPast) > (b.thread.updatedAt ?? .distantPast)
            }
            withAnimation(.snappy(duration: 0.3)) { agents = sorted }
            error = nil
        } catch let failure {
            if !loaded { error = failure.localizedDescription }
        }
        loaded = true
    }
}
