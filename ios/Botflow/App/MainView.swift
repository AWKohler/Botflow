import SwiftUI

/// The signed-in shell. One `TabView` serves every size: a tab bar on iPhone,
/// a sidebar (or top tab bar) on iPad and on an unfolded iPhone Duo.
struct MainView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router
    @StateObject private var agents = AgentsHub()

    var body: some View {
        TabView(selection: $router.tab) {
            Tab(AppTab.build.title, systemImage: AppTab.build.symbol, value: AppTab.build) {
                stack(.build) { BuildView() }
            }
            Tab(AppTab.projects.title, systemImage: AppTab.projects.symbol, value: AppTab.projects) {
                stack(.projects) { ProjectsView() }
            }
            Tab(AppTab.agents.title, systemImage: AppTab.agents.symbol, value: AppTab.agents) {
                stack(.agents) { AgentsView() }
            }
            .badge(agents.attentionCount)
            Tab(AppTab.explore.title, systemImage: AppTab.explore.symbol, value: AppTab.explore) {
                stack(.explore) { ExploreView() }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .tabBarMinimizeBehavior(.onScrollDown)
        .environmentObject(agents)
        .sheet(item: $router.sheet) { sheet in
            switch sheet {
            case .settings:
                SettingsView()
            case .paywall(let reason):
                PaywallView(reason: reason)
            }
        }
        .task { agents.start() }
        .onDisappear { agents.stop() }
        .task {
            guard let route = AppConfig.demoRoute else { return }
            await DemoRouting.open(route, router: router, session: session)
        }
    }

    private func stack<Content: View>(_ tab: AppTab, @ViewBuilder root: () -> Content) -> some View {
        NavigationStack(path: router.path(for: tab)) {
            root()
                .navigationDestination(for: WorkspaceRoute.self) { route in
                    WorkspaceView(route: route)
                }
        }
        // Controls are ink, as on the website; the accent is kept for links and selection.
        .tint(Sand.text)
    }
}

/// The account button every root screen carries in its navigation bar.
struct AccountButton: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router

    var body: some View {
        Button {
            router.sheet = .settings
        } label: {
            AvatarView(initials: session.user?.initials ?? "··", imageURL: session.user?.imageUrl, size: 30)
        }
        .accessibilityLabel("Account and settings")
    }
}

/// Opens a named screen straight away in demo mode, for screenshots and UI tests.
enum DemoRouting {
    @MainActor
    static func open(_ route: String, router: Router, session: AppSession) async {
        let service = session.service
        guard let projects = try? await service.projects() else { return }
        func project(_ id: String) -> Project? { projects.first { $0.id == id } }
        switch route {
        case "projects": router.tab = .projects
        case "agents": router.tab = .agents
        case "explore": router.tab = .explore
        case "settings": router.sheet = .settings
        case "paywall": router.sheet = .paywall(reason: nil)
        case "workspace":
            if let p = project("p-tidewater") { router.open(WorkspaceRoute(project: p, threadId: "t-hero"), in: .projects) }
        case "workspace-live":
            if let p = project("p-tidewater") { router.open(WorkspaceRoute(project: p, threadId: "t-order"), in: .projects) }
        case "workspace-question":
            if let p = project("p-tidewater") { router.open(WorkspaceRoute(project: p, threadId: "t-menu"), in: .projects) }
        case "workspace-app":
            if let p = project("p-tidewater") { router.open(WorkspaceRoute(project: p, threadId: "t-hero", startOnApp: true), in: .projects) }
        case "workspace-swift":
            if let p = project("p-ledger") { router.open(WorkspaceRoute(project: p, threadId: "t-onboard", startOnApp: true), in: .projects) }
        default: break
        }
    }
}
