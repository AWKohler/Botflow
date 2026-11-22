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

    var contextLabel: String { Self.compact(contextTokens) }

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
        AIModel(id: "fireworks-minimax-m3", name: "MiniMax-M3", provider: .fireworks, contextTokens: 196_600, costMultiplier: 1, requiredTier: .free, supportsImages: false),
        AIModel(id: "fireworks-kimi-k2p7", name: "Kimi K2.7", provider: .fireworks, contextTokens: 262_144, costMultiplier: 3, requiredTier: .free),
        AIModel(id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: .openai, contextTokens: 1_050_000, costMultiplier: 6, requiredTier: .pro),
        AIModel(id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: .anthropic, contextTokens: 200_000, personalContextTokens: 1_000_000, costMultiplier: 6, requiredTier: .pro),
        AIModel(id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", provider: .google, contextTokens: 1_000_000, costMultiplier: 6, requiredTier: .pro),
        AIModel(id: "grok-4.7", name: "Grok 4.7", provider: .xai, contextTokens: 500_000, costMultiplier: 7, requiredTier: .pro),
        AIModel(id: "fireworks-kimi-k3", name: "Kimi K3", provider: .fireworks, contextTokens: 1_000_000, costMultiplier: 9, requiredTier: .pro),
        AIModel(id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: .anthropic, contextTokens: 200_000, personalContextTokens: 1_000_000, costMultiplier: 11, requiredTier: .pro),
        AIModel(id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: .anthropic, contextTokens: 1_000_000, costMultiplier: 26, requiredTier: .max),
        AIModel(id: "gpt-6-astra", name: "GPT-6 Astra", provider: .openai, contextTokens: 1_050_000, costMultiplier: 31, requiredTier: .max),
    ]

    private static let aliases: [String: String] = [
        "gpt-6-sol": "gpt-6.1-sol", "gpt-5.6-sol": "gpt-6.1-sol", "gpt-5.6-terra": "gpt-6.1-sol",
        "gpt-5.6-luna": "gpt-6-luna", "claude-sonnet-5": "claude-sonnet-5-5", "claude-opus-5": "claude-opus-5-5",
        "claude-fable-5": "claude-fable-5-1", "grok-4.5": "grok-4.7",
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
            let kimiOnTogether = model.id == "fireworks-kimi-k2p7" && connections.useTogetherKimi == true
            if kimiOnTogether ? connections.hasTogetherKey : connections.hasFireworksKey { return ownKey(model) }
        }
        return meetsTier ? credits : needsPlan
    }

    private static func ownKey(_ model: AIModel) -> ModelAccess {
        ModelAccess(runnable: true, source: .ownKey, title: "Your \(model.provider.label) key", detail: "Runs with your own API key. No Botflow credits are used.")
    }
}
