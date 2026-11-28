import CryptoKit
import Foundation
import StoreKit

/// Botflow's plans as sold in the app. Prices are the website's plus 30%.
struct PlanOffer: Identifiable, Hashable {
    enum Billing: String, CaseIterable {
        case monthly, yearly

        var label: String { self == .monthly ? "Monthly" : "Yearly" }
    }

    var tier: Tier
    var name: String
    var tagline: String
    var features: [String]
    /// The website's price in cents; the app price is derived from it.
    var webMonthlyCents: Int
    var webYearlyCents: Int

    var id: String { tier.rawValue }

    static let markup = 1.30

    func productId(_ billing: Billing) -> String? {
        tier == .free ? nil : "io.botflow.\(tier.rawValue).\(billing.rawValue)"
    }

    /// The app price in dollars (web price × 1.3), used until the App Store's own price loads.
    func price(_ billing: Billing) -> Decimal {
        let cents = billing == .monthly ? webMonthlyCents : webYearlyCents
        return Decimal(Int((Double(cents) * Self.markup).rounded())) / 100
    }

    static let all: [PlanOffer] = [
        PlanOffer(
            tier: .free,
            name: "Free",
            tagline: "Build with your own Claude or ChatGPT plan, or your own keys.",
            features: ["3 active projects", "Free models with a monthly allowance", "Bring your Claude or ChatGPT plan", "One-tap publishing and GitHub sync"],
            webMonthlyCents: 0,
            webYearlyCents: 0
        ),
        PlanOffer(
            tier: .pro,
            name: "Pro",
            tagline: "Higher limits, premium models and native iOS apps.",
            features: ["20 active projects", "Monthly credits for Claude, GPT and Gemini", "Native iOS apps with the cloud simulator", "Custom domains"],
            webMonthlyCents: 2000,
            webYearlyCents: 20400
        ),
        PlanOffer(
            tier: .max,
            name: "Max",
            tagline: "The highest limits and every model.",
            features: ["Unlimited projects", "The largest monthly credits", "Claude Fable and GPT-6.2 Astra on credits", "Priority support"],
            webMonthlyCents: 6000,
            webYearlyCents: 60000
        ),
    ]

    static func offer(for tier: Tier) -> PlanOffer { all.first { $0.tier == tier } ?? all[0] }
}

/// In-app purchases through the App Store (StoreKit 2). A purchase is sent to
/// Botflow's server, which verifies it with Apple and updates the account.
@MainActor
final class StoreManager: ObservableObject {
    static let shared = StoreManager()

    @Published private(set) var products: [String: Product] = [:]
    @Published private(set) var purchasing: String?
    /// The product the App Store says this Apple ID currently subscribes to.
    @Published private(set) var activeProductId: String?
    @Published private(set) var loaded = false

    private var updates: Task<Void, Never>?

    init() {
        updates = Task { [weak self] in
            for await update in Transaction.updates {
                await self?.handle(update)
            }
        }
        Task { await load() }
    }

    deinit { updates?.cancel() }

    nonisolated static var productIds: [String] {
        PlanOffer.all.flatMap { offer in PlanOffer.Billing.allCases.compactMap { offer.productId($0) } }
    }

    func load() async {
        if let list = try? await Product.products(for: Self.productIds) {
            products = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        }
        loaded = true
        await refreshEntitlement()
    }

    func displayPrice(_ offer: PlanOffer, _ billing: PlanOffer.Billing) -> String {
        if offer.tier == .free { return "$0" }
        if let id = offer.productId(billing), let product = products[id] { return product.displayPrice }
        return offer.price(billing).formatted(.currency(code: "USD").precision(.fractionLength(offer.price(billing) == offer.price(billing).rounded ? 0 : 2)))
    }

    /// Returns the tier the server granted, or nil if the person backed out.
    /// The token attached to a purchase so only the account that bought it can
    /// claim it. Must match `appAccountTokenFor` on the server.
    nonisolated static func appAccountToken(userId: String) -> UUID? {
        let digest = SHA256.hash(data: Data("botflow-app-account:\(userId)".utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        func part(_ from: Int, _ to: Int) -> String {
            String(hex[hex.index(hex.startIndex, offsetBy: from)..<hex.index(hex.startIndex, offsetBy: to)])
        }
        let variant = String(format: "%02x", (UInt8(part(16, 18), radix: 16)! & 0x3f) | 0x80)
        return UUID(uuidString: "\(part(0, 8))-\(part(8, 12))-5\(part(13, 16))-\(variant)\(part(18, 20))-\(part(20, 32))")
    }

    func purchase(_ offer: PlanOffer, billing: PlanOffer.Billing, userId: String?) async throws -> Tier? {
        guard let id = offer.productId(billing) else { return nil }
        guard let product = products[id] else {
            throw APIError(status: 0, message: "The App Store isn't available right now. Try again in a moment.")
        }
        purchasing = id
        defer { purchasing = nil }
        var options: Set<Product.PurchaseOption> = []
        if let userId, let token = Self.appAccountToken(userId: userId) { options.insert(.appAccountToken(token)) }
        let result = try await product.purchase(options: options)
        switch result {
        case .success(let verification):
            let tier = await handle(verification)
            return tier ?? offer.tier
        case .pending:
            throw APIError(status: 0, message: "The purchase is waiting for approval. Your plan updates as soon as it's approved.")
        case .userCancelled:
            return nil
        @unknown default:
            return nil
        }
    }

    func restore() async throws {
        try await AppStore.sync()
        await refreshEntitlement(syncServer: true)
    }

    @discardableResult
    private func handle(_ verification: VerificationResult<Transaction>) async -> Tier? {
        guard case .verified(let transaction) = verification else { return nil }
        // Apple's signature is checked on the device and again on the server.
        let tier = try? await Services.shared.syncPurchase(signedTransaction: verification.jwsRepresentation)
        await transaction.finish()
        await refreshEntitlement()
        return tier
    }

    func refreshEntitlement(syncServer: Bool = false) async {
        var active: String?
        for await entitlement in Transaction.currentEntitlements {
            guard case .verified(let transaction) = entitlement, transaction.revocationDate == nil else { continue }
            active = transaction.productID
            if syncServer { _ = try? await Services.shared.syncPurchase(signedTransaction: entitlement.jwsRepresentation) }
        }
        activeProductId = active
    }
}

private extension Decimal {
    var rounded: Decimal {
        var value = self
        var result = Decimal()
        NSDecimalRound(&result, &value, 0, .plain)
        return result
    }
}
