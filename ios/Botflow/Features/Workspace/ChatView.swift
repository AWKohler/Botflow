import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// One conversation with an agent: the transcript, what it is doing right now,
/// and the composer.
struct ChatView: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject var session: ThreadSession
    /// One-pane layout: the strip also names the project, since the
    /// navigation bar is taken by the Chat / Preview / Code switch.
    var compact = false
    var onShowThreads: () -> Void = {}
    @EnvironmentObject private var account: AppSession
    @EnvironmentObject private var router: Router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var inspected: ToolCall?
    @State private var showModels = AppConfig.demoRoute == "workspace-models"
    @State private var atBottom = true
    /// Whether the transcript keeps up with a reply as it grows. Only the
    /// person's own scrolling turns it off.
    @State private var following = true
    /// A waiting question is held with its heading at the top, through every
    /// change in layout, until the person scrolls it themselves.
    @State private var holdingQuestion = true
    /// Where the waiting question's card starts in the transcript, and how
    /// much of the scroll view the bars above it cover.
    @State private var questionTop: CGFloat?
    @State private var topInset: CGFloat = 0
    /// Where the transcript ends, and how much of it fits between the bars:
    /// together they say how much empty room to leave under a short
    /// conversation so its question can still be brought to the top.
    @State private var transcriptEnd: CGFloat = 0
    @State private var visibleHeight: CGFloat = 600
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var position = ScrollPosition()
    /// How many of the latest messages are rendered.
    @State private var shownCount = 60
    /// The full composer, opened by choice while a question is waiting.
    @State private var composerOpen = false

    var body: some View {
        let all = session.allMessages
        // A plain stack, not a lazy one: with rows of very different heights a
        // lazy stack keeps re-estimating its length, which fights a scroll
        // position pinned to the end. Long threads show their latest stretch
        // and load earlier messages on request.
        let hidden = max(0, all.count - shownCount)
        let messages = Array(all.suffix(shownCount))
        let question = session.pendingQuestion
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let error = session.loadError, messages.isEmpty {
                        ErrorBanner(message: error) {
                            Task { await session.load(isRunning: false, liveTurnId: nil) }
                        }
                    }
                    if session.phase == .loading {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 320)
                    } else if messages.isEmpty, !session.phase.isBusy {
                        ChatEmptyState(project: store.project)
                    }
                    if hidden > 0 {
                        Button {
                            shownCount += 60
                        } label: {
                            Label(hidden == 1 ? "Show 1 earlier message" : "Show \(min(hidden, 60)) earlier messages", systemImage: "arrow.up")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Sand.muted)
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(messages) { message in
                        MessageView(
                            message: message,
                            author: message.userId.flatMap { store.people[$0] },
                            showAuthor: store.people.count > 1 && message.userId != store.me,
                            onAnswer: { call, ids, labels, text in
                                await session.answer(question: call, selectedIds: ids, selectedLabels: labels, text: text)
                            },
                            onInspect: { inspected = $0 }
                        )
                        // Rows redraw only when their own message changes, so a
                        // streaming reply does not re-render the whole transcript.
                        .equatable()
                        .id(message.id)
                    }
                    if session.phase == .starting || (session.phase == .streaming && session.live == nil) {
                        StartingIndicator(since: session.phase == .starting ? session.startedSendingAt : nil)
                            .transition(.opacity)
                    }
                    if case .failed(let reason) = session.phase {
                        ErrorBanner(message: reason) { session.dismissFailure() }
                    }
                    // Where the bar under the transcript would crowd the card (a short
                    // screen, the largest text), the way out of it sits under the card.
                    if question != nil, compactPrompt, !composerOpen {
                        Button {
                            withAnimation(reduceMotion ? nil : .snappy) { composerOpen = true }
                        } label: {
                            Label("Write a message instead", systemImage: "square.and.pencil")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Sand.muted)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .background {
                            GeometryReader { proxy in
                                Color.clear.preference(key: TranscriptEndKey.self, value: proxy.frame(in: .named("transcript")).maxY)
                            }
                        }
                    // Room under a short conversation, so the question's card can
                    // reach the top instead of stopping with half a row above it.
                    if question != nil, let questionTop {
                        Color.clear.frame(height: max(0, visibleHeight - 10 - (transcriptEnd + Space.m - questionTop)))
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.top, Space.l)
                .padding(.bottom, Space.m)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .coordinateSpace(.named("transcript"))
                .onPreferenceChange(QuestionTopKey.self) { top in
                    questionTop = top
                }
                .onPreferenceChange(TranscriptEndKey.self) { end in
                    transcriptEnd = end
                }
            }
            .scrollPosition($position)
            // A chat opens at its latest message and stays there as it grows.
            // While a question waits, the system's own re-anchoring is turned
            // to the top instead: on a short screen the card is taller than
            // the view, and anchoring to the end would hide its wording.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(question == nil ? .bottom : .top, for: .sizeChanges)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                Self.isNearEnd(geometry)
            } action: { _, value in
                atBottom = value
            }
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.visibleRect.height - geometry.contentInsets.top - geometry.contentInsets.bottom
            } action: { _, height in
                visibleHeight = height
            }
            // A reply grows without the message count changing; keep its end in view.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentSize.height
            } action: { _, _ in
                if question != nil {
                    if holdingQuestion { showQuestion(animated: false) }
                } else if following {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            // The bars around the transcript settle after the first layout
            // (and change with the keyboard and rotation): hold the question through that too.
            .onScrollGeometryChange(for: CGSize.self) { geometry in
                geometry.containerSize
            } action: { _, _ in
                if question != nil, holdingQuestion { showQuestion(animated: false) }
            }
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentInsets.top
            } action: { _, inset in
                topInset = inset
                if question != nil, holdingQuestion { showQuestion(animated: false) }
            }
            .onChange(of: questionTop) { _, _ in
                if question != nil, holdingQuestion { showQuestion(animated: false) }
            }
            .onScrollPhaseChange { old, new, context in
                if new == .interacting {
                    following = false
                    holdingQuestion = false
                } else if new == .idle, old == .interacting || old == .decelerating {
                    following = Self.isNearEnd(context.geometry)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                // Not while a question waits: the way forward there is to answer it.
                if !atBottom, question == nil {
                    Button {
                        following = true
                        withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Sand.text)
                            .frame(width: 44, height: 44)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .padding(.trailing, Space.l)
                    .padding(.bottom, Space.s)
                    .transition(.scale.combined(with: .opacity))
                    .accessibilityLabel("Jump to latest")
                }
            }
            .motion(.snappy(duration: 0.2), value: atBottom)
            // The chats strip is a bar of the scroll view, so the transcript
            // passes under it with the system's edge blur instead of being cut off.
            .safeAreaInset(edge: .top, spacing: 0) {
                if compact || store.openThreads.count > 1 {
                    ThreadStrip(store: store, showsProject: compact, onShowAll: onShowThreads)
                } else {
                    // No strip to show: still give the navigation bar an even surface to sit on.
                    Color.clear.frame(height: 0).background(Sand.canvas.ignoresSafeArea(edges: .top))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Group {
                    if question != nil, !composerOpen {
                        // The question card has its own answer field; a second
                        // text box under it only competes for the screen.
                        if compactPrompt {
                            Color.clear.frame(height: 0)
                        } else {
                            AnswerPrompt { withAnimation(reduceMotion ? nil : .snappy) { composerOpen = true } }
                        }
                    } else {
                        Composer(store: store, session: session, showModels: $showModels)
                    }
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: session.allMessages.count) { old, _ in
                if let question {
                    reveal(question, with: proxy, animated: old != 0)
                } else {
                    // Opening a chat, or sending into it, always lands on the latest.
                    if old == 0 || session.allMessages.last?.role == .user { following = true }
                    if following { scrollToLatest(with: proxy, animated: old != 0) }
                }
            }
            .onChange(of: question?.id) { _, id in
                composerOpen = false
                holdingQuestion = true
                if let question, id != nil {
                    reveal(question, with: proxy, animated: true)
                } else {
                    following = true
                    scrollToLatest(with: proxy, animated: true)
                }
            }
            .onAppear {
                if let question { reveal(question, with: proxy, animated: false) }
            }
        }
        .background(Sand.canvas)
        .sheet(item: $inspected) { call in
            ToolDetailSheet(call: call).tint(Sand.text)
        }
        .sheet(isPresented: $showModels) {
            ModelPickerSheet(selection: Binding(get: { session.model }, set: { _ in })) { modelId in
                Task { await store.setModel(modelId) }
            }
            .tint(Sand.text)
        }
    }
}

extension ChatView {
    /// No bar under the transcript while a question waits: the screen is
    /// short, or the text is at one of the largest sizes.
    fileprivate var compactPrompt: Bool { typeSize.isAccessibilitySize || visibleHeight < 520 }

    /// Within a couple of lines of the end of the transcript, allowing for
    /// the composer that covers the bottom of the scroll view.
    fileprivate static func isNearEnd(_ geometry: ScrollGeometry) -> Bool {
        // The visible rect is the whole scroll view; the bars over it are in the insets.
        let visibleEnd = geometry.visibleRect.maxY - geometry.contentInsets.bottom
        return visibleEnd >= geometry.contentSize.height - 80
    }

    fileprivate func scrollToLatest(with proxy: ScrollViewProxy, animated: Bool) {
        // After layout, so the new rows have their height.
        DispatchQueue.main.async {
            if animated, !reduceMotion {
                withMotion(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
            } else {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    /// Bring a waiting question to the top of the screen, so its wording is
    /// read before its options.
    fileprivate func reveal(_ question: ToolCall, with proxy: ScrollViewProxy, animated: Bool) {
        // After layout, so the card has reported where it is.
        DispatchQueue.main.async { showQuestion(animated: animated) }
    }

    /// Scroll so the card's heading sits just under the bars. The card says
    /// where it starts; nothing is looked up by name, so this holds on every
    /// layout, including screens shorter than the card.
    fileprivate func showQuestion(animated: Bool) {
        guard let questionTop else { return }
        // (`scrollTo(y:)` measures from under the bars, so they are not subtracted here.)
        let offset = max(0, questionTop - 10)
        if animated, !reduceMotion {
            withAnimation(.snappy) { position.scrollTo(y: offset) }
        } else {
            position.scrollTo(y: offset)
        }
    }
}

/// Shown in place of the composer while the agent waits on a question.
struct AnswerPrompt: View {
    var onMessage: () -> Void

    var body: some View {
        HStack(spacing: Space.m) {
            Image(systemName: "questionmark.bubble.fill").foregroundStyle(Sand.warningSolid)
            Text("Answer above to continue")
                .font(.subheadline)
                .foregroundStyle(Sand.muted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.s)
            Button("Message", action: onMessage)
                .buttonStyle(RaisedButtonStyle(size: .small))
                .fixedSize()
                .accessibilityLabel("Write a message instead")
        }
        .padding(.leading, Space.l)
        .padding(.trailing, Space.s)
        .padding(.vertical, Space.s)
        .background(Sand.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Sand.border, lineWidth: 1))
        .shadow(color: Sand.shadow.opacity(0.08), radius: 14, y: 5)
        .padding(.horizontal, Space.m)
        .padding(.vertical, Space.s)
        // The same fade the composer sits on, so a card scrolling
        // underneath does not show through.
        .frame(maxWidth: .infinity)
        .background {
            LinearGradient(colors: [Sand.canvas.opacity(0), Sand.canvas], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.4))
                .ignoresSafeArea()
        }
    }
}

struct ChatEmptyState: View {
    var project: Project

    var body: some View {
        VStack(spacing: Space.m) {
            BotflowGlyph(color: Sand.borderStrong).frame(width: 44)
            Text("What should we build?")
                .font(.serif(30, relativeTo: .title))
                .foregroundStyle(Sand.text)
            Text(project.isSwift
                 ? "Describe a screen or a feature. The agent writes the Swift, builds it and runs it in the simulator."
                 : "Describe a page or a feature. The agent writes the code and shows it running in the preview.")
                .font(.subheadline)
                .foregroundStyle(Sand.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 90)
    }
}

/// "The agent is on its way." A cold sandbox can take half a minute to wake,
/// so the wording changes as the wait goes on instead of looking stuck.
struct StartingIndicator: View {
    /// When the prompt was sent; nil once the agent is running.
    var since: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { context in
            HStack(spacing: Space.s) {
                StatusDot(status: .running, size: 8)
                Text(label(at: context.date))
                    .font(.subheadline)
                    .foregroundStyle(Sand.muted)
                    .contentTransition(.opacity)
                    .shimmer()
            }
            .motion(.easeInOut(duration: 0.3), value: label(at: context.date))
        }
        .accessibilityElement(children: .combine)
    }

    private func label(at date: Date) -> String {
        guard let since else { return "Working" }
        let waited = date.timeIntervalSince(since)
        if waited < 6 { return "Starting the agent" }
        if waited < 25 { return "Waking the sandbox" }
        return "Almost ready. The first start takes the longest"
    }
}

// MARK: - Composer

struct Composer: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject var session: ThreadSession
    @Binding var showModels: Bool
    @EnvironmentObject private var account: AppSession
    @EnvironmentObject private var router: Router

    @State private var draft = ""
    @State private var attachments: [PendingAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var dropTargeted = false
    @State private var composerWidth: CGFloat = 360
    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var focused: Bool

    struct PendingAttachment: Identifiable, Equatable {
        let id = UUID()
        var thumbnail: UIImage
        var uploaded: ImageAttachment?
        var failed = false
    }

    private var model: AIModel { ModelCatalog.model(session.model) }
    private var access: ModelAccess { account.access(for: model) }
    private var busy: Bool { session.phase.isBusy }
    private var uploading: Bool { attachments.contains { $0.uploaded == nil && !$0.failed } }
    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachments.contains { $0.uploaded != nil }) && !uploading
    }

    var body: some View {
        VStack(spacing: Space.s) {
            if !visibleQueue.isEmpty { queueStrip }
            VStack(alignment: .leading, spacing: 0) {
                if !attachments.isEmpty { attachmentRow }
                TextField(busy ? "Queue a follow-up…" : "Ask Botflow…", text: $draft, axis: .vertical)
                    .lineLimit(1...7)
                    .font(.body)
                    .foregroundStyle(Sand.text)
                    .focused($focused)
                    .padding(.horizontal, Space.l)
                    .padding(.top, 14)
                    .padding(.bottom, 6)
                    .accessibilityIdentifier("composer.input")

                HStack(spacing: Space.s) {
                    PhotosPicker(selection: $pickerItems, maxSelectionCount: 4, matching: .images) {
                        Image(systemName: "photo.badge.plus")
                            .font(.body)
                            .foregroundStyle(model.supportsImages ? Sand.muted : Sand.borderStrong)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .disabled(!model.supportsImages)
                    .accessibilityLabel("Attach images")

                    Button { showModels = true } label: {
                        HStack(spacing: 5) {
                            ProviderMark(provider: model.provider, modelId: model.id, size: 15)
                            // In a narrow column the vendor's mark stands in for its name.
                            Text(composerWidth < 330 || typeSize.isAccessibilitySize ? model.shortName : model.name).lineLimit(1)
                            Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Sand.subtle)
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(access.runnable ? Sand.muted : Sand.warning)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .accessibilityLabel("Model: \(model.name)")

                    Spacer(minLength: 0)

                    if busy && draft.isEmpty && attachments.isEmpty {
                        Button {
                            Task { await session.stop() }
                        } label: {
                            Image(systemName: "stop.fill")
                        }
                        .buttonStyle(CircleIconButtonStyle(diameter: 38, filled: true))
                        .keyboardShortcut(".", modifiers: .command)
                        .accessibilityLabel("Stop the agent")
                        .accessibilityIdentifier("composer.stop")
                        .transition(.scale.combined(with: .opacity))
                    } else {
                        Button(action: send) {
                            Image(systemName: busy ? "text.line.last.and.arrowtriangle.forward" : "arrow.up")
                        }
                        .buttonStyle(CircleIconButtonStyle(diameter: 38, filled: true))
                        .disabled(!canSend)
                        .keyboardShortcut(.return, modifiers: .command)
                        .accessibilityLabel(busy ? "Queue message" : "Send")
                        .accessibilityIdentifier("composer.send")
                        .transition(.scale.combined(with: .opacity))
                    }
                }
                .padding(.horizontal, Space.s)
                .padding(.bottom, Space.s)

                footer
            }
            .background(Sand.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(dropTargeted ? Sand.accent : focused ? Sand.borderStrong : Sand.border, lineWidth: dropTargeted ? 2 : 1))
            .shadow(color: Sand.shadow.opacity(0.08), radius: 18, y: 6)
            .onDrop(of: [.image], isTargeted: $dropTargeted) { providers in
                guard model.supportsImages else { return false }
                for provider in providers.prefix(4) {
                    _ = provider.loadDataRepresentation(for: .image) { data, _ in
                        guard let data else { return }
                        Task { @MainActor in await addImage(data) }
                    }
                }
                return true
            }
        }
        .padding(.horizontal, Space.m)
        .padding(.top, Space.s)
        .padding(.bottom, Space.s)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { composerWidth = $0 }
        .background {
            LinearGradient(colors: [Sand.canvas.opacity(0), Sand.canvas], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.35))
                .ignoresSafeArea()
        }
        .motion(.snappy(duration: 0.22), value: busy)
        .motion(.snappy(duration: 0.22), value: attachments)
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            let picked = items
            pickerItems = []
            Task { await addImages(picked) }
        }
    }

    /// Waiting messages, minus the one already shown as the bubble being started.
    private var visibleQueue: [QueueItem] {
        store.queue.filter { item in
            !(session.startingText != nil && item.status != "failed" && item.text == session.startingText)
        }
    }

    private var footer: some View {
        let limit = model.contextLimit(personal: access.usesOwnAccount)
        let used = session.usage?.tokens ?? 0
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: Space.m))
        return layout {
            if !access.runnable {
                Button {
                    router.sheet = model.provider == .anthropic && account.tier == .free ? .settings : .paywall(reason: access.title)
                } label: {
                    Label(access.title, systemImage: "lock.fill")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Sand.warning)
                }
                .buttonStyle(.plain)
            } else if session.usage != nil {
                // Shown once the agent has reported a real figure, never a guess.
                Meter(fraction: Double(used) / Double(max(1, limit)), tint: used > limit * 9 / 10 ? Sand.dangerSolid : Sand.muted, height: 3)
                    .frame(width: 44)
                Text(session.usage?.compacting == true ? "Compacting…" : "Context \(AIModel.compact(used)) / \(AIModel.compact(limit))")
                    .monospacedDigit()
                    .accessibilityLabel("Context used: \(AIModel.compact(used)) of \(AIModel.compact(limit)) tokens")
            } else {
                Text("\(AIModel.compact(limit)) context")
            }
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            if access.source == .claudeSubscription, let pct = account.claudePlan?.fiveHour {
                Text("Claude \(pct)% used")
            } else if access.source == .planCredits, let credits = account.credits {
                Text("Credits \(credits.pct)% used")
            } else if let source = access.source, source != .planCredits {
                Text(access.title)
            }
        }
        .font(.caption)
        .foregroundStyle(Sand.subtle)
        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.l)
        .padding(.vertical, 8)
        .overlay(alignment: .top) { Divider().overlay(Sand.border) }
    }

    private var attachmentRow: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Space.s) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: attachment.thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 60, height: 60)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay {
                                if attachment.uploaded == nil {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.black.opacity(0.35))
                                    if attachment.failed {
                                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.white)
                                    } else {
                                        ProgressView().tint(.white)
                                    }
                                }
                            }
                        Button {
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.65))
                                .font(.body)
                        }
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("Remove image")
                    }
                }
            }
            .padding(.horizontal, Space.l)
            .padding(.top, Space.m)
        }
        .scrollIndicators(.hidden)
    }

    private var queueStrip: some View {
        VStack(spacing: 6) {
            ForEach(visibleQueue) { item in
                HStack(spacing: Space.s) {
                    Image(systemName: item.status == "failed" ? "exclamationmark.triangle.fill" : "clock")
                        .font(.footnote)
                        .foregroundStyle(item.status == "failed" ? Sand.danger : Sand.subtle)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.text.isEmpty ? "Image" : item.text)
                            .font(.subheadline)
                            .foregroundStyle(Sand.text)
                            .lineLimit(1)
                        Text(item.error ?? "Queued · sends when the agent finishes")
                            .font(.caption)
                            .foregroundStyle(item.status == "failed" ? Sand.danger : Sand.subtle)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Button {
                        Task { await store.cancelQueued(item) }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Sand.muted)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Remove queued message")
                }
                .padding(.leading, Space.m)
                .background(Sand.elevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
            }
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func send() {
        guard canSend else { return }
        guard access.runnable else {
            Haptics.warning()
            router.sheet = model.provider == .anthropic && account.tier == .free ? .settings : .paywall(reason: access.title)
            return
        }
        let text = draft
        let images = attachments.compactMap(\.uploaded)
        draft = ""
        attachments = []
        Task {
            await PushManager.shared.requestIfNeeded()
            await session.send(text: text, images: images)
            await store.refreshThreads()
        }
    }

    private func addImages(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            await addImage(data)
        }
    }

    private func addImage(_ data: Data) async {
        do {
            guard let image = UIImage(data: data) else { return }
            // The server accepts JPEG, PNG and WebP up to 5 MB; scale and re-encode.
            let maxSide: CGFloat = 1800
            let scale = min(1, maxSide / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let resized = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = resized.jpegData(compressionQuality: 0.82) else { return }
            let pending = PendingAttachment(thumbnail: resized.preparingThumbnail(of: CGSize(width: 180, height: 180)) ?? resized)
            attachments.append(pending)
            do {
                let uploaded = try await store.service.uploadImage(projectId: store.projectId, data: jpeg, mimeType: "image/jpeg")
                if let index = attachments.firstIndex(where: { $0.id == pending.id }) { attachments[index].uploaded = uploaded }
            } catch {
                if let index = attachments.firstIndex(where: { $0.id == pending.id }) { attachments[index].failed = true }
                ToastCenter.shared.error(error)
            }
        }
    }
}
