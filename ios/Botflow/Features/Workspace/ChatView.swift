import PhotosUI
import SwiftUI

/// One conversation with an agent: the transcript, what it is doing right now,
/// and the composer.
struct ChatView: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject var session: ThreadSession
    @EnvironmentObject private var account: AppSession
    @EnvironmentObject private var router: Router

    @State private var inspected: ToolCall?
    @State private var showModels = false
    @State private var atBottom = true
    @State private var position = ScrollPosition(edge: .bottom)

    var body: some View {
        let messages = session.allMessages
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if let error = session.loadError, messages.isEmpty {
                    ErrorBanner(message: error) {
                        Task { await session.load(isRunning: false, liveTurnId: nil) }
                    }
                }
                if session.phase == .loading {
                    ProgressView().frame(maxWidth: .infinity).containerRelativeFrame(.vertical) { height, _ in height * 0.7 }
                } else if messages.isEmpty, !session.phase.isBusy {
                    ChatEmptyState(project: store.project)
                }
                ForEach(messages) { message in
                    MessageView(
                        message: message,
                        author: message.userId.flatMap { store.people[$0] },
                        showAuthor: store.people.count > 1 && message.userId != store.me,
                        onAnswer: { call, ids, labels, text in
                            Task { await session.answer(question: call, selectedIds: ids, selectedLabels: labels, text: text) }
                        },
                        onInspect: { inspected = $0 }
                    )
                    .id(message.id)
                }
                if session.phase == .starting || (session.phase == .streaming && session.live == nil) {
                    StartingIndicator(label: session.phase == .starting ? "Starting the agent" : "Working")
                        .transition(.opacity)
                }
                if case .failed(let reason) = session.phase {
                    ErrorBanner(message: reason) { session.dismissFailure() }
                }
                Color.clear.frame(height: 1).id("bottom")
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.l)
            .padding(.bottom, Space.m)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .scrollPosition($position)
        .scrollDismissesKeyboard(.interactively)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 120
        } action: { _, value in
            atBottom = value
        }
        .overlay(alignment: .bottomTrailing) {
            if !atBottom {
                Button {
                    withAnimation(.snappy) { position.scrollTo(edge: .bottom) }
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Sand.text)
                        .frame(width: 38, height: 38)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .padding(.trailing, Space.l)
                .padding(.bottom, Space.s)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel("Jump to latest")
            }
        }
        .animation(.snappy(duration: 0.2), value: atBottom)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Composer(store: store, session: session, showModels: $showModels)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
        }
        .background(Sand.canvas)
        .sheet(item: $inspected) { call in
            ToolDetailSheet(call: call)
        }
        .sheet(isPresented: $showModels) {
            ModelPickerSheet(selection: Binding(get: { session.model }, set: { _ in })) { modelId in
                Task { await store.setModel(modelId) }
            }
        }
        .onChange(of: session.allMessages.count) { old, _ in
            guard atBottom || old == 0 else { return }
            scrollToLatest(animated: old != 0)
        }
        .onChange(of: session.pendingQuestion?.id) { _, id in
            if id != nil { scrollToLatest(animated: true) }
        }
    }
}

extension ChatView {
    /// Lazy rows report their height late, so one jump can stop short; a
    /// second pass after layout lands on the true end.
    fileprivate func scrollToLatest(animated: Bool) {
        if animated {
            withAnimation(.snappy) { position.scrollTo(edge: .bottom) }
        } else {
            position.scrollTo(edge: .bottom)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            position.scrollTo(edge: .bottom)
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

struct StartingIndicator: View {
    var label: String

    var body: some View {
        HStack(spacing: Space.s) {
            StatusDot(status: .running, size: 8)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Sand.muted)
                .shimmer()
        }
        .accessibilityElement(children: .combine)
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
            if !store.queue.isEmpty { queueStrip }
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
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .disabled(!model.supportsImages)
                    .accessibilityLabel("Attach images")

                    Button { showModels = true } label: {
                        HStack(spacing: 5) {
                            ProviderMark(provider: model.provider, modelId: model.id, size: 15)
                            Text(model.name).lineLimit(1)
                            Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Sand.subtle)
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(access.runnable ? Sand.muted : Sand.warning)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 36)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Model: \(model.name)")

                    Spacer(minLength: 0)

                    if busy && draft.isEmpty && attachments.isEmpty {
                        Button {
                            Task { await session.stop() }
                        } label: {
                            Image(systemName: "stop.fill")
                        }
                        .buttonStyle(CircleIconButtonStyle(diameter: 38, filled: true))
                        .accessibilityLabel("Stop the agent")
                        .accessibilityIdentifier("composer.stop")
                        .transition(.scale.combined(with: .opacity))
                    } else {
                        Button(action: send) {
                            Image(systemName: busy ? "text.line.last.and.arrowtriangle.forward" : "arrow.up")
                        }
                        .buttonStyle(CircleIconButtonStyle(diameter: 38, filled: true))
                        .disabled(!canSend)
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
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(focused ? Sand.borderStrong : Sand.border, lineWidth: 1))
            .shadow(color: Sand.shadow.opacity(0.08), radius: 18, y: 6)
        }
        .padding(.horizontal, Space.m)
        .padding(.top, Space.s)
        .padding(.bottom, Space.s)
        .background {
            LinearGradient(colors: [Sand.canvas.opacity(0), Sand.canvas], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.35))
                .ignoresSafeArea()
        }
        .animation(.snappy(duration: 0.22), value: busy)
        .animation(.snappy(duration: 0.22), value: attachments)
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            let picked = items
            pickerItems = []
            Task { await addImages(picked) }
        }
    }

    private var footer: some View {
        let limit = access.source == .planCredits || access.source == nil ? model.contextTokens : (model.personalContextTokens ?? model.contextTokens)
        let used = session.usage?.tokens ?? 0
        return HStack(spacing: Space.m) {
            if !access.runnable {
                Button {
                    router.sheet = model.provider == .anthropic && account.tier == .free ? .settings : .paywall(reason: access.title)
                } label: {
                    Label(access.title, systemImage: "lock.fill")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Sand.warning)
                }
                .buttonStyle(.plain)
            } else {
                Meter(fraction: Double(used) / Double(max(1, limit)), tint: used > limit * 9 / 10 ? Sand.dangerSolid : Sand.muted, height: 3)
                    .frame(width: 44)
                Text(session.usage?.compacting == true ? "Compacting…" : "Context \(AIModel.compact(used)) / \(AIModel.compact(limit))")
                    .monospacedDigit()
            }
            Spacer(minLength: 0)
            if access.source == .claudeSubscription, let pct = account.claudePlan?.fiveHour {
                Text("Claude session \(pct)% used")
            } else if access.source == .planCredits, let credits = account.credits {
                Text("Credits \(credits.pct)% used")
            } else if let source = access.source, source != .planCredits {
                Text(access.title)
            }
        }
        .font(.caption)
        .foregroundStyle(Sand.subtle)
        .lineLimit(1)
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
            ForEach(store.queue) { item in
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
                            .frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("Remove queued message")
                }
                .padding(.leading, Space.m)
                .padding(.trailing, 4)
                .padding(.vertical, 4)
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
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { continue }
            // The server accepts JPEG, PNG and WebP up to 5 MB; scale and re-encode.
            let maxSide: CGFloat = 1800
            let scale = min(1, maxSide / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let resized = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = resized.jpegData(compressionQuality: 0.82) else { continue }
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
