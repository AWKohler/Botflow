import Foundation
import UIKit

enum AppConfig {
    static let productionURL = URL(string: "https://botflow.io")!
    static let callbackScheme = "botflow"
    static let bundleId = "io.botflow.app"

    /// The server this build talks to. Production unless a debug launch
    /// argument (`-BotflowBaseURL http://localhost:3002`) says otherwise.
    static var baseURL: URL {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "BotflowBaseURL"), let url = URL(string: override) {
            return url
        }
        #endif
        return productionURL
    }

    static var origin: String {
        var origin = "\(baseURL.scheme ?? "https")://\(baseURL.host ?? "botflow.io")"
        if let port = baseURL.port { origin += ":\(port)" }
        return origin
    }

    /// Fixture data instead of the network: for previews, UI tests and screenshots.
    static var isDemo: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-BotflowDemo") || UserDefaults.standard.bool(forKey: "BotflowDemo")
        #else
        return false
        #endif
    }

    static var demoSignedOut: Bool {
        ProcessInfo.processInfo.arguments.contains("-BotflowDemoSignedOut")
    }

    /// A screen to open straight away in demo mode (`-BotflowDemoRoute workspace`).
    static var demoRoute: String? {
        UserDefaults.standard.string(forKey: "BotflowDemoRoute")
    }

    /// Debug builds can open one project at launch, for tests and screenshots:
    /// `-BotflowOpenProject <id> [-BotflowOpenThread <id>] [-BotflowOpenApp YES]`.
    static var debugOpenProject: (id: String, threadId: String?, onApp: Bool)? {
        #if DEBUG
        guard let id = UserDefaults.standard.string(forKey: "BotflowOpenProject") else { return nil }
        return (id, UserDefaults.standard.string(forKey: "BotflowOpenThread"), UserDefaults.standard.bool(forKey: "BotflowOpenApp"))
        #else
        return nil
        #endif
    }

    /// Which APNs servers can reach this build: Apple's sandbox for debug builds.
    static var apnsEnvironment: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }

    static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }

    static var userAgent: String {
        "Botflow-iOS/\(version) (\(UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"); iOS \(UIDevice.current.systemVersion))"
    }
}
