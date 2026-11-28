import Foundation

enum ModelProvider: String, Sendable {
    case openai, anthropic, google, xai, fireworks

    var label: String {
        switch self {
        case .openai: return "OpenAI"
        case .anthropic: return "Anthropic"
        case .google: return "Google"
        case .xai: return "xAI"
        case .fireworks: return "Fireworks"
        }
    }
}

struct AIModel: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let provider: ModelProvider
    /// Shown instead of the provider's name when another host serves the model.
    var host: String?
    let contextTokens: Int
    var personalContextTokens: Int?
    let costMultiplier: Double
    let requiredTier: Tier
    var supportsImages = true

    var hostLabel: String { host ?? provider.label }

    /// The name without its vendor, for tight spots where the vendor's mark
    /// already sits beside it ("Sonnet 5.5").
    var shortName: String {
        name.hasPrefix("Claude ") ? String(name.dropFirst("Claude ".count)) : name
    }

    /// The context window for this account: some providers give a larger one
    /// on a person's own subscription or key than on Botflow's credits.
    func contextLimit(personal: Bool) -> Int {
        personal ? (personalContextTokens ?? contextTokens) : contextTokens
    }

    var costLabel: String {
        let value = costMultiplier == costMultiplier.rounded() ? String(Int(costMultiplier)) : String(costMultiplier)
        return "\(value)× credits"
    }

    static func compact(_ tokens: Int) -> String {
        if tokens >= 1_000_000 {
            let m = Double(tokens) / 1_000_000
            return m >= 1.05 ? String(format: "%.1fM", m) : "1M"
        }
        if tokens >= 1_000 {
            let k = Double(tokens) / 1_000
            return k >= 100 ? "\(Int(k.rounded()))K" : String(format: "%.1fK", k)
        }
        return "\(tokens)"
    }
}

/// Mirrors `src/lib/agent/models.ts` and `src/lib/tier-shared.ts`, cheapest first.
enum ModelCatalog {
    static let defaultId = "gpt-6-luna"

    static let all: [AIModel] = [
        AIModel(id: "gpt-6-luna", name: "GPT-6 Luna", provider: .openai, contextTokens: 1_050_000, costMultiplier: 0.3, requiredTier: .free),
        AIModel(id: "fireworks-deepseek-v4p1-flash", name: "DeepSeek V4.1 Flash", provider: .fireworks, contextTokens: 1_048_576, costMultiplier: 0.7, requiredTier: .free),
        AIModel(id: "gpt-6.2-sol", name: "GPT-6.2 Sol", provider: .openai, contextTokens: 1_050_000, costMultiplier: 6, requiredTier: .pro),
        AIModel(id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: .anthropic, contextTokens: 200_000, personalContextTokens: 1_000_000, costMultiplier: 6, requiredTier: .pro),
        AIModel(id: "fireworks-kimi-k3p1-pro", name: "Kimi K3.1 Pro", provider: .fireworks, contextTokens: 1_048_576, costMultiplier: 6, requiredTier: .pro),
        AIModel(id: "grok-4.7", name: "Grok 4.7", provider: .xai, contextTokens: 500_000, costMultiplier: 7, requiredTier: .pro),
        AIModel(id: "gemini-4-neon", name: "Gemini 4 Neon", provider: .google, contextTokens: 1_000_000, costMultiplier: 8, requiredTier: .pro),
        AIModel(id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: .anthropic, contextTokens: 200_000, personalContextTokens: 1_000_000, costMultiplier: 11, requiredTier: .pro),
        AIModel(id: "claude-fable-5-2", name: "Claude Fable 5.2", provider: .anthropic, contextTokens: 1_000_000, costMultiplier: 21, requiredTier: .max),
        AIModel(id: "gpt-6.2-astra", name: "GPT-6.2 Astra", provider: .openai, contextTokens: 1_050_000, costMultiplier: 22, requiredTier: .max),
    ]

    /// Mirrors `LEGACY_MODEL_ALIASES` in `src/lib/agent/models.ts`, so a
    /// project still saved under a retired id shows its successor.
    private static let aliases: [String: String] = [
        "gpt-6-astra": "gpt-6.2-astra", "gpt-6.1-sol": "gpt-6.2-sol", "gpt-6-sol": "gpt-6.2-sol",
        "gpt-5.6-sol": "gpt-6.2-sol", "gpt-5.6-terra": "gpt-6.2-sol", "gpt-5.5": "gpt-6.2-sol", "gpt-5.4": "gpt-6.2-sol",
        "gpt-5.6-luna": "gpt-6-luna", "gpt-5.3-codex": "gpt-6-luna", "gpt-5.2": "gpt-6-luna", "gpt-4.1": "gpt-6-luna",
        "claude-sonnet-5": "claude-sonnet-5-5", "claude-sonnet-4.5": "claude-sonnet-5-5", "claude-sonnet-4.6": "claude-sonnet-5-5",
        "claude-sonnet-4-6": "claude-sonnet-5-5", "claude-haiku-4.5": "claude-sonnet-5-5",
        "claude-opus-5": "claude-opus-5-5", "claude-opus-4-8": "claude-opus-5-5", "claude-opus-4-7": "claude-opus-5-5",
        "claude-opus-4.7": "claude-opus-5-5", "claude-opus-4.6": "claude-opus-5-5", "claude-opus-4.5": "claude-opus-5-5",
        "claude-opus-4-1": "claude-opus-5-5",
        "claude-fable-5-1": "claude-fable-5-2", "claude-fable-5": "claude-fable-5-2",
        "gemini-3.1-pro-preview": "gemini-4-neon", "grok-4.5": "grok-4.7",
        "fireworks-kimi-k2p7": "fireworks-deepseek-v4p1-flash", "fireworks-kimi-k2p6": "fireworks-deepseek-v4p1-flash",
        "fireworks-glm-5": "fireworks-deepseek-v4p1-flash", "fireworks-glm-5p1": "fireworks-deepseek-v4p1-flash",
        "fireworks-glm-5p2": "fireworks-deepseek-v4p1-flash", "fireworks-kimi-k3": "fireworks-kimi-k3p1-pro",
        "fireworks-minimax-m3": "gpt-6-luna", "fireworks-minimax-m2p7": "gpt-6-luna", "fireworks-minimax-m2p5": "gpt-6-luna",
        "fireworks-minimax-m2p1": "gpt-6-luna", "kimi-k2.5": "gpt-6-luna", "kimi-k2-thinking-turbo": "gpt-6-luna",
    ]

    static func model(_ id: String?) -> AIModel {
        let resolved = id.flatMap { raw in all.first { $0.id == raw } ?? aliases[raw].flatMap { alias in all.first { $0.id == alias } } }
        return resolved ?? all[0]
    }

    static func name(_ id: String?) -> String { model(id).name }
}

/// Whether the signed-in person can run a model, and on whose account.
/// The same rule as `deriveAgentBackend` on the server, which stays the authority.
struct ModelAccess: Equatable, Sendable {
    enum Source: Equatable, Sendable {
        case claudeSubscription, claudeKey, chatGPTPlan, ownKey, planCredits
    }

    var runnable: Bool
    var source: Source?
    var title: String
    var detail: String

    /// Runs on the person's own subscription or key rather than plan credits.
    var usesOwnAccount: Bool { source != nil && source != .planCredits }

    static func evaluate(_ model: AIModel, connections: Connections, tier: Tier) -> ModelAccess {
        let meetsTier = tier >= model.requiredTier
        let credits = ModelAccess(
            runnable: true,
            source: .planCredits,
            title: "Your plan's credits",
            detail: "Runs on Botflow's keys and counts against your \(tier.label) credits."
        )
        let needsPlan = ModelAccess(
            runnable: false,
            source: nil,
            title: "\(model.requiredTier.label) plan needed",
            detail: "Upgrade to \(model.requiredTier.label), or add your own \(model.provider.label) key in Settings to use it on any plan."
        )

        switch model.provider {
        case .anthropic:
            if connections.hasClaudeOAuth == true {
                return ModelAccess(runnable: true, source: .claudeSubscription, title: "Your Claude subscription", detail: "Runs in Claude Code on your Claude plan. No Botflow credits are used.")
            }
            if connections.hasAnthropicKey {
                return ModelAccess(runnable: true, source: .claudeKey, title: "Your Claude API key", detail: "Runs in Claude Code with your Anthropic key. No Botflow credits are used.")
            }
            if tier == .free {
                return ModelAccess(runnable: false, source: nil, title: "Connect Claude", detail: "Sign in with Claude or add an Anthropic key in Settings, or upgrade to run it on Botflow credits.")
            }
            return meetsTier ? credits : needsPlan
        case .openai:
            if connections.hasCodexOAuth == true {
                return ModelAccess(runnable: true, source: .chatGPTPlan, title: "Your ChatGPT plan", detail: "Runs on your ChatGPT subscription. No Botflow credits are used.")
            }
            if connections.hasOpenAIKey { return ownKey(model) }
        case .google:
            if connections.hasGoogleKey { return ownKey(model) }
        case .xai:
            if connections.hasXaiKey { return ownKey(model) }
        case .fireworks:
            if connections.hasFireworksKey { return ownKey(model) }
        }
        return meetsTier ? credits : needsPlan
    }

    private static func ownKey(_ model: AIModel) -> ModelAccess {
        ModelAccess(runnable: true, source: .ownKey, title: "Your \(model.provider.label) key", detail: "Runs with your own API key. No Botflow credits are used.")
    }
}
