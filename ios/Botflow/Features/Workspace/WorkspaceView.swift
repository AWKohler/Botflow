import SwiftUI

enum WorkspacePane: Hashable {
    case chat, app
}

/// A project: the agents on one side, the app they are building on the other.
/// Side by side where there is room (iPad, an unfolded iPhone Duo), one at a
/// time on a phone.
struct WorkspaceView: View {
    let route: WorkspaceRoute
    @StateObject private var store: WorkspaceStore
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router
    @Environment(\.horizontalSizeClass) private var sizeClass
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
            let split = sizeClass == .regular && proxy.size.width >= 820
            Group {
                if split {
                    HStack(spacing: 0) {
                        chatColumn
                            .frame(width: min(460, max(360, proxy.size.width * 0.38)))
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
