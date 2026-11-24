import SwiftUI

/// What a one-pane workspace is showing.
enum WorkspacePane: Hashable {
    case chat, preview, code
}

/// A project: the agents on one side, the app they are building on the other.
/// Side by side where there is room (iPad, an open iPhone Duo), one at a time
/// on a phone. On a Duo propped half open the two panes sit either side of
/// the fold, so nothing lies across the crease.
struct WorkspaceView: View {
    let route: WorkspaceRoute
    @StateObject private var store: WorkspaceStore
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var hinge: DeviceHingeModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var pane: WorkspacePane
    @State private var appTab: AppPane.Tab
    @State private var showThreads = false
    @State private var sheet: WorkspaceSheet?
    @State private var immersive = false
    /// The chat column's width in two-pane layouts, when the person has dragged the divider.
    @AppStorage("workspace.chatWidth") private var storedChatWidth: Double = 0
    @State private var dragStartWidth: CGFloat?

    init(route: WorkspaceRoute) {
        self.route = route
        _store = StateObject(wrappedValue: WorkspaceStore(project: route.project, initialPrompt: route.initialPrompt))
        let code = ["workspace-code", "workspace-file"].contains(AppConfig.demoRoute ?? "")
        _pane = State(initialValue: code ? .code : route.startOnApp ? .preview : .chat)
        _appTab = State(initialValue: code ? .code : .preview)
    }

    var body: some View {
        GeometryReader { proxy in
            // Width decides, not the size class: an open Duo (about 670 points)
            // and an iPad both have room for two panes.
            // The whole window decides, bars included: the fold runs through
            // the middle of the screen, not the middle of what's under the bar.
            let window = CGSize(
                width: proxy.size.width + proxy.safeAreaInsets.leading + proxy.safeAreaInsets.trailing,
                height: proxy.size.height + proxy.safeAreaInsets.top + proxy.safeAreaInsets.bottom
            )
            let layout = WorkspaceLayout.choose(size: window, hinge: hinge.posture)
            let split = layout != .single
            Group {
                switch layout {
                case .stacked:
                    // Half open and held like a laptop: the app on the upright
                    // half, the conversation and keyboard on the flat half.
                    // The half above the fold is short, so its Preview / Code
                    // switch moves up into the navigation bar.
                    VStack(spacing: 0) {
                        AppPane(store: store, tab: $appTab, showsHeader: false, sheet: $sheet, immersive: $immersive)
                            .frame(height: max(160, window.height / 2 - proxy.safeAreaInsets.top))
                        Divider().overlay(Sand.border)
                        chatColumn(compact: false)
                    }
                case .halves:
                    HStack(spacing: 0) {
                        // The crease is the middle of the screen, not of the area left beside the system's rail.
                        chatColumn(compact: false).frame(width: max(280, window.width / 2 - proxy.safeAreaInsets.leading))
                        Divider().overlay(Sand.border)
                        AppPane(store: store, tab: $appTab, showsHeader: true, sheet: $sheet, immersive: $immersive)
                    }
                case .sideBySide:
                    let width = chatWidth(in: proxy.size.width)
                    HStack(spacing: 0) {
                        chatColumn(compact: false).frame(width: width)
                        divider(total: proxy.size.width, current: width)
                        AppPane(store: store, tab: $appTab, showsHeader: true, sheet: $sheet, immersive: $immersive)
                    }
                case .single:
                    ZStack {
                        // The chat stays alive behind the app pane, so a turn
                        // keeps streaming and the scroll position is kept.
                        chatColumn(compact: true)
                            .opacity(pane == .chat ? 1 : 0)
                            .allowsHitTesting(pane == .chat)
                            .accessibilityHidden(pane != .chat)
                        if pane != .chat {
                            AppPane(
                                store: store,
                                tab: Binding(get: { pane == .code ? .code : .preview }, set: { pane = $0 == .code ? .code : .preview }),
                                showsHeader: false,
                                sheet: $sheet,
                                immersive: $immersive
                            )
                            .transition(.opacity)
                        }
                    }
                }
            }
            .toolbar {
                if split {
                    // Either side of a crease, the title belongs to the chat's half, not across the fold.
                    ToolbarItem(placement: layout == .halves ? .topBarLeading : .principal) {
                        HStack(spacing: Space.l) {
                            HStack(spacing: 6) {
                                Image(systemName: store.project.kind.symbol).foregroundStyle(Sand.subtle)
                                Text(store.project.name).font(.headline).foregroundStyle(Sand.text).lineLimit(1)
                            }
                            .accessibilityElement(children: .combine)
                            if layout == .stacked {
                                SegmentedTabs(
                                    selection: $appTab,
                                    items: [.init(value: .preview, title: store.project.isSwift ? "App" : "Preview"), .init(value: .code, title: "Code")],
                                    compact: true
                                )
                                .fixedSize()
                            }
                        }
                        .fixedSize()
                    }
                    .sharedBackgroundVisibility(.hidden)
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button {
                            showThreads = true
                        } label: {
                            Label("Chats", systemImage: "bubble.left.and.bubble.right")
                        }
                        .accessibilityIdentifier("workspace.threads")
                        moreMenu
                    }
                } else {
                    // One switch for the whole workspace: no second row of tabs
                    // under the navigation bar.
                    ToolbarItem(placement: .principal) {
                        SegmentedTabs(
                            selection: $pane,
                            items: [
                                .init(value: .chat, title: "Chat"),
                                .init(value: .preview, title: store.project.isSwift ? "App" : "Preview"),
                                .init(value: .code, title: "Code"),
                            ],
                            compact: true
                        )
                        .fixedSize()
                    }
                    .sharedBackgroundVisibility(.hidden)
                    ToolbarItem(placement: .topBarTrailing) { moreMenu }
                }
            }
            .overlay {
                // Full screen belongs to the workspace, not to one pane: on an
                // iPad it covers the chat column too.
                if immersive {
                    ImmersiveSimulatorView(controller: store.simulator, immersive: $immersive)
                        .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: immersive)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar(immersive ? .hidden : .visible, for: .navigationBar)
        .background(Sand.canvas.ignoresSafeArea())
        .background { shortcuts }
        .sheet(isPresented: $showThreads) { ThreadsSheet(store: store).tint(Sand.text) }
        .sheet(item: $sheet) { sheet in
            Group {
                switch sheet {
                case .publish: PublishSheet(store: store)
                case .share: ShareProjectSheet(store: store)
                case .env: EnvSheet(store: store)
                case .terminal: TerminalSheet(store: store)
                case .web(let title, let url): WebSheet(title: title, url: url)
                }
            }
            .tint(Sand.text)
        }
        .task {
            await store.open(threadId: route.threadId)
            // Demo entry points that open one more layer, for screenshots.
            switch AppConfig.demoRoute {
            case "workspace-threads": showThreads = true
            case "workspace-publish": sheet = .publish
            default: break
            }
        }
        .onDisappear { store.close() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                store.startPolling()
                Task { await store.refreshThreads() }
            }
        }
    }

    // MARK: Chat column

    private func chatColumn(compact: Bool) -> some View {
        Group {
            if let thread = store.session {
                ChatView(store: store, session: thread, compact: compact) { showThreads = true }
                    .id(thread.threadId)
            } else if let error = store.loadError {
                VStack {
                    ErrorBanner(message: error) { Task { await store.open(threadId: route.threadId) } }
                        .padding(Space.gutter)
                    Spacer()
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Sand.canvas)
    }

    // MARK: Divider

    private func chatWidth(in total: CGFloat) -> CGFloat {
        // An open Duo is two phone-width halves; an iPad gives the app the larger share.
        let preferred = storedChatWidth > 0 ? CGFloat(storedChatWidth) : total < 760 ? total / 2 : min(480, total * 0.44)
        return min(max(300, total - 340), max(300, min(preferred, 560)))
    }

    /// The line between the panes. Drag it to give the chat or the app more
    /// room; double-tap to reset.
    private func divider(total: CGFloat, current: CGFloat) -> some View {
        Rectangle()
            .fill(Sand.border)
            .frame(width: 1)
            .overlay {
                Capsule()
                    .fill(Sand.borderStrong)
                    .frame(width: 4, height: 36)
                    .opacity(dragStartWidth == nil ? 0.7 : 1)
            }
            .frame(width: 17)
            // The line is thin; the area that grabs it is 44 points wide.
            .contentShape(Rectangle().inset(by: -13.5))
            .zIndex(1)
            .hoverEffect(.highlight)
            .gesture(
                DragGesture(minimumDistance: 2, coordinateSpace: .global)
                    .onChanged { value in
                        let start = dragStartWidth ?? current
                        dragStartWidth = start
                        storedChatWidth = Double(min(max(300, total - 340), max(300, min(560, start + value.translation.width))))
                    }
                    .onEnded { _ in dragStartWidth = nil }
            )
            .onTapGesture(count: 2) {
                withAnimation(reduceMotion ? nil : .snappy) { storedChatWidth = 0 }
            }
            .accessibilityElement()
            .accessibilityLabel("Pane divider")
            .accessibilityValue("Chat is \(Int(current)) points wide")
            .accessibilityAdjustableAction { direction in
                let step: CGFloat = direction == .increment ? 40 : -40
                storedChatWidth = Double(min(max(300, total - 340), max(300, min(560, current + step))))
            }
    }

    // MARK: Keyboard

    /// Hardware-keyboard shortcuts (iPad, or a keyboard paired with a phone).
    /// They show in the system's shortcut overlay when ⌘ is held.
    private var shortcuts: some View {
        Group {
            Button("New chat") { Task { await store.newThread() } }
                .keyboardShortcut("n", modifiers: .command)
            Button("Show chat") { pane = .chat }
                .keyboardShortcut("1", modifiers: .command)
            Button(store.project.isSwift ? "Show app" : "Show preview") {
                pane = .preview
                appTab = .preview
            }
            .keyboardShortcut("2", modifiers: .command)
            Button("Show code") {
                pane = .code
                appTab = .code
            }
            .keyboardShortcut("3", modifiers: .command)
            Button("All chats") { showThreads = true }
                .keyboardShortcut("k", modifiers: .command)
            if !store.project.isSwift {
                Button("Publish") { sheet = .publish }
                    .keyboardShortcut("p", modifiers: [.command, .shift])
            }
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var moreMenu: some View {
        Menu {
            Section(store.project.name) {
                Button { Task { await store.newThread() } } label: { Label("New chat", systemImage: "plus.bubble") }
                Button { showThreads = true } label: { Label("All chats", systemImage: "bubble.left.and.bubble.right") }
                Button { sheet = .share } label: { Label("Share project", systemImage: "person.badge.plus") }
                if !store.project.isSwift {
                    Button { sheet = .publish } label: { Label("Publish", systemImage: "globe") }
                }
            }
            Section {
                Button { sheet = .env } label: { Label("Environment variables", systemImage: "key") }
                Button { sheet = .terminal } label: { Label("Terminal", systemImage: "terminal") }
                if store.project.hasBackend {
                    Button {
                        sheet = .web(title: "Database", url: AppConfig.baseURL.appendingPathComponent("workspace/\(store.projectId)/database"))
                    } label: { Label("Database", systemImage: "cylinder.split.1x2") }
                }
            }
            Section {
                Button {
                    sheet = .web(title: store.project.name, url: AppConfig.baseURL.appendingPathComponent("workspace/\(store.projectId)"))
                } label: { Label("Open full web workspace", systemImage: "macwindow") }
                if let url = store.previewURL, url.scheme?.hasPrefix("http") == true {
                    Link(destination: url) { Label("Open preview in Safari", systemImage: "safari") }
                }
                if let url = store.project.liveURL {
                    Link(destination: url) { Label("Visit live site", systemImage: "globe") }
                }
                Button { router.sheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("workspace.more")
    }
}

enum WorkspaceLayout: Equatable {
    /// One pane at a time, switched with Chat / Preview / Code.
    case single
    /// Chat beside the app, chat the narrower.
    case sideBySide
    /// Two equal panes either side of a vertical fold.
    case halves
    /// The app above the chat, either side of a horizontal fold.
    case stacked

    static func choose(size: CGSize, hinge: HingePosture?) -> WorkspaceLayout {
        if let hinge, hinge != .closed {
            // An unfolded Duo held upright is wider than it is tall (about
            // 951 × 669 points) and its crease runs down the middle: a pane
            // either side of it, whether it is flat or propped like a book.
            let upright = size.width > size.height
            if upright, size.width >= 560, size.height >= 500 { return .halves }
            // Turned on its side (669 × 951) the crease runs across the middle.
            // Half open like that it sits like a small laptop: the app on the
            // upright half, the conversation and keyboard on the flat one.
            if hinge == .partiallyOpen, !upright, size.height >= 700 { return .stacked }
        }
        // Two panes need room both ways: a phone on its side is wide enough
        // but far too short once the keyboard is up.
        return size.width >= 640 && size.height >= 500 ? .sideBySide : .single
    }
}

enum WorkspaceSheet: Identifiable {
    case publish, share, env, terminal
    case web(title: String, url: URL)

    var id: String {
        switch self {
        case .publish: return "publish"
        case .share: return "share"
        case .env: return "env"
        case .terminal: return "terminal"
        case .web(_, let url): return url.absoluteString
        }
    }
}
