import SwiftUI

/// The project's agents as a strip of tabs: switch between conversations the
/// way you switch browser tabs, with each agent's state on its tab. On a phone
/// it starts with the project's name, which opens the full list of chats.
struct ThreadStrip: View {
    @ObservedObject var store: WorkspaceStore
    var showsProject = false
    var onShowAll: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
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
                }
                // Margins, not padding: scrolling a tab to the start then stops
                // clear of the fade instead of underneath it.
                .contentMargins(.horizontal, 8, for: .scrollContent)
                .scrollIndicators(.hidden)
                .mask {
                    HStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: 6)
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 18)
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
        // A solid bar with a hairline under it: text scrolling behind tabs
        // that have gaps between them reads as clutter, not as glass.
        // (The fill runs up under the navigation bar too, so that bar sits on
        // one even surface instead of on whatever is scrolling past.)
        .background(Sand.canvas.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { Rectangle().fill(Sand.border.opacity(0.7)).frame(height: 0.5) }
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
                    // The open chat gets room for its whole title; the others are for telling apart.
                    .frame(maxWidth: selected ? 260 : 140, alignment: .leading)
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
