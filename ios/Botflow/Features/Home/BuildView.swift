import SwiftUI

/// The home screen: describe an app and an agent starts building it.
struct BuildView: View {
    @Environment(\.verticalSizeClass) private var verticalClass
    @State private var composerWidth: CGFloat = 360
    /// How much larger than standard the text is, so the width thresholds keep up.
    @ScaledMetric(relativeTo: .subheadline) private var textScale: CGFloat = 1
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var agents: AgentsHub

    @State private var prompt = ""
    @State private var platform: ProjectPlatform = .web
    @State private var modelId = UserDefaults.standard.string(forKey: "build.model") ?? ModelCatalog.defaultId
    @State private var backend = "none"
    @State private var showModels = false
    @State private var creating = false
    @State private var recent: [Project] = []
    @FocusState private var focused: Bool

    private let ideas: [(String, String)] = [
        ("cup.and.saucer", "A landing page for a neighbourhood coffee shop with a menu and opening hours"),
        ("checklist", "A habit tracker with streaks, reminders and a weekly chart"),
        ("chart.bar", "A dashboard that tracks my freelance invoices and what's overdue"),
        ("figure.hiking", "A trail finder that shows nearby hikes on a map by difficulty"),
    ]

    private var model: AIModel { ModelCatalog.model(modelId) }
    private var access: ModelAccess { session.access(for: model) }
    private var canSend: Bool { !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !creating }

    var body: some View {
        ScrollView {
            VStack(spacing: verticalClass == .compact ? Space.l : Space.xxl) {
                // An agent waiting on an answer is the most pressing thing here.
                if !agents.needsInput.isEmpty { activeStrip.padding(.top, Space.s).padding(.bottom, -Space.m) }
                // A phone on its side has room for the greeting or the prompt
                // field above the tab bar, not both: the field wins.
                if verticalClass != .compact { hero }
                composer
                connections
                if agents.needsInput.isEmpty, !agents.running.isEmpty { activeStrip }
                if !recent.isEmpty { jumpBackIn }
                suggestions
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, 40)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .sandCanvas()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 8) {
                    BotflowGlyph().frame(width: 24)
                    Text("Botflow").font(.headline).foregroundStyle(Sand.text)
                }
                .fixedSize()
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Botflow")
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) { AccountButton() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showModels) {
            ModelPickerSheet(selection: $modelId)
        }
        .onChange(of: modelId) { _, value in UserDefaults.standard.set(value, forKey: "build.model") }
        .task { await loadRecent() }
    }

    private var hero: some View {
        VStack(spacing: Space.s) {
            Text(greeting)
                .font(.serif(40, relativeTo: .largeTitle))
                .foregroundStyle(Sand.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Describe it. An agent builds it, and tells you when it's ready.")
                .font(.callout)
                .foregroundStyle(Sand.muted)
                .multilineTextAlignment(.center)
        }
        .padding(.top, Space.xl)
    }

    private var greeting: String {
        // A real first name only: a handle like "sam_42" reads wrong in a greeting.
        let candidate = session.user?.firstName ?? session.user?.fullName?.split(separator: " ").first.map(String.init)
        if let name = candidate, !name.isEmpty, name.count <= 14, name.allSatisfy({ $0.isLetter || $0 == "-" || $0 == "'" }) {
            return "What will you build, \(name)?"
        }
        return "What will you build?"
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            SegmentedTabs(
                selection: $platform,
                items: [
                    .init(value: .web, title: "Web app", symbol: "globe"),
                    .init(value: .swift, title: "iOS app", symbol: "swift"),
                ]
            )
            .padding(Space.s)

            ZStack(alignment: .topLeading) {
                if prompt.isEmpty {
                    Text(platform == .swift ? "Ask Botflow to create an iOS app that…" : "Ask Botflow to create a web app that…")
                        .foregroundStyle(Sand.subtle)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $prompt)
                    .focused($focused)
                    .scrollContentBackground(.hidden)
                    // Shorter on a phone held sideways, so the whole composer clears the tab bar.
                    .frame(minHeight: verticalClass == .compact ? 44 : 96, maxHeight: verticalClass == .compact ? 120 : 220)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("build.prompt")
            }
            .font(.body)
            .foregroundStyle(Sand.text)
            .padding(.horizontal, Space.m)

            HStack(spacing: Space.s) {
                // Both choices stay in words; what gives way on a narrow screen
                // is the vendor's name, then the chevrons, and only then the label.
                // Chosen from the measured width: a layout that tries each in
                // turn re-measures the buttons endlessly.
                let room = (composerWidth - 2 * Space.m - 42 - Space.s) / textScale
                Group {
                    if room >= 350 {
                        choices(modelName: model.name, chevrons: true, backendWords: true)
                    } else if room >= 306 {
                        choices(modelName: model.shortName, chevrons: true, backendWords: true)
                    } else if room >= 280 {
                        choices(modelName: model.shortName, chevrons: false, backendWords: true)
                    } else {
                        // Too narrow for both on a line (the Duo's cover): one above the other, still in words.
                        VStack(alignment: .leading, spacing: Space.s) {
                            modelChoice(name: model.shortName, chevron: true)
                            backendChoice(words: true, chevron: true)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: create) {
                    if creating {
                        ProgressView().tint(Sand.bg)
                    } else {
                        Image(systemName: "arrow.up")
                    }
                }
                .buttonStyle(CircleIconButtonStyle(diameter: 42, filled: true))
                .disabled(!canSend)
                .accessibilityLabel("Start building")
                .accessibilityIdentifier("build.send")
            }
            .padding(Space.m)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { composerWidth = $0 }
        .background(Sand.elevated.opacity(0.6), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .sandCard(radius: 22)
        .shadow(color: Sand.shadow.opacity(0.06), radius: 22, y: 10)
    }

    private func choices(modelName: String, chevrons: Bool, backendWords: Bool) -> some View {
        HStack(spacing: Space.s) {
            modelChoice(name: modelName, chevron: chevrons)
            backendChoice(words: backendWords, chevron: chevrons || !backendWords)
        }
    }

    private func modelChoice(name: String, chevron: Bool) -> some View {
        Button { showModels = true } label: {
            HStack(spacing: 6) {
                ProviderMark(provider: model.provider, modelId: model.id, size: 16)
                Text(name).lineLimit(1)
                if chevron { Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(Sand.subtle) }
            }
        }
        .buttonStyle(RaisedButtonStyle(size: .small))
        .accessibilityLabel("Model: \(model.name)")
    }

    private func backendChoice(words: Bool, chevron: Bool) -> some View {
        Menu {
            Picker("Backend", selection: $backend) {
                Label("No backend", systemImage: "nosign").tag("none")
                Label("Convex (your account)", systemImage: "cylinder.split.1x2").tag("user")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: backend == "none" ? "cylinder.split.1x2" : "cylinder.split.1x2.fill")
                if words { Text(backend == "none" ? "No backend" : "Convex").lineLimit(1) }
                if chevron { Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(Sand.subtle) }
            }
        }
        .buttonStyle(RaisedButtonStyle(size: .small))
        .accessibilityLabel(backend == "none" ? "Backend: none" : "Backend: Convex")
    }

    @ViewBuilder
    private var connections: some View {
        VStack(spacing: Space.m) {
            if !access.runnable {
                Button {
                    router.sheet = model.provider == .anthropic && session.tier == .free ? .settings : .paywall(reason: access.title)
                } label: {
                    HStack(spacing: Space.s) {
                        Image(systemName: "lock.fill")
                        Text("\(model.name): \(access.title.lowercased()).")
                        Text("Fix").fontWeight(.semibold).underline()
                    }
                    .font(.footnote)
                    .foregroundStyle(Sand.warning)
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, Space.s)
                    .background(Sand.warningSoft, in: Capsule())
                }
                .buttonStyle(.plain)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.s) { connectionChips }
                VStack(spacing: Space.xs) { connectionChips }
            }
        }
    }

    @ViewBuilder
    private var connectionChips: some View {
        ConnectionChip(title: "Claude", connected: session.connections.hasClaudeOAuth == true, provider: .anthropic)
        ConnectionChip(title: "ChatGPT", connected: session.connections.hasCodexOAuth == true, provider: .openai)
    }

    private var activeStrip: some View {
        Button {
            router.tab = .agents
        } label: {
            HStack(spacing: Space.m) {
                StatusDot(status: agents.needsInput.isEmpty ? .running : .needsInput, size: 9)
                VStack(alignment: .leading, spacing: 2) {
                    Text(activeTitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Sand.text)
                    if let first = (agents.needsInput + agents.running).first {
                        Text("\(first.projectName) · \(first.thread.displayTitle)")
                            .font(.footnote)
                            .foregroundStyle(Sand.subtle)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Sand.subtle)
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
            .sandCard(radius: 16)
        }
        .buttonStyle(PressableStyle())
    }

    private var activeTitle: String {
        let waiting = agents.needsInput.count
        let running = agents.running.count
        if waiting > 0 { return waiting == 1 ? "An agent needs your input" : "\(waiting) agents need your input" }
        return running == 1 ? "1 agent is working" : "\(running) agents are working"
    }

    private var jumpBackIn: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack {
                Text("Jump back in")
                    .font(.headline)
                    .foregroundStyle(Sand.text)
                Spacer()
                Button("All projects") { router.tab = .projects }
                    .font(.subheadline)
                    .foregroundStyle(Sand.muted)
            }
            ScrollView(.horizontal) {
                HStack(spacing: Space.m) {
                    ForEach(recent.prefix(6)) { project in
                        Button {
                            Haptics.tap()
                            router.open(WorkspaceRoute(project: project))
                        } label: {
                            VStack(alignment: .leading, spacing: Space.s) {
                                ProjectCover(project: project)
                                    .frame(width: 168, height: 104)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
                                Text(project.name)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Sand.text)
                                    .lineLimit(1)
                                Text("\(project.kind.label) · \(RelativeTime.short(project.lastOpened))")
                                    .font(.caption)
                                    .foregroundStyle(Sand.subtle)
                            }
                            .frame(width: 168, alignment: .leading)
                        }
                        .buttonStyle(PressableStyle())
                    }
                }
                .padding(.horizontal, Space.gutter)
            }
            .scrollIndicators(.hidden)
            // Cards run off the screen's edge, not off the column's.
            .scrollClipDisabled()
            .padding(.horizontal, -Space.gutter)
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Need an idea?")
                .font(.headline)
                .foregroundStyle(Sand.text)
            VStack(spacing: 0) {
                ForEach(Array(ideas.enumerated()), id: \.offset) { index, idea in
                    Button {
                        Haptics.tap()
                        withMotion(.snappy) { prompt = idea.1 }
                        platform = idea.0 == "checklist" || idea.0 == "figure.hiking" ? .swift : .web
                        focused = true
                    } label: {
                        HStack(spacing: Space.m) {
                            Image(systemName: idea.0)
                                .foregroundStyle(Sand.muted)
                                .frame(width: 24)
                            Text(idea.1)
                                .font(.subheadline)
                                .foregroundStyle(Sand.text)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: Space.s)
                            Image(systemName: "arrow.up.left")
                                .font(.footnote)
                                .foregroundStyle(Sand.subtle)
                        }
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, 14)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if index < ideas.count - 1 { Divider().overlay(Sand.border).padding(.leading, 52) }
                }
            }
            .sandCard()
        }
    }

    private func loadRecent() async {
        if let projects = try? await session.service.projects() {
            recent = projects.sorted { ($0.lastOpened ?? .distantPast) > ($1.lastOpened ?? .distantPast) }
        }
    }

    private func create() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard access.runnable else {
            Haptics.warning()
            router.sheet = model.provider == .anthropic && session.tier == .free ? .settings : .paywall(reason: access.title)
            return
        }
        if platform == .swift, session.tier == .free {
            Haptics.warning()
            router.sheet = .paywall(reason: "iOS apps need a Pro or Max plan")
            return
        }
        creating = true
        focused = false
        Task {
            defer { creating = false }
            do {
                let project = try await session.service.createProject(
                    name: String(text.prefix(48)),
                    platform: platform,
                    model: modelId,
                    backend: backend
                )
                Haptics.success()
                await PushManager.shared.requestIfNeeded()
                prompt = ""
                router.open(WorkspaceRoute(project: project, initialPrompt: text))
                await loadRecent()
            } catch let error as APIError where error.isPlanLimit {
                router.sheet = .paywall(reason: error.message)
            } catch {
                ToastCenter.shared.error(error)
            }
        }
    }
}

struct ConnectionChip: View {
    var title: String
    var connected: Bool
    var provider: ModelProvider
    @EnvironmentObject private var router: Router

    var body: some View {
        Button {
            router.sheet = .settings
        } label: {
            HStack(spacing: 6) {
                ProviderMark(provider: provider, size: 15)
                Text(connected ? "\(title) connected" : "Connect \(title)")
                    .lineLimit(1)
                    .fixedSize()
                if connected {
                    Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Sand.success)
                }
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(connected ? Sand.muted : Sand.text)
            .padding(.horizontal, Space.m)
            .frame(minHeight: 34)
            .background(connected ? Color.clear : Sand.card, in: Capsule())
            .overlay(Capsule().strokeBorder(connected ? Color.clear : Sand.border, lineWidth: 1))
            // The pill is 34 points tall; its touch target is 44.
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens connections in Settings")
    }
}
