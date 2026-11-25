import SwiftUI

/// How a folding device (iPhone Duo) is being held.
enum HingePosture: String, Equatable {
    /// Folded shut: the app is on the cover screen.
    case closed
    /// Propped half open, like a book or a small laptop.
    case partiallyOpen
    /// Open flat: one large screen.
    case fullyOpen
}

/// The fold state, for layouts that should follow the crease. `nil` on
/// devices without a hinge.
@MainActor
final class DeviceHingeModel: ObservableObject {
    @Published var posture: HingePosture?
    /// The whole window, bars and system rail included.
    @Published var windowSize: CGSize = .zero

    /// Where the crease runs down the window, when there is one to respect:
    /// an unfolded Duo held upright is wider than tall, with the crease in
    /// the middle. `nil` on every other device and posture.
    var creaseX: CGFloat? {
        guard let posture, posture != .closed, windowSize.width > windowSize.height, windowSize.width >= 560 else { return nil }
        return windowSize.width / 2
    }
    /// A posture forced for tests; the real hinge is ignored while it is set.
    private(set) var isForced = false

    init() {
        #if DEBUG
        // The simulator's fold control is not scriptable, so tests can force a
        // posture: `-BotflowDebugHinge partiallyOpen`.
        if let forced = UserDefaults.standard.string(forKey: "BotflowDebugHinge"), let value = HingePosture(rawValue: forced) {
            posture = value
            isForced = true
        }
        #endif
    }
}

private struct HingeObserver: ViewModifier {
    @ObservedObject var model: DeviceHingeModel

    func body(content: Content) -> some View {
        measured(content)
    }

    @ViewBuilder
    private func tracked(_ content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, context in
                guard !model.isForced else { return }
                guard let hinge = context.hinge else {
                    model.posture = nil
                    return
                }
                let posture: HingePosture = hinge.status == .closed ? .closed : hinge.status == .partiallyOpen ? .partiallyOpen : .fullyOpen
                if model.posture != posture {
                    withMotion(.smooth(duration: 0.35)) { model.posture = posture }
                }
            }
        } else {
            content
        }
    }
}

extension HingeObserver {
    /// The window's full size, measured behind everything and past the safe area.
    fileprivate func measured(_ content: Content) -> some View {
        // The safe area's insets are added back by hand: on the Duo the
        // system's side rail is one of them, and the crease is the middle of
        // the whole screen, rail included.
        tracked(content).background {
            GeometryReader { proxy in
                let insets = proxy.safeAreaInsets
                let size = CGSize(
                    width: proxy.size.width + insets.leading + insets.trailing,
                    height: proxy.size.height + insets.top + insets.bottom
                )
                Color.clear
                    .onAppear { model.windowSize = size }
                    .onChange(of: size) { _, value in model.windowSize = value }
            }
        }
    }
}

/// A grid that, on an unfolded Duo, has exactly two columns with the gap
/// between them on the crease, so no card is split by the fold. Everywhere
/// else it is the grid it was given.
struct FoldAwareGrid<Content: View>: View {
    var columns: [GridItem]
    var alignment: HorizontalAlignment = .center
    var spacing: CGFloat
    @ViewBuilder var content: () -> Content
    @EnvironmentObject private var hinge: DeviceHingeModel
    @State private var frame: CGRect = .zero

    var body: some View {
        let widths = halves
        LazyVGrid(columns: widths.map { [GridItem(.fixed($0.left), spacing: spacing, alignment: .top), GridItem(.fixed($0.right), spacing: spacing, alignment: .top)] } ?? columns, alignment: alignment, spacing: spacing, content: content)
            // The system's rail narrows the far half, so the two columns differ
            // in width; covers take one height so each row still lines up.
            .environment(\.cardCoverHeight, widths.map { max($0.left, $0.right) * 9.5 / 16 })
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
    }

    /// The width of the column on each side of the crease, when there is one.
    private var halves: (left: CGFloat, right: CGFloat)? {
        guard let crease = hinge.creaseX, frame.width > 0 else { return nil }
        // Each column runs from its edge of the grid to half a gap short of the crease.
        let left = crease - spacing / 2 - frame.minX
        let right = frame.maxX - (crease + spacing / 2)
        guard left >= 200, right >= 200 else { return nil }
        return (left, right)
    }
}

private struct CardCoverHeightKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}

extension EnvironmentValues {
    /// A fixed height for card covers in a grid whose columns differ in width.
    var cardCoverHeight: CGFloat? {
        get { self[CardCoverHeightKey.self] }
        set { self[CardCoverHeightKey.self] = newValue }
    }
}

extension View {
    /// A card's cover: 16 to 9.5, unless the grid has set one height for all.
    @ViewBuilder
    func cardCover(height: CGFloat?) -> some View {
        if let height {
            frame(maxWidth: .infinity).frame(height: height)
        } else {
            aspectRatio(16 / 9.5, contentMode: .fit)
        }
    }
}

extension View {
    /// Keep `model` in step with the device's hinge.
    func observingHinge(_ model: DeviceHingeModel) -> some View {
        modifier(HingeObserver(model: model))
    }
}
