import SwiftUI

/// Mission control: every agent that is working, waiting on you or just
/// finished, across all projects, with enough on each card to decide whether
/// it needs opening.
struct AgentsView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @EnvironmentObject private var hub: AgentsHub
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var session: AppSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = [GridItem(.adaptive(minimum: 320), spacing: Space.m, alignment: .top)]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xxl) {
                    summary(proxy)
                    if !hub.loaded {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    } else if let error = hub.error, hub.agents.isEmpty {
                        ErrorBanner(message: error) { Task { await hub.refresh() } }
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
                        section("Needs you", "needs", hub.needsInput + hub.failed)
                        section("Working", "working", hub.running)
                        section("Finished", "finished", hub.finished)
                    }
                }
                // The same leading edge as the large title, at every width.
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.xxl)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sandCanvas()
        .navigationTitle("Agents")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { AccountButton() } }
        .refreshable { await hub.refresh() }
    }

    private func summary(_ proxy: ScrollViewProxy) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: Space.s)) : AnyLayout(HStackLayout(spacing: Space.m))
        return layout {
            stat(hub.needsInput.count + hub.failed.count, "Need you", .warning, target: "needs", proxy)
            stat(hub.running.count, "Working", .accent, target: "working", proxy)
            stat(hub.finished.count, "Finished", .success, target: "finished", proxy)
        }
        .frame(maxWidth: 640)
        .padding(.top, Space.s)
    }

    /// A count that is also a way to its section.
    private func stat(_ count: Int, _ label: String, _ tone: Tone, target: String, _ proxy: ScrollViewProxy) -> some View {
        Button {
            guard count > 0 else { return }
            Haptics.select()
            withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo(target, anchor: .top) }
        } label: {
            Group {
                if typeSize.isAccessibilitySize {
                    // One per line, number beside its label, so neither is cut short.
                    HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                        Text("\(count)")
                            .font(.serif(30, relativeTo: .title))
                            .foregroundStyle(count > 0 ? tone.foreground : Sand.subtle)
                        Text(label).font(.body.weight(.medium)).foregroundStyle(Sand.muted)
                        Spacer(minLength: 0)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(count)")
                            .font(.serif(38, relativeTo: .largeTitle))
                            .foregroundStyle(count > 0 ? tone.foreground : Sand.subtle)
                            .contentTransition(.numericText())
                        Text(label)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Sand.muted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
            .sandCard(radius: 16)
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("\(count) \(label.lowercased())")
        .accessibilityHint(count > 0 ? "Jumps to that section" : "")
    }

    @ViewBuilder
    private func section(_ title: String, _ id: String, _ items: [AgentActivity]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Space.m) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Sand.subtle)
                    .textCase(.uppercase)
                    .kerning(0.4)
                    .accessibilityAddTraits(.isHeader)
                LazyVGrid(columns: columns, alignment: .leading, spacing: Space.m) {
                    ForEach(items) { agent in
                        card(agent)
                    }
                }
            }
            .id(id)
        }
    }

    private func card(_ agent: AgentActivity) -> some View {
        Button {
            Haptics.tap()
            router.openProject(id: agent.projectId, threadId: agent.thread.id, session: session)
        } label: {
            AgentCard(agent: agent)
        }
        .buttonStyle(PressableStyle(scale: 0.99))
        .contextMenu {
            Button {
                router.openProject(id: agent.projectId, threadId: agent.thread.id, session: session)
            } label: { Label(agent.thread.status == .needsInput ? "Answer" : "Open", systemImage: "arrow.up.forward.app") }
            if agent.thread.status == .running {
                Button(role: .destructive) { stop(agent) } label: { Label("Stop agent", systemImage: "stop.fill") }
            }
        }
        .accessibilityAction(named: agent.thread.status == .running ? "Stop agent" : "Open") {
            if agent.thread.status == .running { stop(agent) } else {
                router.openProject(id: agent.projectId, threadId: agent.thread.id, session: session)
            }
        }
    }

    private func stop(_ agent: AgentActivity) {
        Haptics.firm()
        Task {
            do {
                try await session.service.stop(projectId: agent.projectId, threadId: agent.thread.id)
                ToastCenter.shared.show("Stopped “\(agent.thread.displayTitle)”", symbol: "stop.circle.fill", tone: .neutral)
                await hub.refresh()
            } catch {
                ToastCenter.shared.error(error)
            }
        }
    }
}

/// One agent: what it was asked, where, and the one line that says what is
/// happening with it now.
struct AgentCard: View {
    var agent: AgentActivity
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .top, spacing: Space.s) {
                StatusDot(status: agent.thread.status, unread: agent.thread.unread, size: 10)
                    .padding(.top, 1)
                Text(agent.thread.displayTitle)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Sand.text)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: Space.s)
                Text(RelativeTime.short(agent.thread.updatedAt))
                    .font(.footnote)
                    .foregroundStyle(Sand.subtle)
                    .monospacedDigit()
            }
            now
                .padding(.leading, 28)
            HStack(spacing: 6) {
                Image(systemName: ProjectPlatform(raw: agent.platform).symbol).imageScale(.small)
                Text(agent.projectName).lineLimit(1)
                Text("·")
                Text(ModelCatalog.name(agent.thread.model)).lineLimit(1).layoutPriority(-1)
            }
            .font(.footnote)
            .foregroundStyle(Sand.subtle)
            .padding(.leading, 28)
        }
        .padding(Space.l)
        // Cards in a row share the height of the tallest.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .sandCard()
        .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// The line that answers "what is it doing?" or "what does it want?".
    @ViewBuilder
    private var now: some View {
        switch agent.thread.status {
        case .running:
            HStack(spacing: 6) {
                if let step = agent.currentStep {
                    let info = ToolPresentation.info(for: step.tool)
                    Image(systemName: info.symbol).font(.footnote)
                    Text(info.verb).fontWeight(.medium)
                    if !step.detail.isEmpty {
                        Text(ToolSummary.shortPath(step.detail)).codeFont(12.5).foregroundStyle(Sand.subtle).lineLimit(1).truncationMode(.middle)
                    }
                    Text("· \(step.steps) steps").foregroundStyle(Sand.subtle).layoutPriority(-1)
                } else {
                    Text("Working").fontWeight(.medium)
                }
                if agent.thread.queued > 0 { Text("· \(agent.thread.queued) queued").foregroundStyle(Sand.subtle) }
            }
            .font(.subheadline)
            .foregroundStyle(Sand.accent)
            .lineLimit(1)
        case .needsInput:
            VStack(alignment: .leading, spacing: 6) {
                Text(agent.question ?? "Waiting for your answer")
                    .font(.subheadline)
                    .foregroundStyle(Sand.text)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                Badge(text: "Answer to continue", symbol: "questionmark.bubble", tone: .warning)
            }
        case .error:
            VStack(alignment: .leading, spacing: 6) {
                Text(agent.error ?? "The agent stopped before it finished.")
                    .font(.subheadline)
                    .foregroundStyle(Sand.danger)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                Badge(text: "Stopped with an error", symbol: "exclamationmark.triangle", tone: .danger)
            }
        case .idle:
            Badge(text: "Finished · tap to read", symbol: "checkmark", tone: .success)
        }
    }
}
