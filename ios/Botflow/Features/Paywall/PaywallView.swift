import StoreKit
import SwiftUI

/// Plans and upgrade, paid through the App Store.
struct PaywallView: View {
    var reason: String?
    /// Shown inside Settings' navigation stack rather than as its own sheet.
    var embedded = false

    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var store: StoreManager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var billing: PlanOffer.Billing = .monthly
    @State private var restoring = false
    @State private var manageSubscription = false

    var body: some View {
        if embedded {
            content
                .navigationTitle("Subscription")
                .navigationBarTitleDisplayMode(.inline)
        } else {
            NavigationStack {
                content
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Close") { dismiss() }
                        }
                    }
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: Space.xl) {
                VStack(spacing: Space.s) {
                    Text("Build more with Botflow")
                        .font(.serif(36, relativeTo: .largeTitle))
                        .foregroundStyle(Sand.text)
                        .multilineTextAlignment(.center)
                    Text(reason.map { "\($0). Pick a plan to keep going." } ?? "More projects, premium models and native iOS apps.")
                        .font(.callout)
                        .foregroundStyle(Sand.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, embedded ? Space.s : 0)

                SegmentedTabs(
                    selection: $billing,
                    items: [.init(value: .monthly, title: "Monthly"), .init(value: .yearly, title: "Yearly · save 15%")]
                )
                .frame(maxWidth: 360)

                let layout = sizeClass == .regular ? AnyLayout(HStackLayout(alignment: .top, spacing: Space.l)) : AnyLayout(VStackLayout(spacing: Space.l))
                // Side by side they read Free → Pro → Max; stacked on a phone the
                // paid plans come first, since that is what this screen is for.
                let offers = sizeClass == .regular ? PlanOffer.all : PlanOffer.all.filter { $0.tier != .free } + PlanOffer.all.filter { $0.tier == .free }
                layout {
                    ForEach(offers) { offer in
                        PlanCard(offer: offer, billing: billing, current: session.tier == offer.tier) {
                            Task { await buy(offer) }
                        }
                    }
                }

                VStack(spacing: Space.m) {
                    HStack(spacing: Space.xl) {
                        Button {
                            Task { await restore() }
                        } label: {
                            if restoring { ProgressView() } else { Text("Restore purchases") }
                        }
                        if session.tier != .free {
                            Button("Manage subscription") { manageSubscription = true }
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Sand.muted)

                    Text("Plans renew automatically until cancelled and are billed to your Apple Account. Cancel any time in Settings, at least a day before renewal. Prices in the app include App Store fees. [Terms](https://botflow.io/terms) · [Privacy](https://botflow.io/privacy)")
                        .font(.footnote)
                        .foregroundStyle(Sand.subtle)
                        .tint(Sand.muted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 520)
                }
                .padding(.top, Space.s)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
            .frame(maxWidth: 1040)
            .frame(maxWidth: .infinity)
        }
        .background(Sand.canvas)
        .manageSubscriptionsSheet(isPresented: $manageSubscription)
        .task { if !store.loaded { await store.load() } }
    }

    private func buy(_ offer: PlanOffer) async {
        guard offer.tier != .free else { return }
        do {
            if AppConfig.isDemo {
                ToastCenter.shared.show("Purchases are off in demo mode", symbol: "info.circle.fill", tone: .neutral)
                return
            }
            guard let tier = try await store.purchase(offer, billing: billing, userId: session.user?.id) else { return }
            await session.loadAccount()
            Haptics.success()
            ToastCenter.shared.show("You're on \(tier.label). Thank you!", symbol: "sparkles")
            if !embedded { dismiss() }
        } catch {
            ToastCenter.shared.error(error)
        }
    }

    private func restore() async {
        restoring = true
        defer { restoring = false }
        do {
            try await store.restore()
            await session.loadAccount()
            ToastCenter.shared.show(session.tier == .free ? "No purchases to restore" : "Restored your \(session.tier.label) plan", symbol: "arrow.clockwise.circle.fill", tone: .neutral)
        } catch {
            ToastCenter.shared.error(error)
        }
    }
}

struct PlanCard: View {
    var offer: PlanOffer
    var billing: PlanOffer.Billing
    var current: Bool
    var action: () -> Void
    @EnvironmentObject private var store: StoreManager

    private var featured: Bool { offer.tier == .pro }
    private var purchasing: Bool { store.purchasing == offer.productId(billing) && store.purchasing != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack {
                Text(offer.name)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Sand.text)
                Spacer()
                if current {
                    Badge(text: "Your plan", symbol: "checkmark", tone: .success)
                } else if featured {
                    Badge(text: "Most popular", tone: .accent)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(store.displayPrice(offer, billing))
                    .font(.serif(44, relativeTo: .largeTitle))
                    .foregroundStyle(Sand.text)
                    .contentTransition(.numericText())
                if offer.tier != .free {
                    Text(billing == .monthly ? "/ month" : "/ year")
                        .font(.subheadline)
                        .foregroundStyle(Sand.subtle)
                }
            }
            .motion(.snappy, value: billing)
            Text(offer.tagline)
                .font(.subheadline)
                .foregroundStyle(Sand.muted)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 10) {
                ForEach(offer.features, id: \.self) { feature in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Image(systemName: "checkmark")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(featured ? Sand.accent : Sand.muted)
                        Text(feature)
                            .font(.subheadline)
                            .foregroundStyle(Sand.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            Spacer(minLength: 0)

            if offer.tier == .free {
                Text(current ? "You're on the Free plan" : "Included with every account")
                    .font(.subheadline)
                    .foregroundStyle(Sand.subtle)
                    .frame(maxWidth: .infinity, minHeight: 44)
            } else if current {
                Text("Active")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Sand.success)
                    .frame(maxWidth: .infinity, minHeight: 44)
            } else if featured {
                Button(action: action) {
                    HStack { if purchasing { ProgressView().tint(Sand.bg) }; Text("Get \(offer.name)") }
                }
                .buttonStyle(InkButtonStyle(fullWidth: true))
                .disabled(store.purchasing != nil)
                .accessibilityIdentifier("paywall.buy.\(offer.tier.rawValue)")
            } else {
                Button(action: action) {
                    HStack { if purchasing { ProgressView() }; Text("Get \(offer.name)") }
                }
                .buttonStyle(RaisedButtonStyle(fullWidth: true))
                .disabled(store.purchasing != nil)
                .accessibilityIdentifier("paywall.buy.\(offer.tier.rawValue)")
            }
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sand.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(featured ? Sand.accent.opacity(0.55) : Sand.border, lineWidth: featured ? 1.5 : 1)
        )
        .shadow(color: (featured ? Sand.accent : Sand.shadow).opacity(featured ? 0.12 : 0.05), radius: featured ? 22 : 10, y: featured ? 10 : 4)
    }
}
