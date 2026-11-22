import Foundation
import UIKit
import UserNotifications

/// Notifications for agents: finished, needs your input, or stopped on an
/// error. They come from Botflow's server when the app is not running and are
/// raised locally when the app sees the turn end first.
@MainActor
final class PushManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    enum Category {
        static let agentFinished = "AGENT_FINISHED"
        static let agentNeedsInput = "AGENT_NEEDS_INPUT"
        static let agentFailed = "AGENT_FAILED"
    }

    enum Action {
        static let reply = "REPLY"
        static let open = "OPEN"
    }

    @Published var authorization: UNAuthorizationStatus = .notDetermined
    /// The thread on screen right now; its own notifications are not shown over it.
    var visibleThreadId: String?
    /// True once APNs has given this device a token, so the server can reach it.
    private(set) var hasRemoteToken = false
    var onOpen: ((_ projectId: String, _ threadId: String?) -> Void)?

    private let center = UNUserNotificationCenter.current()

    func configure() {
        center.delegate = self
        let reply = UNTextInputNotificationAction(identifier: Action.reply, title: "Reply", options: [], textInputButtonTitle: "Send", textInputPlaceholder: "Tell the agent what to do next")
        let open = UNNotificationAction(identifier: Action.open, title: "Open", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Category.agentFinished, actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.agentNeedsInput, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.agentFailed, actions: [reply, open], intentIdentifiers: []),
        ])
        Task { await refreshStatus() }
    }

    func refreshStatus() async {
        authorization = await center.notificationSettings().authorizationStatus
    }

    /// Ask once, at a moment that explains itself: the first prompt sent.
    func requestIfNeeded() async {
        await refreshStatus()
        guard authorization == .notDetermined else {
            registerIfAuthorized()
            return
        }
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshStatus()
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    func registerIfAuthorized() {
        Task {
            await refreshStatus()
            if authorization == .authorized || authorization == .provisional {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        hasRemoteToken = true
        Task { await Services.shared.registerDevice(token: hex, environment: AppConfig.apnsEnvironment) }
    }

    /// Raise a notification from the app itself when it sees a turn end. Only
    /// where the server cannot push to this device (no APNs token, as on a
    /// simulator): where it can, its push is the one notification.
    func notifyTurnEnded(projectId: String, projectName: String, threadId: String, threadTitle: String, outcome: ThreadStatus, summary: String) {
        guard !hasRemoteToken else { return }
        guard UIApplication.shared.applicationState != .active || visibleThreadId != threadId else { return }
        let content = UNMutableNotificationContent()
        switch outcome {
        case .needsInput:
            content.title = "\(projectName) needs your input"
            content.categoryIdentifier = Category.agentNeedsInput
            content.interruptionLevel = .timeSensitive
        case .error:
            content.title = "\(projectName): the agent stopped"
            content.categoryIdentifier = Category.agentFailed
        default:
            content.title = "\(projectName): the agent finished"
            content.categoryIdentifier = Category.agentFinished
        }
        content.subtitle = threadTitle
        content.body = summary
        content.sound = .default
        content.threadIdentifier = projectId
        content.userInfo = ["projectId": projectId, "threadId": threadId]
        center.add(UNNotificationRequest(identifier: "turn-\(threadId)", content: content, trigger: nil))
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let threadId = notification.request.content.userInfo["threadId"] as? String
        let visible = await MainActor.run { self.visibleThreadId }
        if let threadId, threadId == visible { return [] }
        return [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let projectId = info["projectId"] as? String else { return }
        let threadId = info["threadId"] as? String

        if response.actionIdentifier == Action.reply, let text = (response as? UNTextInputNotificationResponse)?.userText,
           let threadId, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Answer from the notification without opening the app.
            _ = try? await Services.shared.send(projectId: projectId, threadId: threadId, messageId: UUID().uuidString, text: text, images: [])
            return
        }
        await MainActor.run { self.onOpen?(projectId, threadId) }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Task { @MainActor in PushManager.shared.configure() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushManager.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Expected on a simulator without a provisioned push environment.
    }
}
