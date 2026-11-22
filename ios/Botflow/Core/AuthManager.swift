import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// Sign-in through the website. A system browser sheet opens Botflow's own
/// sign-in page (password, email code, Google or GitHub: whatever the web
/// offers, including creating an account). When the person is signed in there,
/// the site hands this app a one-time code; the app trades it, with a secret
/// only it holds (PKCE), for a session of its own.
@MainActor
final class AuthManager: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum Mode: String {
        case signIn = "sign-in"
        case signUp = "sign-up"
    }

    struct AuthError: LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    private var webSession: ASWebAuthenticationSession?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        return scene?.keyWindow ?? ASPresentationAnchor()
    }

    /// Runs the whole flow. Returns normally once the session cookie is stored;
    /// returns `false` if the person closed the sheet.
    func authenticate(mode: Mode) async throws -> Bool {
        let verifier = Self.randomToken(bytes: 48)
        let challenge = Self.sha256Base64URL(verifier)
        let state = Self.randomToken(bytes: 16)

        var components = URLComponents(url: AppConfig.baseURL.appendingPathComponent("native/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "challenge", value: challenge),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "mode", value: mode.rawValue),
            URLQueryItem(name: "device", value: UIDevice.current.name),
        ]

        let callback: URL
        do {
            callback = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                let session = ASWebAuthenticationSession(url: components.url!, callback: .customScheme(AppConfig.callbackScheme)) { url, error in
                    if let url { continuation.resume(returning: url) }
                    else { continuation.resume(throwing: error ?? AuthError(message: "Sign-in did not finish.")) }
                }
                session.presentationContextProvider = self
                // Share Safari's cookies, so someone already signed in on the
                // web (or to Google) is one tap from done.
                session.prefersEphemeralWebBrowserSession = false
                self.webSession = session
                if !session.start() {
                    continuation.resume(throwing: AuthError(message: "The sign-in window could not open."))
                }
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return false
        }
        webSession = nil

        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        if let failure = value("error") {
            throw AuthError(message: failure == "access_denied" ? "Sign-in was cancelled." : "Sign-in failed. Try again.")
        }
        guard value("state") == state, let code = value("code") else {
            throw AuthError(message: "Sign-in could not be verified. Try again.")
        }

        // The response sets the session cookie in this app's cookie store.
        _ = try await APIClient.shared.json("POST", "api/auth/native/token", body: .object([
            "code": .string(code),
            "verifier": .string(verifier),
            "deviceName": .string(UIDevice.current.name),
        ]))
        guard APIClient.shared.hasSessionCookie else {
            throw AuthError(message: "Sign-in finished but no session was returned. Try again.")
        }
        return true
    }

    static func randomToken(bytes: Int) -> String {
        var data = Data(count: bytes)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        return base64URL(data)
    }

    static func sha256Base64URL(_ input: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(input.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
