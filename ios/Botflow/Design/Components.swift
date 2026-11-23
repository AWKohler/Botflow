import SwiftUI
import UIKit

// MARK: - Haptics

enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func soft() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    static func firm() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func select() { UISelectionFeedbackGenerator().selectionChanged() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

// MARK: - Buttons

enum ButtonSize {
    case small, regular, large

    /// Small controls are 38 points tall and accept touches 3 points beyond
    /// each edge, so every control has at least a 44-point target.
    var height: CGFloat { self == .small ? 38 : self == .regular ? 44 : 52 }
    var hitSlop: CGFloat { self == .small ? 3 : 0 }
    var font: Font {
        switch self {
        case .small: return .subheadline.weight(.medium)
        case .regular: return .body.weight(.medium)
        case .large: return .body.weight(.semibold)
        }
    }
    var padding: CGFloat { self == .small ? 14 : self == .regular ? 18 : 22 }
    var radius: CGFloat { self == .small ? 10 : self == .regular ? 12 : 14 }
}

/// The main action of a view. Ink on sand, lit from above: a hairline of light
/// inside the top edge and of shade inside the bottom, as on the website.
struct InkButtonStyle: ButtonStyle {
    var size: ButtonSize = .regular
    var fullWidth = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: size.radius, style: .continuous)
        configuration.label
            .font(size.font)
            .foregroundStyle(Sand.bg)
            .padding(.horizontal, size.padding)
            .frame(minHeight: size.height)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background {
                shape.fill(Sand.text)
                shape.fill(LinearGradient(colors: [.white.opacity(scheme == .dark ? 0.0 : 0.1), .clear], startPoint: .top, endPoint: .center))
                shape.strokeBorder(
                    LinearGradient(
                        colors: [.white.opacity(scheme == .dark ? 0.7 : 0.22), .clear, .black.opacity(scheme == .dark ? 0.14 : 0.28)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1
                )
            }
            .shadow(color: Sand.shadow.opacity(enabled ? 0.14 : 0), radius: 2, y: 1)
            .opacity(enabled ? (configuration.isPressed ? 0.82 : 1) : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
            .contentShape(shape.inset(by: -size.hitSlop))
            .hoverEffect(.highlight)
    }
}

/// A peer action next to a primary one: a raised neutral surface.
struct RaisedButtonStyle: ButtonStyle {
    var size: ButtonSize = .regular
    var fullWidth = false
    var tint: Color = Sand.text
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: size.radius, style: .continuous)
        configuration.label
            .font(size.font)
            .foregroundStyle(tint)
            .padding(.horizontal, size.padding)
            .frame(minHeight: size.height)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background {
                shape.fill(configuration.isPressed ? Sand.elevated : Sand.card)
                shape.strokeBorder(Sand.border, lineWidth: 1)
            }
            .shadow(color: Sand.shadow.opacity(enabled ? 0.06 : 0), radius: 1.5, y: 1)
            .opacity(enabled ? 1 : 0.5)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
            .contentShape(shape.inset(by: -size.hitSlop))
            .hoverEffect(.highlight)
    }
}

/// Low-emphasis actions: text only, with a wash while pressed.
struct GhostButtonStyle: ButtonStyle {
    var size: ButtonSize = .regular
    var tint: Color = Sand.muted

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(size.font)
            .foregroundStyle(tint)
            .padding(.horizontal, size.padding - 6)
            .frame(minHeight: size.height)
            .background(configuration.isPressed ? Sand.elevated : .clear, in: RoundedRectangle(cornerRadius: size.radius, style: .continuous))
            .contentShape(Rectangle().inset(by: -size.hitSlop))
            .hoverEffect(.highlight)
    }
}

/// A round icon button on a raised surface (toolbar and composer controls).
struct CircleIconButtonStyle: ButtonStyle {
    var diameter: CGFloat = 40
    var filled = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: diameter * 0.42, weight: .semibold))
            .foregroundStyle(filled ? Sand.bg : Sand.text)
            .frame(width: diameter, height: diameter)
            .background {
                Circle().fill(filled ? Sand.text : Sand.card)
                if !filled { Circle().strokeBorder(Sand.border, lineWidth: 1) }
            }
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
            .contentShape(Circle().inset(by: -max(4, (44 - diameter) / 2)))
            .hoverEffect(.highlight)
    }
}

/// A press that only dims and settles: for whole cards and rows.
struct PressableStyle: ButtonStyle {
    var scale: CGFloat = 0.98
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

// MARK: - Surfaces

struct SandCard: ViewModifier {
    var radius: CGFloat = Radius.card
    var padding: CGFloat = 0
    var elevated = true

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Sand.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
            .shadow(color: Sand.shadow.opacity(elevated ? 0.05 : 0), radius: 8, y: 3)
    }
}

extension View {
    func sandCard(radius: CGFloat = Radius.card, padding: CGFloat = 0, elevated: Bool = true) -> some View {
        modifier(SandCard(radius: radius, padding: padding, elevated: elevated))
    }

    /// The warm canvas behind a screen.
    func sandCanvas() -> some View {
        background(Sand.canvas.ignoresSafeArea())
    }
}

// MARK: - Badges and dots

enum Tone {
    case neutral, accent, success, warning, danger

    var foreground: Color {
        switch self {
        case .neutral: return Sand.muted
        case .accent: return Sand.accent
        case .success: return Sand.success
        case .warning: return Sand.warning
        case .danger: return Sand.danger
        }
    }

    var background: Color {
        switch self {
        case .neutral: return Sand.elevated
        case .accent: return Sand.accentSoft
        case .success: return Sand.successSoft
        case .warning: return Sand.warningSoft
        case .danger: return Sand.dangerSoft
        }
    }
}

struct Badge: View {
    var text: String
    var symbol: String?
    var tone: Tone = .neutral

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(text)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(tone.background, in: Capsule())
        .overlay(Capsule().strokeBorder(tone.foreground.opacity(0.22), lineWidth: 1))
    }
}

/// The agent status dot: pulsing cobalt while running, amber when it needs
/// you, red on an error, green when it finished and has not been read.
struct StatusDot: View {
    var status: ThreadStatus
    var unread = false
    var size: CGFloat = 9
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var color: Color? {
        switch status {
        case .running: return Sand.accent
        case .needsInput: return Sand.warningSolid
        case .error: return Sand.dangerSolid
        case .idle: return unread ? Sand.successSolid : nil
        }
    }

    var body: some View {
        ZStack {
            if let color {
                if status == .running, !reduceMotion {
                    Circle()
                        .fill(color.opacity(0.35))
                        .frame(width: size, height: size)
                        .scaleEffect(pulse ? 2.4 : 1)
                        .opacity(pulse ? 0 : 0.9)
                        .onAppear {
                            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { pulse = true }
                        }
                }
                Circle().fill(color).frame(width: size, height: size)
            } else {
                Circle().strokeBorder(Sand.borderStrong, lineWidth: 1.5).frame(width: size, height: size)
            }
        }
        .frame(width: size * 2, height: size * 2)
        .accessibilityLabel(label)
    }

    private var label: String {
        switch status {
        case .running: return "Running"
        case .needsInput: return "Needs your input"
        case .error: return "Stopped with an error"
        case .idle: return unread ? "Finished, unread" : "Idle"
        }
    }
}

extension ThreadStatus {
    var label: String {
        switch self {
        case .running: return "Running"
        case .needsInput: return "Needs input"
        case .error: return "Error"
        case .idle: return "Idle"
        }
    }

    var tone: Tone {
        switch self {
        case .running: return .accent
        case .needsInput: return .warning
        case .error: return .danger
        case .idle: return .neutral
        }
    }
}

// MARK: - Segmented control

/// The website's segmented tabs: a soft track with one raised segment that
/// slides between choices.
struct SegmentedTabs<Value: Hashable>: View {
    struct Item: Identifiable {
        var value: Value
        var title: String
        var symbol: String?
        var id: String { title }
    }

    @Binding var selection: Value
    var items: [Item]
    var compact = false
    @Namespace private var namespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items) { item in
                let selected = item.value == selection
                Button {
                    guard !selected else { return }
                    Haptics.select()
                    // With Reduce Motion the selection changes in place instead of sliding.
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { selection = item.value }
                } label: {
                    HStack(spacing: 5) {
                        if let symbol = item.symbol { Image(systemName: symbol).imageScale(.small) }
                        Text(item.title)
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(selected ? Sand.text : Sand.muted)
                    .lineLimit(1)
                    .padding(.horizontal, compact ? 12 : 16)
                    // 38 + the track's 3-point padding either side: a 44-point target.
                    .frame(maxWidth: compact ? nil : .infinity, minHeight: 38)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .fill(Sand.raised)
                                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Sand.borderStrong.opacity(0.6), lineWidth: 1))
                                .shadow(color: Sand.shadow.opacity(0.1), radius: 1.5, y: 1)
                                .matchedGeometryEffect(id: "segment", in: namespace)
                        }
                    }
                    .contentShape(Rectangle().inset(by: -3))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Sand.elevated, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
    }
}

// MARK: - Avatars

struct AvatarView: View {
    var initials: String
    var imageURL: String?
    var size: CGFloat = 32

    var body: some View {
        ZStack {
            Circle().fill(Sand.elevated)
            Text(initials)
                .font(.system(size: size * 0.38, weight: .semibold))
                .foregroundStyle(Sand.text)
            if let imageURL, let url = URL(string: imageURL.hasPrefix("/") ? AppConfig.origin + imageURL : imageURL) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: { Color.clear }
                .clipShape(Circle())
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().strokeBorder(Sand.border, lineWidth: 1))
    }
}

// MARK: - Decoration

/// The diagonal hatch from the website's page margins.
struct HatchPattern: View {
    var spacing: CGFloat = 7
    var color: Color = Sand.borderStrong.opacity(0.55)

    var body: some View {
        Canvas { context, size in
            var path = Path()
            var x: CGFloat = -size.height
            while x < size.width {
                path.move(to: CGPoint(x: x, y: size.height))
                path.addLine(to: CGPoint(x: x + size.height, y: 0))
                x += spacing
            }
            context.stroke(path, with: .color(color), lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}

/// A light sweep across text while the agent works.
struct Shimmer: ViewModifier {
    var active: Bool
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if active, !reduceMotion {
            content
                .overlay {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, Sand.bg.opacity(0.75), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: proxy.size.width * 0.5)
                            .offset(x: phase * proxy.size.width * 1.5)
                            .blendMode(.sourceAtop)
                    }
                }
                .compositingGroup()
                .onAppear {
                    withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 1 }
                }
        } else {
            content
        }
    }
}

extension View {
    func shimmer(_ active: Bool = true) -> some View { modifier(Shimmer(active: active)) }
}

// MARK: - States

struct EmptyState: View {
    var symbol: String
    var title: String
    var message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: Space.m) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(Sand.subtle)
                .frame(width: 60, height: 60)
                .background(Sand.elevated, in: Circle())
                .overlay(Circle().strokeBorder(Sand.border, lineWidth: 1))
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Sand.text)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Sand.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(InkButtonStyle())
                    .padding(.top, Space.s)
            }
        }
        .frame(maxWidth: 320)
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ErrorBanner: View {
    var message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Sand.danger)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Sand.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let retry {
                Button("Retry", action: retry)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Sand.danger)
            }
        }
        .padding(Space.m)
        .background(Sand.dangerSoft, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Sand.danger.opacity(0.25), lineWidth: 1))
    }
}

/// A thin usage meter.
struct Meter: View {
    var fraction: Double
    var tint: Color = Sand.text
    var height: CGFloat = 5

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Sand.soft)
                Capsule().fill(tint).frame(width: max(height, proxy.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: height)
        .accessibilityValue("\(Int(fraction * 100)) percent")
    }
}

// MARK: - Toasts

@MainActor
final class ToastCenter: ObservableObject {
    struct Toast: Identifiable, Equatable {
        let id = UUID()
        var title: String
        var symbol: String
        var tone: Tone
    }

    static let shared = ToastCenter()
    @Published var current: Toast?
    private var dismissTask: Task<Void, Never>?

    func show(_ title: String, symbol: String = "checkmark.circle.fill", tone: Tone = .success) {
        dismissTask?.cancel()
        withAnimation(.spring(duration: 0.4)) { current = Toast(title: title, symbol: symbol, tone: tone) }
        dismissTask = Task {
            try? await Task.sleep(nanoseconds: 2_800_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.25)) { current = nil }
        }
    }

    func error(_ error: Error) {
        Haptics.error()
        show(error.localizedDescription, symbol: "exclamationmark.triangle.fill", tone: .danger)
    }
}

struct ToastOverlay: View {
    @ObservedObject var center = ToastCenter.shared

    var body: some View {
        VStack {
            if let toast = center.current {
                HStack(spacing: Space.s) {
                    Image(systemName: toast.symbol).foregroundStyle(toast.tone.foreground)
                    Text(toast.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Sand.text)
                        .lineLimit(3)
                }
                .padding(.horizontal, Space.l)
                .padding(.vertical, Space.m)
                .glassEffect(.regular, in: .capsule)
                .shadow(color: Sand.shadow.opacity(0.12), radius: 16, y: 6)
                .padding(.horizontal, Space.gutter)
                .transition(.move(edge: .top).combined(with: .opacity))
                .onTapGesture { withAnimation { center.current = nil } }
                .accessibilityAddTraits(.isStaticText)
            }
            Spacer()
        }
        .padding(.top, Space.s)
        .allowsHitTesting(center.current != nil)
    }
}

// MARK: - Relative time

enum RelativeTime {
    static func short(_ date: Date?) -> String {
        guard let date else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        if seconds < 86_400 * 7 { return "\(seconds / 86_400)d" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
