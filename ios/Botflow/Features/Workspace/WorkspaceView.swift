import SwiftUI

enum WorkspacePane: Hashable {
    case chat, app
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

    @State private var pane: WorkspacePane
    @State private var showThreads = false
    @State private var sheet: WorkspaceSheet?
    @State private var immersive = false

    init(route: WorkspaceRoute) {
        self.route = route
        _store = StateObject(wrappedValue: WorkspaceStore(project: route.project, initialPrompt: route.initialPrompt))
        _pane = State(initialValue: route.startOnApp ? .app : .chat)
    }

    var body: some View {
        GeometryReader { proxy in
            // Width decides, not the size class: an open Duo (about 670 points)
            // and an iPad both have room for two panes.
            let layout = WorkspaceLayout.choose(size: proxy.size, hinge: hinge.posture)
            let split = layout != .single
            Group {
                if layout == .stacked {
                    // Half open and held like a laptop: the app on the upright
                    // half, the conversation and keyboard on the flat half.
                    VStack(spacing: 0) {
                        AppPane(store: store, sheet: $sheet, immersive: $immersive)
                            .frame(height: proxy.size.height / 2)
                        Divider().overlay(Sand.border)
                        chatColumn
                    }
                } else if split {
                    HStack(spacing: 0) {
                        chatColumn
                            .frame(width: layout == .halves ? proxy.size.width / 2 : min(460, max(300, proxy.size.width * 0.4)))
                        Divider().overlay(Sand.border)
                        AppPane(store: store, sheet: $sheet, immersive: $immersive)
                    }
                } else {
                    ZStack {
                        chatColumn
                            .opacity(pane == .chat ? 1 : 0)
                            .allowsHitTesting(pane == .chat)
                            .accessibilityHidden(pane != .chat)
                        if pane == .app {
                            AppPane(store: store, sheet: $sheet, immersive: $immersive)
                                .transition(.opacity)
                        }
                    }
                }
            }
            .toolbar {
                if !split {
                    ToolbarItem(placement: .principal) {
                        SegmentedTabs(
                            selection: $pane,
                            items: [.init(value: .chat, title: "Chat"), .init(value: .app, title: "App")],
                            compact: true
                        )
                        .frame(width: 168)
                    }
                    .sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 6) {
                            Image(systemName: store.project.kind.symbol).foregroundStyle(Sand.subtle)
                            Text(store.project.name).font(.headline).foregroundStyle(Sand.text).lineLimit(1)
                        }
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        showThreads = true
                    } label: {
                        Label("Chats", systemImage: "bubble.left.and.bubble.right")
                    }
                    .accessibilityIdentifier("workspace.threads")
                    moreMenu
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar(immersive ? .hidden : .visible, for: .navigationBar)
        .statusBarHidden(immersive)
        .background(Sand.canvas.ignoresSafeArea())
        .sheet(isPresented: $showThreads) { ThreadsSheet(store: store) }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .publish: PublishSheet(store: store)
            case .share: ShareProjectSheet(store: store)
            case .env: EnvSheet(store: store)
            case .terminal: TerminalSheet(store: store)
            case .web(let title, let url): WebSheet(title: title, url: url)
            }
        }
        .task { await store.open(threadId: route.threadId) }
        .onDisappear { store.close() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                store.startPolling()
                Task { await store.refreshThreads() }
            }
        }
    }

    private var chatColumn: some View {
        VStack(spacing: 0) {
            if store.openThreads.count > 1 {
                ThreadStrip(store: store) { showThreads = true }
            }
            if let thread = store.session {
                ChatView(store: store, session: thread)
                    .id(thread.threadId)
            } else if let error = store.loadError {
                ErrorBanner(message: error) { Task { await store.open(threadId: route.threadId) } }
                    .padding(Space.gutter)
                Spacer()
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Sand.canvas)
    }

    private var moreMenu: some View {
        Menu {
            Section(store.project.name) {
                Button { Task { await store.newThread() } } label: { Label("New chat", systemImage: "plus.bubble") }
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
                if let url = store.project.liveURL {
                    Link(destination: url) { Label("Visit live site", systemImage: "safari") }
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
    /// One pane at a time, switched with Chat / App.
    case single
    /// Chat beside the app, chat the narrower.
    case sideBySide
    /// Two equal panes either side of a vertical fold.
    case halves
    /// The app above the chat, either side of a horizontal fold.
    case stacked

    static func choose(size: CGSize, hinge: HingePosture?) -> WorkspaceLayout {
        if hinge == .partiallyOpen {
            // A book-style fold: the crease runs down the middle in portrait
            // and across the middle in landscape.
            if size.width > size.height, size.height >= 560 { return .stacked }
            if size.width >= 560 { return .halves }
        }
        return size.width >= 640 ? .sideBySide : .single
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
