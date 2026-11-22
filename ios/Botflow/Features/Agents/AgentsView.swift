import SwiftUI

/// Mission control: every agent that is working, waiting on you or just
/// finished, across all projects.
struct AgentsView: View {
    @EnvironmentObject private var hub: AgentsHub
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var session: AppSession

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.xxl) {
                summary
                if !hub.loaded {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else if hub.agents.isEmpty {
                    EmptyState(
                        symbol: "bolt",
                        title: "No agents at work",
                        message: "Agents you start show up here while they run, and stay until you've read what they did.",
                        actionTitle: "Start building",
                        action: { router.tab = .build }
                    )
                    .padding(.top, 40)
                } else {
                    section("Needs you", hub.needsInput + hub.failed)
                    section("Working", hub.running)
                    section("Finished", hub.finished)
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .sandCanvas()
        .navigationTitle("Agents")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { AccountButton() } }
        .refreshable { await hub.refresh() }
    }

    private var summary: some View {
        HStack(spacing: Space.m) {
            stat(hub.running.count, "Working", .accent)
            stat(hub.needsInput.count + hub.failed.count, "Need you", .warning)
            stat(hub.finished.count, "Finished", .success)
        }
        .padding(.top, Space.s)
    }

    private func stat(_ count: Int, _ label: String, _ tone: Tone) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(count)")
                .font(.serif(38, relativeTo: .largeTitle))
                .foregroundStyle(count > 0 ? tone.foreground : Sand.subtle)
                .contentTransition(.numericText())
            Text(label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Sand.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .sandCard(radius: 16)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func section(_ title: String, _ items: [AgentActivity]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Space.m) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Sand.subtle)
                    .textCase(.uppercase)
                    .kerning(0.4)
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, agent in
                        Button {
                            Haptics.tap()
                            router.openProject(id: agent.projectId, threadId: agent.thread.id, session: session)
                        } label: {
                            AgentRow(agent: agent)
                        }
                        .buttonStyle(PressableStyle(scale: 0.99))
                        if index < items.count - 1 {
                            Divider().overlay(Sand.border).padding(.leading, 52)
                        }
                    }
                }
                .sandCard()
            }
        }
    }
}

struct AgentRow: View {
    var agent: AgentActivity

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            StatusDot(status: agent.thread.status, unread: agent.thread.unread, size: 10)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(agent.thread.displayTitle)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Sand.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    Image(systemName: ProjectPlatform(raw: agent.platform).symbol)
                        .imageScale(.small)
                    Text(agent.projectName)
                    Text("·")
                    Text(ModelCatalog.name(agent.thread.model))
                }
                .font(.footnote)
                .foregroundStyle(Sand.subtle)
                .lineLimit(1)
                if agent.thread.status != .idle {
                    Badge(text: detail, tone: agent.thread.status.tone)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: Space.s)
            Text(RelativeTime.short(agent.thread.updatedAt))
                .font(.footnote)
                .foregroundStyle(Sand.subtle)
                .monospacedDigit()
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    private var detail: String {
        switch agent.thread.status {
        case .running: return agent.thread.queued > 0 ? "Working · \(agent.thread.queued) queued" : "Working"
        case .needsInput: return "Waiting for your answer"
        case .error: return "Stopped with an error"
        case .idle: return "Finished"
        }
    }
}
