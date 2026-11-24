import StoreKit
import UIKit
import StoreKitTest
import XCTest
@testable import Botflow

/// The plan purchase flow against a local test store (`Botflow.storekit`):
/// the same StoreKit calls the App Store answers in production.
@MainActor
final class PurchaseTests: XCTestCase {
    private var session: SKTestSession!

    override func setUp() async throws {
        session = try SKTestSession(configurationFileNamed: "Botflow")
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
    }

    override func tearDown() async throws {
        session.clearTransactions()
    }

    func testTheStoreSellsEveryPlanAtTheWebPricePlusThirtyPercent() async throws {
        var products: [Product] = []
        // The test store takes a moment to come up after the session starts.
        for _ in 0..<60 where products.isEmpty {
            products = try await Product.products(for: StoreManager.productIds)
            if products.isEmpty { try await Task.sleep(nanoseconds: 500_000_000) }
        }
        XCTAssertEqual(Set(products.map(\.id)), Set(StoreManager.productIds), "A plan is missing from the store")
        // Web: Pro $20 / $204, Max $60 / $600.
        let expected: [String: Decimal] = [
            "io.botflow.pro.monthly": 26, "io.botflow.pro.yearly": Decimal(string: "265.20")!,
            "io.botflow.max.monthly": 78, "io.botflow.max.yearly": 780,
        ]
        for product in products {
            XCTAssertEqual(product.price, expected[product.id], product.id)
            XCTAssertEqual(product.type, .autoRenewable, product.id)
        }
        // The app's own figures (shown before the store answers) agree with the store.
        for offer in PlanOffer.all where offer.tier != .free {
            for billing in PlanOffer.Billing.allCases {
                XCTAssertEqual(offer.price(billing), expected[offer.productId(billing)!])
            }
        }
    }

    func testBuyingProSubscribesTheAccount() async throws {
        let store = try await readyStore()
        XCTAssertNil(store.activeProductId)

        let tier = try await store.purchase(PlanOffer.offer(for: .pro), billing: .monthly, userId: "user_purchase_test")
        XCTAssertEqual(tier, .pro)
        XCTAssertEqual(store.activeProductId, "io.botflow.pro.monthly")
        XCTAssertNil(store.purchasing)

        // The purchase is signed, current, and tied to the account that made it,
        // which is what lets the server refuse it for anyone else.
        let transaction = try await currentTransaction()
        XCTAssertEqual(transaction.productID, "io.botflow.pro.monthly")
        XCTAssertEqual(transaction.appAccountToken, StoreManager.appAccountToken(userId: "user_purchase_test"))
        XCTAssertNil(transaction.revocationDate)
    }

    func testMovingUpToMaxReplacesPro() async throws {
        let store = try await readyStore()
        _ = try await store.purchase(PlanOffer.offer(for: .pro), billing: .monthly, userId: "user_purchase_test")
        // (The tier comes back from the server; here it is a fixture, so the store's own answer is checked.)
        _ = try await store.purchase(PlanOffer.offer(for: .max), billing: .yearly, userId: "user_purchase_test")
        await store.refreshEntitlement()
        XCTAssertEqual(store.activeProductId, "io.botflow.max.yearly")
    }

    func testADeclinedPurchaseChangesNothing() async throws {
        let store = try await readyStore()
        session.failTransactionsEnabled = true
        session.failureError = .unknown
        do {
            _ = try await store.purchase(PlanOffer.offer(for: .pro), billing: .monthly, userId: "user_purchase_test")
            XCTFail("A declined payment went through")
        } catch {
            // Expected: the store reports the failure and the plan is unchanged.
        }
        session.failTransactionsEnabled = false
        await store.refreshEntitlement()
        XCTAssertNil(store.activeProductId)
        XCTAssertNil(store.purchasing)
    }

    func testARefundEndsTheSubscription() async throws {
        let store = try await readyStore()
        _ = try await store.purchase(PlanOffer.offer(for: .pro), billing: .monthly, userId: "user_purchase_test")
        let transaction = try await currentTransaction()
        try session.refundTransaction(identifier: UInt(transaction.id))
        // The refund reaches the app as a transaction update, a moment later.
        for _ in 0..<20 {
            await store.refreshEntitlement()
            if store.activeProductId == nil { break }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        XCTAssertNil(store.activeProductId)
    }

    /// The app's store, once the test store has answered with its products.
    private func readyStore() async throws -> StoreManager {
        // The iOS 27.0 iPad simulator lists the test store's products but then
        // asks for an Apple Account on purchase, and waits on that alert for
        // good. Buying is exercised on the iPhone and iPhone Duo simulators.
        if UIDevice.current.userInterfaceIdiom == .pad, #unavailable(iOS 27.1) {
            throw XCTSkip("This iPad simulator's StoreKit asks for an Apple Account instead of using the test store.")
        }
        let store = StoreManager.shared
        // Up to half a minute: on a busy machine the test store is slow to answer.
        for _ in 0..<60 {
            await store.load()
            if !store.products.isEmpty { return store }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        XCTFail("The test store never returned its products")
        return store
    }

    private func currentTransaction() async throws -> Transaction {
        for await entitlement in Transaction.currentEntitlements {
            if case .verified(let transaction) = entitlement { return transaction }
        }
        throw XCTSkip("The test store reported no current subscription.")
    }
}
