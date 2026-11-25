import SwiftUI

enum AppTab: String, Hashable, CaseIterable {
    case build, projects, agents, explore

    var title: String {
        switch self {
        case .build: return "Build"
        case .projects: return "Projects"
        case .agents: return "Agents"
        case .explore: return "Explore"
        }
    }

    var symbol: String {
        switch self {
        case .build: return "sparkles"
        case .projects: return "square.grid.2x2"
        case .agents: return "bolt"
        case .explore: return "safari"
        }
    }
}

/// A project to open, optionally at one thread and with a first prompt to send.
struct WorkspaceRoute: Hashable, Identifiable {
    var project: Project
    var threadId: String?
    var initialPrompt: String?
    /// Which pane to show first on a phone.
    var startOnApp = false

    var id: String { project.id }

    static func == (a: WorkspaceRoute, b: WorkspaceRoute) -> Bool {
        a.project.id == b.project.id && a.threadId == b.threadId && a.initialPrompt == b.initialPrompt
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(project.id)
        hasher.combine(threadId)
    }
}

enum AppSheet: Identifiable {
    case settings
    case paywall(reason: String?)

    var id: String {
        switch self {
        case .settings: return "settings"
        case .paywall: return "paywall"
        }
    }
}

@MainActor
final class Router: ObservableObject {
    @Published var tab: AppTab = .build
    @Published var paths: [AppTab: NavigationPath] = [:]
    @Published var sheet: AppSheet?
    /// A deep link that arrived before sign-in finished.
    private var pendingLink: (projectId: String, threadId: String?)?

    func path(for tab: AppTab) -> Binding<NavigationPath> {
        Binding(
            get: { self.paths[tab] ?? NavigationPath() },
            set: { self.paths[tab] = $0 }
        )
    }

    func open(_ route: WorkspaceRoute, in tab: AppTab? = nil) {
        let target = tab ?? self.tab
        if self.tab != target { self.tab = target }
        var path = NavigationPath()
        path.append(route)
        paths[target] = path
    }

    func popToRoot() {
        paths[tab] = NavigationPath()
    }

    /// `botflow://project/<id>` and `botflow://project/<id>/thread/<id>`:
    /// from a notification, the Live Activity or the Dynamic Island.
    func handle(url: URL, session: AppSession) {
        guard url.scheme == AppConfig.callbackScheme, url.host == "project" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard let projectId = parts.first else { return }
        let threadId = parts.count >= 3 && parts[1] == "thread" ? parts[2] : nil
        openProject(id: projectId, threadId: threadId, session: session)
    }

    func openProject(id: String, threadId: String?, session: AppSession) {
        guard session.phase == .signedIn else {
            pendingLink = (id, threadId)
            return
        }
        Task {
            do {
                let project = try await session.service.project(id)
                sheet = nil
                open(WorkspaceRoute(project: project, threadId: threadId), in: .projects)
            } catch {
                ToastCenter.shared.error(error)
            }
        }
    }

    func resumePendingLink(session: AppSession) {
        guard let link = pendingLink else { return }
        pendingLink = nil
        openProject(id: link.projectId, threadId: link.threadId, session: session)
    }
}
