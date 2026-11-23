import SwiftUI

@main
struct BotflowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session = AppSession()
    @StateObject private var router = Router()
    @StateObject private var store = StoreManager.shared
    @StateObject private var hinge = DeviceHingeModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(router)
                .environmentObject(store)
                .environmentObject(hinge)
                .observingHinge(hinge)
                .tint(Sand.accent)
                .task {
                    await session.bootstrap()
                    PushManager.shared.onOpen = { projectId, threadId in
                        router.openProject(id: projectId, threadId: threadId, session: session)
                    }
                    PushManager.shared.registerIfAuthorized()
                }
                .onOpenURL { url in
                    router.handle(url: url, session: session)
                }
                .onChange(of: session.phase) { _, phase in
                    if phase == .signedIn { router.resumePendingLink(session: session) }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active, session.phase == .signedIn {
                        Task { await session.loadAccount() }
                    }
                }
        }
    
        // iPad: a project in a window of its own, beside the main one.
        WindowGroup("Project", id: "project", for: String.self) { $projectId in
            ProjectWindow(projectId: projectId)
                .environmentObject(session)
                .environmentObject(store)
                .environmentObject(hinge)
                .observingHinge(hinge)
                .tint(Sand.accent)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var session: AppSession

    var body: some View {
        ZStack {
            Sand.canvas.ignoresSafeArea()
            switch session.phase {
            case .launching:
                LaunchView()
                    .transition(.opacity)
            case .signedOut:
                OnboardingView()
                    .transition(.opacity)
            case .signedIn:
                MainView()
                    .transition(.opacity.combined(with: .scale(scale: 1.02)))
            }
            ToastOverlay()
        }
    }
}

/// A single project in its own window, with its own navigation and sheets.
struct ProjectWindow: View {
    var projectId: String?
    @EnvironmentObject private var session: AppSession
    @StateObject private var router = Router()
    @State private var project: Project?
    @State private var failure: String?

    var body: some View {
        ZStack {
            Sand.canvas.ignoresSafeArea()
            if session.phase != .signedIn {
                EmptyState(symbol: "person.crop.circle", title: "Sign in to open this project", message: "Sign in from the main Botflow window, then open the project again.")
            } else if let project {
                NavigationStack {
                    WorkspaceView(route: WorkspaceRoute(project: project))
                        .navigationBarBackButtonHidden()
                }
                .tint(Sand.text)
            } else if let failure {
                EmptyState(symbol: "exclamationmark.triangle", title: "This project couldn't be opened", message: failure)
            } else {
                ProgressView()
            }
            ToastOverlay()
        }
        .environmentObject(router)
        .sheet(item: $router.sheet) { sheet in
            Group {
                switch sheet {
                case .settings: SettingsView()
                case .paywall(let reason): PaywallView(reason: reason)
                }
            }
            .tint(Sand.text)
        }
        .task(id: session.phase) {
            guard session.phase == .signedIn, project == nil, let projectId else { return }
            do { project = try await session.service.project(projectId) }
            catch { failure = error.localizedDescription }
        }
    }
}

struct LaunchView: View {
    var body: some View {
        BotflowGlyph()
            .frame(width: 64)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .sandCanvas()
    }
}
