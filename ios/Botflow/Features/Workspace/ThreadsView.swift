import SwiftUI

/// The project's agents as a strip of tabs: switch between conversations the
/// way you switch browser tabs, with each agent's state on its tab. On a phone
/// it starts with the project's name, which opens the full list of chats.
struct ThreadStrip: View {
    @ObservedObject var store: WorkspaceStore
    var showsProject = false
    var onShowAll: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    /// How wide the row of tabs is, so the open chat's tab can be sized to fit inside it.
    @State private var stripWidth: CGFloat = 240

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                identity
            } else {
                tabs
            }
        }
        // A solid bar with a hairline under it: text scrolling behind tabs
        // that have gaps between them reads as clutter, not as glass.
        // (The fill runs up under the navigation bar too, so that bar sits on
        // one even surface instead of on whatever is scrolling past.)
        .background(Sand.canvas.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { Rectangle().fill(Sand.border.opacity(0.7)).frame(height: 0.5) }
    }

    /// At the largest text sizes a row of tabs is unreadable. Say plainly
    /// which project and chat this is, in full, and open the list of chats
    /// from it.
    private var identity: some View {
        let current = store.openThreads.first { $0.id == store.currentThreadId }
        return Button(action: onShowAll) {
            HStack(alignment: .center, spacing: Space.m) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(store.project.name, systemImage: store.project.kind.symbol)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Sand.muted)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let current, current.status != .idle || current.unread {
                            StatusDot(status: current.status, unread: current.unread, size: 9)
                        }
                        Text(current?.displayTitle ?? "New chat")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Sand.text)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: Space.s)
                Image(systemName: "list.bullet")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Sand.muted)
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.s)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(store.project.name), \(current?.displayTitle ?? "New chat"). All chats")
        .accessibilityIdentifier("workspace.threads")
        // Up to the size the rest of the workspace reads at, not beyond: two
        // lines of title have to leave room for the conversation.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            if showsProject {
                Button(action: onShowAll) {
                    HStack(spacing: 5) {
                        Image(systemName: store.project.kind.symbol)
                            .font(.footnote)
                            .foregroundStyle(Sand.subtle)
                        // No chevron: the name alone leaves room to read it in full.
                        Text(store.project.name)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Sand.text)
                            .lineLimit(1)
                    }
                    .padding(.leading, Space.l)
                    .padding(.trailing, Space.xs)
                    .frame(maxWidth: 176, minHeight: 44, alignment: .leading)
                    .fixedSize(horizontal: true, vertical: false)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .accessibilityLabel("\(store.project.name), all chats")
                .accessibilityIdentifier("workspace.threads")
            }
            ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    HStack(spacing: 2) {
                        ForEach(store.openThreads.prefix(12)) { thread in
                            chip(thread)
                                .id(thread.id)
                                // A tab cut off at the start of the row is hidden outright:
                                // half a title there reads as a broken label. (At the far
                                // end a fading tab is the cue that there are more.)
                                .scrollTransition(.interactive.threshold(.visible(0.98)), axis: .horizontal) { content, phase in
                                    content.opacity(phase == .topLeading ? 0 : 1)
                                }
                        }
                        Button {
                            Haptics.tap()
                            Task { await store.newThread() }
                        } label: {
                            Image(systemName: "plus")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Sand.muted)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .accessibilityLabel("New chat")
                    }
                    // The row always comes to rest on the edge of a tab, never part-way through one.
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
                // Margins, not padding: a tab scrolled to the start stops clear of the fade.
                .contentMargins(.horizontal, 8, for: .scrollContent)
                .scrollIndicators(.hidden)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { stripWidth = $0 }
                .mask {
                    HStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: 8)
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 14)
                    }
                }
                // The chat being read starts the row, so its title is the one shown in full.
                .onChange(of: store.currentThreadId) { _, id in
                    if let id { withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo(id, anchor: .leading) } }
                }
                .onAppear {
                    if let id = store.currentThreadId { proxy.scrollTo(id, anchor: .leading) }
                }
            }
        }
        .frame(height: 44)
        // A bar, like the navigation bar above it: its labels stop growing
        // at the largest standard size so the tabs stay readable as tabs.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private func chip(_ thread: ThreadSummary) -> some View {
        let selected = thread.id == store.currentThreadId
        let marked = thread.status != .idle || thread.unread
        return Button {
            Haptics.select()
            Task { await store.select(threadId: thread.id) }
        } label: {
            HStack(spacing: 4) {
                if marked { StatusDot(status: thread.status, unread: thread.unread, size: 7) }
                Text(thread.displayTitle)
                    .font(.footnote.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Sand.text : Sand.muted)
                    .lineLimit(1)
                    // The open chat's tab is as wide as its title, up to the width of
                    // the row itself: a long title ends in an ellipsis inside the row,
                    // never cut off at its edge. The others are for telling apart.
                    .frame(maxWidth: selected ? max(120, stripWidth - 16 - 24 - (marked ? 11 : 0) - 14) : 140, alignment: .leading)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.leading, marked ? 6 : 12)
            .padding(.trailing, 12)
            .frame(height: 32)
            .background(selected ? Sand.raised : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Sand.border : .clear, lineWidth: 1))
            // The pill is 32 points; the touch target is the strip's full 44.
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel("\(thread.displayTitle), \(thread.status.label)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Every chat in the project, grouped by what it needs from you.
struct ThreadsSheet: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var renaming: ThreadSummary?
    @State private var renameText = ""
    @State private var deleting: ThreadSummary?
    @State private var showArchived = false

    private var active: [ThreadSummary] { store.openThreads.filter { $0.status == .running || $0.status == .needsInput } }
    private var recent: [ThreadSummary] { store.openThreads.filter { $0.status != .running && $0.status != .needsInput } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Haptics.tap()
                        Task {
                            await store.newThread()
                            dismiss()
                        }
                    } label: {
                        Label("New chat", systemImage: "plus")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Sand.text)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 30)
                    }
                    .listRowBackground(Sand.card)
                    .accessibilityIdentifier("threads.new")
                }
                if !active.isEmpty {
                    Section("Working now") { rows(active) }
                }
                if !recent.isEmpty {
                    Section("Recent") { rows(recent) }
                }
                if !store.archivedThreads.isEmpty {
                    Section {
                        DisclosureGroup("Archived (\(store.archivedThreads.count))", isExpanded: $showArchived) {
                            rows(store.archivedThreads)
                        }
                        .tint(Sand.muted)
                        .foregroundStyle(Sand.muted)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Sand.canvas)
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    if let thread = renaming { Task { await store.rename(thread, to: renameText) } }
                }
            }
            .confirmationDialog(
                "Delete this chat?",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible
            ) {
                Button("Delete chat", role: .destructive) {
                    if let thread = deleting { Task { await store.delete(thread) } }
                }
            } message: {
                Text("Its messages are removed for everyone on the project. Files the agent changed stay as they are.")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func rows(_ threads: [ThreadSummary]) -> some View {
        ForEach(threads) { thread in
            let selected = thread.id == store.currentThreadId
            Button {
                Haptics.select()
                Task {
                    if thread.archived { await store.setArchived(thread, false) }
                    await store.select(threadId: thread.id)
                    dismiss()
                }
            } label: {
                HStack(alignment: .top, spacing: Space.s) {
                    StatusDot(status: thread.status, unread: thread.unread, size: 9)
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(thread.displayTitle)
                            .font(.body.weight(thread.unread ? .semibold : .regular))
                            .foregroundStyle(Sand.text)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 5) {
                            Text(ModelCatalog.name(thread.model))
                            Text("·")
                            Text(thread.status == .running ? "Working" : thread.status == .needsInput ? "Needs your input" : RelativeTime.short(thread.updatedAt))
                                .foregroundStyle(thread.status == .idle ? Sand.subtle : thread.status.tone.foreground)
                            if thread.queued > 0 {
                                Text("· \(thread.queued) queued")
                            }
                        }
                        .font(.footnote)
                        .foregroundStyle(Sand.subtle)
                    }
                    Spacer(minLength: 0)
                    if selected {
                        Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(Sand.text)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowBackground(selected ? Sand.elevated : Sand.card)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) { deleting = thread } label: { Label("Delete", systemImage: "trash") }
                Button {
                    Task { await store.setArchived(thread, !thread.archived) }
                } label: {
                    Label(thread.archived ? "Restore" : "Archive", systemImage: thread.archived ? "tray.and.arrow.up" : "archivebox")
                }
                .tint(Sand.control)
            }
            .swipeActions(edge: .leading) {
                Button {
                    renameText = thread.displayTitle
                    renaming = thread
                } label: { Label("Rename", systemImage: "pencil") }
                .tint(Sand.accent)
            }
            .contextMenu {
                Button {
                    renameText = thread.displayTitle
                    renaming = thread
                } label: { Label("Rename", systemImage: "pencil") }
                Button { Task { await store.setArchived(thread, !thread.archived) } } label: {
                    Label(thread.archived ? "Restore" : "Archive", systemImage: "archivebox")
                }
                Button(role: .destructive) { deleting = thread } label: { Label("Delete", systemImage: "trash") }
            }
        }
    }
}
