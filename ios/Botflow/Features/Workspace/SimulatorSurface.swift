import AVFoundation
import SwiftUI
import UIKit

/// The simulated screen: draws the video and turns touches on it into touches
/// in the simulator.
///
/// The simulator host replays whole gestures, not a stream of finger
/// positions: a tap, or a swipe from A to B that it performs at a fixed speed
/// and then lets go of. Measured against a real session, that means every
/// replayed swipe coasts 300 to 500 points further than it was dragged, and a
/// press held in place cannot be sent at all.
/// This view maps a real finger onto that as faithfully as it can:
///
/// - **Tap:** sent when the finger lifts, with a ripple where it landed.
/// - **Flick:** replayed exactly, start to end; the simulator's coast is the
///   momentum a real flick would have.
/// - **Drag that stops before lifting:** a scroll meant to end *there*, so the
///   replayed swipe is shortened by the coast it will pick up.
/// - **Sideways drag:** always replayed exactly (paging, row actions, back).
/// - **Trackpad or mouse wheel (iPad):** one scroll per gesture.
///
/// While a finger is dragging, the picture gives a little under it and a
/// trail follows it, so the gesture is visibly registering before the
/// simulator has had a chance to answer.
final class SimulatorSurfaceView: UIView, UIKeyInput {
    weak var controller: SimulatorController?
    var landscape = false { didSet { if landscape != oldValue { setNeedsLayout() } } }
    /// Shorten scrolls to allow for the simulator's coast. Off: every drag is
    /// replayed exactly as drawn.
    var liveScroll = true
    var interactive = false {
        didSet {
            guard interactive != oldValue else { return }
            accessibilityTraits = interactive ? [.allowsDirectInteraction] : [.image]
            if !interactive { cancelGesture() }
        }
    }

    private enum Gesture {
        case none
        /// Finger down, not yet moved.
        case pending
        case dragging
    }

    private let videoLayer: AVSampleBufferDisplayLayer
    private var gesture: Gesture = .none
    private var touchStart: CGPoint = .zero
    private var lastPoint: CGPoint = .zero
    private var lastMovedAt: TimeInterval = 0
    private var trail: CAShapeLayer?
    private var trailPath = UIBezierPath()
    private var wheelPending: CGPoint = .zero
    /// How far the picture is nudged under a dragging finger.
    private var give: CGPoint = .zero

    /// The shortest swipe the simulator still reads as a drag, not a tap.
    static let shortestDrag: CGFloat = 30
    private var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    /// How far the simulator carries a replayed swipe on after it lets go, in
    /// simulated points. Measured on a live session: a 30-point swipe moved a
    /// list 350 points in all and a 242-point swipe 748, so the coast grows
    /// with the swipe and levels off near 500.
    static func coast(afterSwipeOf length: CGFloat) -> CGFloat {
        min(500, 320 + 0.85 * max(0, length - shortestDrag))
    }

    /// The length to replay for a scroll of `intended` simulated points that
    /// should stop where the finger stopped: the swipe whose length plus its
    /// coast comes to that. Anything under about 350 points gets the shortest
    /// drag there is, which is the least this simulator can scroll.
    static func replayLength(forSettledScroll intended: CGFloat) -> CGFloat {
        let knee = shortestDrag + (500 - 320) / 0.85   // where the coast levels off
        if intended >= knee + 500 { return intended - 500 }
        return max(shortestDrag, (intended - 320 + 0.85 * shortestDrag) / 1.85)
    }

    init(layer: AVSampleBufferDisplayLayer) {
        videoLayer = layer
        super.init(frame: .zero)
        backgroundColor = .black
        clipsToBounds = true
        isAccessibilityElement = true
        accessibilityLabel = "Simulator screen"
        accessibilityHint = "Shows your app running. Touches pass straight through to it."
        accessibilityTraits = [.image]
        attachVideoLayer()
        // A trackpad or mouse wheel on iPad scrolls the simulator.
        let wheel = UIPanGestureRecognizer(target: self, action: #selector(wheelScrolled(_:)))
        wheel.allowedScrollTypesMask = .all
        wheel.allowedTouchTypes = []
        addGestureRecognizer(wheel)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// The video layer is shared with the full-screen presentation; whichever
    /// surface is on screen takes it.
    func attachVideoLayer() {
        if videoLayer.superlayer !== layer {
            layer.insertSublayer(videoLayer, at: 0)
            setNeedsLayout()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { attachVideoLayer() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard videoLayer.superlayer === layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        placeVideo()
        CATransaction.commit()
    }

    private func placeVideo() {
        videoLayer.setAffineTransform(.identity)
        if landscape {
            // The stream is the portrait surface; turn it a quarter turn counter-clockwise.
            videoLayer.bounds = CGRect(x: 0, y: 0, width: bounds.height, height: bounds.width)
            videoLayer.position = CGPoint(x: bounds.midX + give.x, y: bounds.midY + give.y)
            videoLayer.setAffineTransform(CGAffineTransform(rotationAngle: -.pi / 2))
        } else {
            videoLayer.bounds = CGRect(origin: .zero, size: bounds.size)
            videoLayer.position = CGPoint(x: bounds.midX + give.x, y: bounds.midY + give.y)
        }
    }

    private func normalised(_ point: CGPoint) -> (Double, Double) {
        (Double(point.x / max(1, bounds.width)), Double(point.y / max(1, bounds.height)))
    }

    /// Simulated points per point on this view.
    private var simulatedScale: CGFloat {
        (controller?.logicalSize.width ?? bounds.width) / max(1, bounds.width)
    }

    // MARK: Touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let touch = touches.first, event?.allTouches?.count == 1 else { return }
        let point = touch.location(in: self)
        gesture = .pending
        touchStart = point
        lastPoint = point
        lastMovedAt = touch.timestamp
        trailPath = UIBezierPath()
        trailPath.move(to: point)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, gesture != .none, let touch = touches.first, event?.allTouches?.count == 1 else { return }
        let point = touch.location(in: self)
        let dx = point.x - touchStart.x, dy = point.y - touchStart.y
        if gesture == .pending, hypot(dx, dy) > 8 { gesture = .dragging }
        guard gesture == .dragging else { return }

        if hypot(point.x - lastPoint.x, point.y - lastPoint.y) > 0.5 { lastMovedAt = touch.timestamp }
        lastPoint = point
        trailPath.addLine(to: point)
        showTrail()
        // The picture gives a little under the finger, easing off the further it goes.
        if !reduceMotion {
            // Along the drag's own axis only, so the picture never slides sideways under a scroll.
            let vertical = abs(dy) >= abs(dx)
            setGive(CGPoint(x: vertical ? 0 : Self.eased(dx), y: vertical ? Self.eased(dy) : 0), animated: false)
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let touch = touches.first else { return }
        let end = touch.location(in: self)
        switch gesture {
        case .pending where hypot(end.x - touchStart.x, end.y - touchStart.y) <= 8:
            let point = normalised(end)
            controller?.tap(x: point.0, y: point.1)
            ripple(at: end)
            UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.6)
        case .pending, .dragging:
            // (A flick can be over before a single move is reported.)
            let dx = end.x - touchStart.x, dy = end.y - touchStart.y
            if hypot(dx, dy) >= 6 {
                let settled = touch.timestamp - lastMovedAt > 0.12
                let target = Self.replayTarget(
                    from: touchStart, to: end, settled: settled, compensating: liveScroll, simulatedScale: simulatedScale
                )
                send(from: touchStart, to: target)
            }
        case .none:
            break
        }
        gesture = .none
        fadeTrail()
        setGive(.zero, animated: true)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        cancelGesture()
    }

    /// Where the replayed swipe should end. A vertical drag whose finger had
    /// stopped is shortened by the coast the simulator will add; everything
    /// else is replayed as drawn.
    static func replayTarget(from start: CGPoint, to end: CGPoint, settled: Bool, compensating: Bool, simulatedScale: CGFloat) -> CGPoint {
        let dx = end.x - start.x, dy = end.y - start.y
        guard compensating, settled, abs(dy) > abs(dx) * 1.2 else { return end }
        let intended = abs(dy) * simulatedScale
        let ratio = replayLength(forSettledScroll: intended) / max(1, intended)
        return CGPoint(x: start.x + dx * ratio, y: start.y + dy * ratio)
    }

    /// A drag distance eased into a small displacement: direct at first, then flattening out.
    static func eased(_ distance: CGFloat) -> CGFloat {
        let limit: CGFloat = 12
        return limit * tanh(distance / 120)
    }

    private func setGive(_ offset: CGPoint, animated: Bool) {
        guard give != offset else { return }
        give = offset
        CATransaction.begin()
        if animated, !reduceMotion {
            CATransaction.setAnimationDuration(0.28)
            CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
        } else {
            CATransaction.setDisableActions(true)
        }
        placeVideo()
        CATransaction.commit()
    }

    private func send(from start: CGPoint, to end: CGPoint) {
        let from = normalised(start), to = normalised(end)
        controller?.swipe(fromX: from.0, fromY: from.1, toX: to.0, toY: to.1)
    }

    private func cancelGesture() {
        gesture = .none
        fadeTrail()
        setGive(.zero, animated: true)
    }

    /// Trackpad and mouse-wheel scrolling. The host turns scroll distance into
    /// one swipe of three times that many points, so the whole gesture is sent
    /// once, when it ends, shortened by the coast like a drag.
    @objc private func wheelScrolled(_ recognizer: UIPanGestureRecognizer) {
        guard interactive, let controller else { return }
        let translation = recognizer.translation(in: self)
        recognizer.setTranslation(.zero, in: self)
        wheelPending.x -= translation.x
        wheelPending.y -= translation.y
        guard recognizer.state == .ended || recognizer.state == .cancelled else { return }
        let intended = CGPoint(x: wheelPending.x * simulatedScale, y: wheelPending.y * simulatedScale)
        wheelPending = .zero
        let length = hypot(intended.x, intended.y)
        guard length >= 12 else { return }
        let ratio = Self.replayLength(forSettledScroll: length) / length
        let position = normalised(recognizer.location(in: self))
        controller.scroll(x: position.0, y: position.1, deltaX: Double(intended.x * ratio / 3), deltaY: Double(intended.y * ratio / 3))
    }

    // MARK: Feedback

    private func ripple(at point: CGPoint) {
        let radius: CGFloat = 18
        let ring = CAShapeLayer()
        ring.path = UIBezierPath(ovalIn: CGRect(x: -radius, y: -radius, width: radius * 2, height: radius * 2)).cgPath
        ring.position = point
        ring.fillColor = UIColor.white.withAlphaComponent(0.28).cgColor
        ring.strokeColor = UIColor.white.withAlphaComponent(0.75).cgColor
        ring.lineWidth = 1.5
        layer.addSublayer(ring)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        var animations: [CAAnimation] = [fade]
        if !reduceMotion {
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.4
            scale.toValue = 1.25
            animations.append(scale)
        }
        let group = CAAnimationGroup()
        group.animations = animations
        group.duration = 0.38
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards
        ring.add(group, forKey: "ripple")
        DispatchQueue.main.asyncAfter(deadline: .now() + group.duration + 0.02) { ring.removeFromSuperlayer() }
    }

    private func showTrail() {
        if trail == nil {
            let shape = CAShapeLayer()
            shape.fillColor = nil
            shape.strokeColor = UIColor.white.withAlphaComponent(0.55).cgColor
            shape.lineWidth = 5
            shape.lineCap = .round
            shape.lineJoin = .round
            layer.addSublayer(shape)
            trail = shape
        }
        trail?.path = trailPath.cgPath
    }

    private func fadeTrail() {
        guard let shape = trail else { return }
        trail = nil
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.duration = 0.3
        fade.isRemovedOnCompletion = false
        fade.fillMode = .forwards
        shape.add(fade, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) { shape.removeFromSuperlayer() }
    }

    // MARK: Keyboard

    override var canBecomeFirstResponder: Bool { interactive }
    var hasText: Bool { true }
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no

    func insertText(_ text: String) {
        controller?.type(text)
    }

    func deleteBackward() {
        controller?.key("Backspace")
    }
}

struct SimulatorSurface: UIViewRepresentable {
    @ObservedObject var controller: SimulatorController
    var keyboardShown: Bool

    func makeUIView(context: Context) -> SimulatorSurfaceView {
        let view = SimulatorSurfaceView(layer: controller.displayLayer)
        view.controller = controller
        return view
    }

    func updateUIView(_ view: SimulatorSurfaceView, context: Context) {
        view.attachVideoLayer()
        view.landscape = controller.landscape
        view.liveScroll = controller.liveScroll
        view.interactive = controller.phase == .live
        if keyboardShown, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !keyboardShown, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }
}
