import Foundation

// MARK: - Projects

enum ProjectPlatform: String, Codable, Sendable {
    case web
    case swift

    init(raw: String?) {
        self = raw == "swift" ? .swift : .web
    }

    var label: String { self == .swift ? "iOS" : "Web" }
    var symbol: String { self == .swift ? "swift" : "globe" }
}

struct Project: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var platform: String?
    var model: String?
    var thumbnailUrl: String?
    var swiftScreenshotIphoneUrl: String?
    var backendType: String?
    var isPublic: Bool?
    var publicSlug: String?
    var publicDescription: String?
    var starCount: Int?
    var lastOpened: Date?
    var createdAt: Date?
    var updatedAt: Date?
    var cloudflareDeploymentUrl: String?
    var customDomain: String?
    var managedDomainHostname: String?
    var githubRepoOwner: String?
    var githubRepoName: String?
    var convexDeployUrl: String?
    var userConvexUrl: String?
    var shared: Bool?
    var viewerRole: String?
    var sharedTier: String?
    var userId: String?

    var kind: ProjectPlatform { ProjectPlatform(raw: platform) }
    var isSwift: Bool { kind == .swift }
    var previewImageURL: URL? {
        (swiftScreenshotIphoneUrl ?? thumbnailUrl).flatMap(URL.init(string:))
    }
    var liveURL: URL? {
        if let host = customDomain ?? managedDomainHostname, !host.isEmpty { return URL(string: "https://\(host)") }
        return cloudflareDeploymentUrl.flatMap(URL.init(string:))
    }
    var isOwner: Bool { shared != true && viewerRole != "editor" }
    var hasBackend: Bool { (backendType ?? "none") != "none" }
}

struct PublicProject: Codable, Identifiable, Hashable, Sendable {
    struct Author: Codable, Hashable, Sendable {
        var name: String
        var imageUrl: String?
    }
    let id: String
    var name: String
    var publicSlug: String?
    var publicDescription: String?
    var thumbnailUrl: String?
    var platform: String?
    var starCount: Int?
    var hasStarred: Bool?
    var author: Author?
    var publishedAt: Date?

    var kind: ProjectPlatform { ProjectPlatform(raw: platform) }
    var pageURL: URL? { publicSlug.map { AppConfig.baseURL.appendingPathComponent("p/\($0)") } }
}

// MARK: - Threads

enum ThreadStatus: String, Codable, Sendable {
    case running
    case needsInput = "needs_input"
    case error
    case idle
}

struct ThreadSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String?
    var model: String
    var status: ThreadStatus
    var unread: Bool
    var createdBy: String?
    var archived: Bool
    var createdAt: Date?
    var updatedAt: Date?
    var lastTurnEndedAt: Date?
    var liveTurnId: String?
    var queued: Int

    var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? "New chat" }
}

struct ThreadPerson: Codable, Hashable, Sendable {
    var name: String
    var initials: String
    var imageUrl: String?
}

struct QueueItem: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var userId: String
    var text: String
    var hasImages: Bool
    var status: String
    var error: String?
    var createdAt: Date?
}

struct ThreadsResponse: Codable, Sendable {
    var threads: [ThreadSummary]
    var viewers: [String: [String]]?
    var people: [String: ThreadPerson]?
    var me: String?
    var queue: [QueueItem]?
}

/// A running or waiting agent anywhere in the account, for the Agents tab,
/// notifications and the Live Activity.
struct AgentActivity: Codable, Identifiable, Hashable, Sendable {
    struct Step: Codable, Hashable, Sendable {
        var tool: String
        var detail: String
        var steps: Int
    }

    var projectId: String
    var projectName: String
    var platform: String?
    var thread: ThreadSummary
    /// The step a running agent is on, when the server knows it.
    var currentStep: Step?
    /// Why a failed agent stopped.
    var error: String?
    /// What a waiting agent asked.
    var question: String?

    var id: String { "\(projectId):\(thread.id)" }
}

// MARK: - Chat

enum ChatRole: String, Codable, Sendable {
    case user, assistant, system
}

enum ToolState: String, Codable, Sendable {
    case running, done, error
}

struct ToolCall: Hashable, Identifiable, Sendable {
    let id: String
    var name: String
    var input: JSONValue
    var output: JSONValue?
    var errorText: String?
    var state: ToolState
    var subagentSteps: [SubagentStep] = []
}

struct SubagentStep: Hashable, Identifiable, Sendable {
    enum Kind: String, Sendable { case text, thinking, tool }
    let id: String
    var kind: Kind
    var text: String
    var toolName: String?
    var input: JSONValue?
    var state: ToolState
}

struct ImageAttachment: Hashable, Identifiable, Sendable {
    var id: String { url }
    var url: String
    var mediaType: String
}

enum ChatPart: Hashable, Identifiable, Sendable {
    case text(id: String, text: String)
    case reasoning(id: String, text: String, streaming: Bool)
    case tool(ToolCall)
    case image(ImageAttachment)
    case notice(id: String, text: String, isError: Bool)

    var id: String {
        switch self {
        case .text(let id, _): return "t:\(id)"
        case .reasoning(let id, _, _): return "r:\(id)"
        case .tool(let call): return "c:\(call.id)"
        case .image(let image): return "i:\(image.url)"
        case .notice(let id, _, _): return "n:\(id)"
        }
    }
}

struct ChatMessage: Identifiable, Hashable, Sendable {
    let id: String
    var role: ChatRole
    var parts: [ChatPart]
    var userId: String?
    var createdAt: Date?
    var segmentId: String?
    /// The agent is still writing this message.
    var streaming: Bool = false

    var plainText: String {
        parts.compactMap { part -> String? in
            if case .text(_, let text) = part { return text }
            return nil
        }.joined(separator: "\n")
    }

    var toolCalls: [ToolCall] {
        parts.compactMap { part -> ToolCall? in
            if case .tool(let call) = part { return call }
            return nil
        }
    }
}

struct ChatHistory: Sendable {
    var threadId: String
    var model: String
    var title: String?
    var messages: [ChatMessage]
    var currentSegmentId: String?
}

struct TurnStatus: Codable, Sendable {
    var ok: Bool?
    var active: Bool
    var endedNormally: Bool
    var turnId: String?
    var startedAt: Double?
    var userMessageId: String?
}

enum SendOutcome: Sendable {
    /// The agent started; follow this turn.
    case started(turnId: String)
    /// The agent is busy; the message waits in the queue.
    case queued
    /// The agent could not start. The message stays in the queue as failed.
    case failed(String)
}

// MARK: - Questions (ask_question tool)

struct AgentQuestion: Hashable, Identifiable, Sendable {
    struct Option: Hashable, Identifiable, Sendable {
        let id: String
        var label: String
        var description: String?
    }
    let id: String
    var header: String?
    var question: String
    var options: [Option]
    var multiSelect: Bool

    static func parse(_ input: JSONValue) -> [AgentQuestion] {
        guard let raw = input["questions"]?.arrayValue else { return [] }
        return raw.enumerated().map { index, q in
            AgentQuestion(
                id: q["id"]?.stringValue ?? "q-\(index)",
                header: q["header"]?.stringValue,
                question: q["question"]?.stringValue ?? "",
                options: (q["options"]?.arrayValue ?? []).enumerated().map { oi, o in
                    Option(
                        id: o["id"]?.stringValue ?? "opt-\(index)-\(oi)",
                        label: o["label"]?.stringValue ?? "Option \(oi + 1)",
                        description: o["description"]?.stringValue
                    )
                },
                multiSelect: q["multiSelect"]?.boolValue ?? false
            )
        }
    }
}

// MARK: - Account

struct UserProfile: Codable, Hashable, Sendable {
    var id: String
    var fullName: String?
    var firstName: String?
    var username: String?
    var imageUrl: String?
    var email: String?

    var displayName: String {
        if let fullName, !fullName.isEmpty { return fullName }
        if let username, !username.isEmpty { return username }
        return email ?? "You"
    }

    var initials: String {
        let source = displayName.replacingOccurrences(of: #"@.*"#, with: "", options: .regularExpression)
        let words = source.split(whereSeparator: { " ._-".contains($0) })
        if words.count >= 2, let a = words[0].first, let b = words[1].first { return "\(a)\(b)".uppercased() }
        return String(source.prefix(2)).uppercased()
    }
}

enum Tier: String, Codable, Comparable, Sendable {
    case free, pro, max

    var rank: Int { self == .free ? 0 : self == .pro ? 1 : 2 }
    static func < (a: Tier, b: Tier) -> Bool { a.rank < b.rank }
    var label: String { rawValue.capitalized }
}

struct Credits: Codable, Sendable {
    struct ModelUsage: Codable, Hashable, Sendable, Identifiable {
        var model: String
        var credits: Int
        var turns: Int
        var id: String { model }
    }
    var tier: Tier
    var weeklyUsed: Double
    var weeklyLimit: Double
    var monthlyUsed: Double
    var monthlyLimit: Double
    var pct: Int
    var monthlyPct: Int?
    var models: [ModelUsage]?
}

struct ClaudePlanUsage: Codable, Sendable {
    var available: Bool
    var fiveHour: Int?
    var sevenDay: Int?
}

struct Connections: Codable, Sendable {
    var hasOpenAIKey: Bool = false
    var hasAnthropicKey: Bool = false
    var hasMoonshotKey: Bool = false
    var hasFireworksKey: Bool = false
    var hasTogetherKey: Bool = false
    var hasGoogleKey: Bool = false
    var hasXaiKey: Bool = false
    var useTogetherKimi: Bool? = false
    var hasClaudeOAuth: Bool? = false
    var hasCodexOAuth: Bool? = false
    var hasConvexOAuth: Bool? = false
    var convexBackendPreference: String? = "platform"
}

struct Subscription: Codable, Sendable {
    var plan: String
    var status: String
    var amount: Int?
    var currency: String?
    var interval: String?
    var periodEnd: Date?
    var cancelAtPeriodEnd: Bool?
    /// Bought in this app and managed in the person's Apple Account.
    var viaAppStore: Bool?
}

// MARK: - Sandbox

struct SandboxFile: Hashable, Identifiable, Sendable {
    var path: String
    var isDirectory: Bool
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
}

struct FileContent: Codable, Sendable {
    var content: String
    var binary: Bool
    var hash: String?
}

struct DevServer: Codable, Sendable {
    var previewUrl: String
    var port: Int?
}

struct GitStatus: Codable, Sendable {
    var linked: Bool?
    var branch: String?
    var ahead: Int?
    var behind: Int?
    var dirty: Bool?
    var changedFiles: [String]?
    var repo: String?
}

struct EnvVar: Codable, Hashable, Identifiable, Sendable {
    var key: String
    var value: String?
    var isSecret: Bool?
    /// Set by Botflow (for example the Convex URL); shown but not editable.
    var isSystem: Bool?
    var id: String { key }
}

struct ProjectMember: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var email: String?
    var name: String?
    var role: String?
    var status: String?
    var imageUrl: String?
}

// MARK: - Simulator

struct SimulatorSession: Codable, Sendable {
    var sessionId: String
    var wsUrl: String
}
