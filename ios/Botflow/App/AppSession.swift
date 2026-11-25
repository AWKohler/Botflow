import AuthenticationServices
import Foundation
import SwiftUI

/// Who is signed in, and what their account can do.
@MainActor
final class AppSession: ObservableObject {
    enum Phase: Equatable {
        case launching, signedOut, signedIn
    }

    @Published var phase: Phase = .launching
    @Published var user: UserProfile?
    @Published var connections = Connections()
    @Published var credits: Credits?
    @Published var claudePlan: ClaudePlanUsage?
    @Published var subscription: Subscription?
    @Published var isAuthenticating = false
    @Published var authError: String?

    let service: BotflowService
    private let auth = AuthManager()
    private var expiryObserver: NSObjectProtocol?

    var tier: Tier { credits?.tier ?? .free }

    init(service: BotflowService = Services.shared) {
        self.service = service
        expiryObserver = NotificationCenter.default.addObserver(forName: .botflowSessionExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.sessionExpired() }
        }
    }

    func bootstrap() async {
        if AppConfig.isDemo {
            if AppConfig.demoSignedOut {
                phase = .signedOut
            } else {
                await loadAccount()
                phase = .signedIn
            }
            return
        }
        #if DEBUG
        // UI tests hand a session over directly instead of driving the browser sheet.
        if let cookie = ProcessInfo.processInfo.environment["BOTFLOW_SESSION_COOKIE"], let separator = cookie.firstIndex(of: "=") {
            APIClient.shared.adoptSession(name: String(cookie[..<separator]), value: String(cookie[cookie.index(after: separator)...]), expires: nil)
        }
        #endif
        guard APIClient.shared.hasSessionCookie else {
            phase = .signedOut
            return
        }
        do {
            user = try await service.me()
            phase = .signedIn
            await loadAccount()
        } catch let error as APIError where error.isUnauthorized {
            APIClient.shared.clearSession()
            phase = .signedOut
        } catch {
            // Offline at launch: keep the session and let screens show their own errors.
            phase = .signedIn
        }
    }

    func signIn(mode: AuthManager.Mode) async {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        authError = nil
        defer { isAuthenticating = false }
        if AppConfig.isDemo {
            await loadAccount()
            withMotion(.smooth(duration: 0.45)) { phase = .signedIn }
            return
        }
        do {
            guard try await auth.authenticate(mode: mode) else { return }
            user = try await service.me()
            Haptics.success()
            withMotion(.smooth(duration: 0.45)) { phase = .signedIn }
            await loadAccount()
            PushManager.shared.registerIfAuthorized()
        } catch {
            Haptics.error()
            authError = error.localizedDescription
        }
    }

    /// Finishes the native Sign in with Apple button. `nonce` is the raw value
    /// whose hash went into the Apple request.
    func signInWithApple(_ result: Result<ASAuthorization, Error>, nonce: String) async {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        authError = nil
        defer { isAuthenticating = false }
        do {
            let authorization = try result.get()
            if AppConfig.isDemo {
                await loadAccount()
                withMotion(.smooth(duration: 0.45)) { phase = .signedIn }
                return
            }
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                throw AuthManager.AuthError(message: "Apple sign-in did not return an Apple ID.")
            }
            try await auth.completeAppleSignIn(credential, nonce: nonce)
            user = try await service.me()
            Haptics.success()
            withMotion(.smooth(duration: 0.45)) { phase = .signedIn }
            await loadAccount()
            PushManager.shared.registerIfAuthorized()
        } catch let error as ASAuthorizationError where error.code == .canceled {
            return
        } catch {
            Haptics.error()
            authError = error.localizedDescription
        }
    }

    func signOut() async {
        await LiveActivityManager.shared.endAll()
        await service.signOut()
        user = nil
        credits = nil
        subscription = nil
        connections = Connections()
        withMotion(.smooth(duration: 0.35)) { phase = .signedOut }
    }

    private func sessionExpired() {
        guard phase == .signedIn, !AppConfig.isDemo else { return }
        APIClient.shared.clearSession()
        user = nil
        authError = "Your session ended. Sign in again to continue."
        withMotion { phase = .signedOut }
    }

    func loadAccount() async {
        async let me = try? service.me()
        async let connections = try? service.connections()
        async let credits = try? service.credits()
        async let subscription = try? service.subscription()
        let (meValue, connectionsValue, creditsValue, subscriptionValue) = await (me, connections, credits, subscription)
        if let meValue { user = meValue }
        if let connectionsValue { self.connections = connectionsValue }
        if let creditsValue { self.credits = creditsValue }
        self.subscription = subscriptionValue ?? nil
        if self.connections.hasClaudeOAuth == true {
            claudePlan = try? await service.claudePlan()
        }
    }

    func access(for model: AIModel) -> ModelAccess {
        ModelAccess.evaluate(model, connections: connections, tier: tier)
    }
}
