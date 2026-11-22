import SwiftUI

@main
struct BotflowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session = AppSession()
    @StateObject private var router = Router()
    @StateObject private var store = StoreManager.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(router)
                .environmentObject(store)
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

struct LaunchView: View {
    var body: some View {
        BotflowGlyph()
            .frame(width: 64)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .sandCanvas()
    }
}
