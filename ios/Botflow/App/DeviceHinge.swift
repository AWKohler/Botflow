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

    init() {
        #if DEBUG
        // The simulator's fold control is not scriptable, so tests can force a
        // posture: `-BotflowDebugHinge partiallyOpen`.
        if let forced = UserDefaults.standard.string(forKey: "BotflowDebugHinge") {
            posture = HingePosture(rawValue: forced)
        }
        #endif
    }
}

private struct HingeObserver: ViewModifier {
    @ObservedObject var model: DeviceHingeModel

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, context in
                guard let hinge = context.hinge else {
                    model.posture = nil
                    return
                }
                let posture: HingePosture = hinge.status == .closed ? .closed : hinge.status == .partiallyOpen ? .partiallyOpen : .fullyOpen
                if model.posture != posture {
                    withAnimation(.smooth(duration: 0.35)) { model.posture = posture }
                }
            }
        } else {
            content
        }
    }
}

extension View {
    /// Keep `model` in step with the device's hinge.
    func observingHinge(_ model: DeviceHingeModel) -> some View {
        modifier(HingeObserver(model: model))
    }
}
