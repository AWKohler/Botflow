import AuthenticationServices
import SwiftUI

/// The signed-out screen: what Botflow is, a glimpse of an agent at work, and
/// the ways in: Apple's native button, or Botflow's own sign-in page.
struct OnboardingView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.verticalSizeClass) private var verticalClass
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorScheme) private var colorScheme
    /// The raw nonce behind the Apple request in flight.
    @State private var appleNonce = ""

    var body: some View {
        GeometryReader { proxy in
            let wide = sizeClass == .regular && proxy.size.width > 700
            ZStack {
                OnboardingBackdrop()
                // Everything scrolls, so the buttons are always reachable at the
                // largest text sizes; at ordinary sizes it fills the screen exactly.
                ScrollView {
                    Group {
                        if wide {
                            HStack(spacing: 56) {
                                pitch(alignment: .leading)
                                    .frame(maxWidth: 420)
                                if !typeSize.isAccessibilitySize {
                                    AgentShowcase()
                                        .frame(maxWidth: 400)
                                }
                            }
                            .padding(48)
                            .frame(maxWidth: .infinity)
                        } else {
                            VStack(spacing: 0) {
                                header
                                Spacer(minLength: Space.l)
                                if verticalClass != .compact, proxy.size.height > 560, !typeSize.isAccessibilitySize {
                                    // A short screen (the Duo's cover) gets a shorter card.
                                    AgentShowcase(compact: proxy.size.height < 720)
                                        .frame(maxWidth: 380)
                                        .padding(.horizontal, Space.gutter)
                                    Spacer(minLength: Space.l)
                                }
                                VStack(spacing: Space.xl) {
                                    headline(alignment: .center)
                                    actions
                                }
                                .padding(.horizontal, Space.gutter)
                                .padding(.bottom, Space.l)
                            }
                            .frame(maxWidth: 520)
                            .frame(maxWidth: .infinity)
                        }
                    }
                    .frame(minHeight: proxy.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicators(.hidden)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            BotflowGlyph().frame(width: 30)
            Text("Botflow")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Sand.text)
            Spacer()
        }
        .padding(.horizontal, Space.gutter)
        .padding(.top, Space.m)
    }

    private func pitch(alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: Space.xxl) {
            HStack(spacing: 10) {
                BotflowGlyph().frame(width: 34)
                Text("Botflow").font(.title2.weight(.semibold)).foregroundStyle(Sand.text)
            }
            headline(alignment: alignment == .leading ? .leading : .center)
            actions
        }
    }

    private func headline(alignment: TextAlignment) -> some View {
        VStack(alignment: alignment == .leading ? .leading : .center, spacing: Space.m) {
            VStack(alignment: alignment == .leading ? .leading : .center, spacing: -8) {
                Text("Build apps by")
                Text("chatting with AI")
            }
            .font(.serif(46, relativeTo: .largeTitle))
            .foregroundStyle(Sand.text)
            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            .minimumScaleFactor(0.7)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Text("Web apps and native iOS apps, from idea to shipped. Start an agent here and it keeps working while you're away.")
                .font(.body)
                .foregroundStyle(Sand.muted)
                .multilineTextAlignment(alignment)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actions: some View {
        VStack(spacing: Space.m) {
            if let error = session.authError {
                ErrorBanner(message: error)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            SignInWithAppleButton(.continue) { request in
                let nonce = AuthManager.appleNonce()
                appleNonce = nonce.raw
                request.requestedScopes = [.fullName, .email]
                request.nonce = nonce.hashed
            } onCompletion: { result in
                let nonce = appleNonce
                Task { await session.signInWithApple(result, nonce: nonce) }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            // The button ignores style changes once drawn; rebuild it when the scheme flips.
            .id(colorScheme)
            .frame(height: ButtonSize.large.height)
            .clipShape(RoundedRectangle(cornerRadius: ButtonSize.large.radius, style: .continuous))
            .accessibilityIdentifier("onboarding.apple")

            Button {
                Task { await session.signIn(mode: .signUp) }
            } label: {
                HStack(spacing: Space.s) {
                    if session.isAuthenticating { ProgressView().tint(Sand.bg) }
                    Text("Create your account")
                }
            }
            .buttonStyle(InkButtonStyle(size: .large, fullWidth: true))
            .accessibilityIdentifier("onboarding.signUp")

            Button("I already have an account") {
                Task { await session.signIn(mode: .signIn) }
            }
            .buttonStyle(RaisedButtonStyle(size: .large, fullWidth: true))
            .accessibilityIdentifier("onboarding.signIn")

            Text("By continuing you agree to Botflow's [Terms](https://botflow.io/terms) and [Privacy Policy](https://botflow.io/privacy).")
                .font(.footnote)
                .foregroundStyle(Sand.subtle)
                .tint(Sand.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.xs)
        }
        .disabled(session.isAuthenticating)
        .motion(.snappy, value: session.authError)
    }
}

/// Warm canvas with a cobalt wash rising from the bottom and the website's
/// hatched margins down both edges.
struct OnboardingBackdrop: View {
    var body: some View {
        ZStack {
            Sand.canvas
            RadialGradient(
                colors: [Sand.accent.opacity(0.16), Sand.accent.opacity(0.05), .clear],
                center: UnitPoint(x: 0.85, y: 0.05),
                startRadius: 20,
                endRadius: 520
            )
            HStack {
                HatchPattern().frame(width: 12)
                Spacer()
                HatchPattern().frame(width: 12)
            }
            .opacity(0.7)
        }
        .ignoresSafeArea()
    }
}

/// A looping miniature of an agent building something: its steps arrive one
/// at a time, the way they do in the Dynamic Island.
struct AgentShowcase: View {
    private struct Line: Identifiable {
        let id: Int
        var symbol: String
        var verb: String
        var detail: String
    }

    private let script: [Line] = [
        Line(id: 0, symbol: "doc.text", verb: "Reading", detail: "src/App.tsx"),
        Line(id: 1, symbol: "pencil.line", verb: "Editing", detail: "components/Cart.tsx"),
        Line(id: 2, symbol: "cylinder.split.1x2", verb: "Deploying", detail: "the backend"),
        Line(id: 3, symbol: "terminal", verb: "Running", detail: "pnpm build"),
        Line(id: 4, symbol: "iphone", verb: "Building", detail: "for iPhone"),
        Line(id: 5, symbol: "checkmark.circle.fill", verb: "Finished", detail: "Ordering works end to end"),
    ]

    /// Fewer steps at a time, for short screens.
    var compact = false
    @State private var visible = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s) {
                StatusDot(status: visible >= script.count ? .idle : .running, unread: true, size: 8)
                Text("Add online ordering")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Sand.text)
                    .lineLimit(1)
                Spacer()
                Text("Claude Sonnet 5.5")
                    .font(.caption)
                    .foregroundStyle(Sand.subtle)
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)

            Divider().overlay(Sand.border)

            VStack(alignment: .leading, spacing: 11) {
                ForEach(script.prefix(visible).suffix(compact ? 3 : script.count)) { line in
                    let last = line.id == visible - 1
                    HStack(spacing: Space.m) {
                        Image(systemName: line.symbol)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(line.id == script.count - 1 ? Sand.success : last ? Sand.accent : Sand.subtle)
                            .frame(width: 18)
                        Text(line.verb)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(last ? Sand.text : Sand.muted)
                        Text(line.detail)
                            .codeFont(12.5)
                            .foregroundStyle(Sand.subtle)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                }
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, minHeight: compact ? 86 : 196, alignment: .topLeading)
        }
        .sandCard(radius: 22)
        .shadow(color: Sand.shadow.opacity(0.08), radius: 28, y: 14)
        .task {
            guard !reduceMotion else {
                visible = script.count
                return
            }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_150_000_000)
                if visible >= script.count {
                    try? await Task.sleep(nanoseconds: 2_400_000_000)
                    withMotion(.easeInOut(duration: 0.3)) { visible = 1 }
                } else {
                    withMotion(.spring(duration: 0.45)) { visible += 1 }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("An agent adding online ordering to an app, step by step")
    }
}
