import AVFoundation
import SwiftUI
import UIKit

/// The simulated screen: draws the video and turns touches on it into touches
/// in the simulator.
///
/// The simulator host accepts whole gestures (a tap, a swipe from A to B, a
/// scroll by some distance, text and keys), not a raw stream of finger
/// positions. So this view works out, as early in the gesture as it can, which
/// of those the person means, and makes each feel as direct as the transport
/// allows:
///
/// - **Tap:** sent when the finger lifts, with a ripple where it landed.
/// - **Vertical drag:** scrolls *while* the finger moves, then coasts with the
///   speed it was released at, as a list does under a real finger.
/// - **Sideways drag:** a swipe, sent when the finger lifts (paging, swiping a
///   row, going back), with a trail so it is clear the gesture registered.
/// - **Touch and hold:** after half a second without moving, a press held in
///   place, for context menus and reordering.
/// - **Two fingers:** scroll in any direction.
///
/// With "Drags scroll the page" off, every drag is sent as a swipe instead.
final class SimulatorSurfaceView: UIView, UIKeyInput {
    weak var controller: SimulatorController?
    var landscape = false { didSet { if landscape != oldValue { setNeedsLayout() } } }
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
        /// Finger down, intent not yet known.
        case pending
        case scrolling
        case swiping
        case held
    }

    private let videoLayer: AVSampleBufferDisplayLayer
    private var gesture: Gesture = .none
    private var touchStart: CGPoint = .zero
    private var lastPoint: CGPoint = .zero
    private var lastTime: TimeInterval = 0
    private var velocity: CGPoint = .zero
    private var holdTimer: Timer?
    private var coast: CADisplayLink?
    private var coastVelocity: CGPoint = .zero
    private var coastPoint: (Double, Double) = (0.5, 0.5)
    private var trail: CAShapeLayer?
    private var trailPath = UIBezierPath()

    /// Points of finger travel to scroll-wheel units. The host scrolls the
    /// simulator by wheel distance; this keeps content under the finger.
    private let scrollGain: CGFloat = 1.0
    private var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    init(layer: AVSampleBufferDisplayLayer) {
        videoLayer = layer
        super.init(frame: .zero)
        backgroundColor = .black
        isMultipleTouchEnabled = true
        clipsToBounds = true
        isAccessibilityElement = true
        accessibilityLabel = "Simulator screen"
        accessibilityHint = "Shows your app running. Touches pass straight through to it."
        accessibilityTraits = [.image]
        attachVideoLayer()
        let pan = UIPanGestureRecognizer(target: self, action: #selector(twoFingerPan(_:)))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        pan.cancelsTouchesInView = true
        addGestureRecognizer(pan)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        holdTimer?.invalidate()
        coast?.invalidate()
    }

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
        videoLayer.setAffineTransform(.identity)
        if landscape {
            // The stream is the portrait surface; turn it a quarter turn counter-clockwise.
            videoLayer.bounds = CGRect(x: 0, y: 0, width: bounds.height, height: bounds.width)
            videoLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
            videoLayer.setAffineTransform(CGAffineTransform(rotationAngle: -.pi / 2))
        } else {
            videoLayer.frame = bounds
        }
        CATransaction.commit()
    }

    private func normalised(_ point: CGPoint) -> (Double, Double) {
        (Double(point.x / max(1, bounds.width)), Double(point.y / max(1, bounds.height)))
    }

    // MARK: Touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let touch = touches.first, event?.allTouches?.count == 1 else { return }
        stopCoasting()
        let point = touch.location(in: self)
        gesture = .pending
        touchStart = point
        lastPoint = point
        lastTime = touch.timestamp
        velocity = .zero
        trailPath = UIBezierPath()
        trailPath.move(to: point)
        holdTimer?.invalidate()
        holdTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
            self?.beginHold()
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, gesture != .none, let touch = touches.first, event?.allTouches?.count == 1 else { return }
        let point = touch.location(in: self)
        let dx = point.x - touchStart.x, dy = point.y - touchStart.y

        if gesture == .pending, hypot(dx, dy) > 8 {
            holdTimer?.invalidate()
            // Mostly vertical travel is a scroll; anything else is a swipe.
            gesture = liveScroll && abs(dy) > abs(dx) * 1.2 ? .scrolling : .swiping
        }

        let dt = max(0.001, touch.timestamp - lastTime)
        switch gesture {
        case .scrolling:
            let step = CGPoint(x: lastPoint.x - point.x, y: lastPoint.y - point.y)
            // Smooth the speed a little so one jittery sample does not decide the coast.
            velocity = CGPoint(x: velocity.x * 0.6 + (step.x / dt) * 0.4, y: velocity.y * 0.6 + (step.y / dt) * 0.4)
            let position = normalised(point)
            controller?.scroll(x: position.0, y: position.1, deltaX: 0, deltaY: Double(step.y * scrollGain))
        case .swiping:
            trailPath.addLine(to: point)
            showTrail()
        case .held, .pending, .none:
            break
        }
        lastPoint = point
        lastTime = touch.timestamp
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let touch = touches.first else { return }
        holdTimer?.invalidate()
        let end = touch.location(in: self)
        let from = normalised(touchStart), to = normalised(end)
        switch gesture {
        case .pending:
            controller?.tap(x: to.0, y: to.1)
            ripple(at: end, held: false)
            UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.6)
        case .swiping:
            controller?.swipe(fromX: from.0, fromY: from.1, toX: to.0, toY: to.1)
        case .scrolling:
            // A finger that was still moving when it lifted keeps the page going.
            if touch.timestamp - lastTime < 0.08, abs(velocity.y) > 180 {
                startCoasting(velocity: CGPoint(x: 0, y: velocity.y), at: to)
            }
        case .held, .none:
            break
        }
        gesture = .none
        fadeTrail()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        cancelGesture()
    }

    private func cancelGesture() {
        holdTimer?.invalidate()
        stopCoasting()
        gesture = .none
        fadeTrail()
    }

    /// Half a second without moving: press and hold where the finger is.
    private func beginHold() {
        guard gesture == .pending else { return }
        gesture = .held
        let point = normalised(touchStart)
        controller?.longPress(x: point.0, y: point.1)
        ripple(at: touchStart, held: true)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    @objc private func twoFingerPan(_ recognizer: UIPanGestureRecognizer) {
        guard interactive else { return }
        holdTimer?.invalidate()
        gesture = .none
        fadeTrail()
        if recognizer.state == .began { stopCoasting() }
        let translation = recognizer.translation(in: self)
        recognizer.setTranslation(.zero, in: self)
        let position = normalised(recognizer.location(in: self))
        controller?.scroll(x: position.0, y: position.1, deltaX: Double(-translation.x * scrollGain), deltaY: Double(-translation.y * scrollGain))
        if recognizer.state == .ended {
            let speed = recognizer.velocity(in: self)
            if hypot(speed.x, speed.y) > 180 { startCoasting(velocity: CGPoint(x: -speed.x, y: -speed.y), at: position) }
        }
    }

    // MARK: Coasting

    private func startCoasting(velocity: CGPoint, at point: (Double, Double)) {
        stopCoasting()
        coastVelocity = velocity
        coastPoint = point
        let link = CADisplayLink(target: self, selector: #selector(coastStep(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        coast = link
    }

    private func stopCoasting() {
        coast?.invalidate()
        coast = nil
    }

    @objc private func coastStep(_ link: CADisplayLink) {
        let dt = CGFloat(link.targetTimestamp - link.timestamp)
        controller?.scroll(
            x: coastPoint.0,
            y: coastPoint.1,
            deltaX: Double(coastVelocity.x * dt * scrollGain),
            deltaY: Double(coastVelocity.y * dt * scrollGain)
        )
        // The same decay UIScrollView uses at its normal rate: about 2% per millisecond-scaled frame.
        let decay = pow(0.998, dt * 1000)
        coastVelocity = CGPoint(x: coastVelocity.x * decay, y: coastVelocity.y * decay)
        if hypot(coastVelocity.x, coastVelocity.y) < 24 { stopCoasting() }
    }

    // MARK: Feedback

    private func ripple(at point: CGPoint, held: Bool) {
        let radius: CGFloat = held ? 26 : 18
        let ring = CAShapeLayer()
        ring.path = UIBezierPath(ovalIn: CGRect(x: -radius, y: -radius, width: radius * 2, height: radius * 2)).cgPath
        ring.position = point
        ring.fillColor = UIColor.white.withAlphaComponent(held ? 0.18 : 0.28).cgColor
        ring.strokeColor = UIColor.white.withAlphaComponent(0.75).cgColor
        ring.lineWidth = held ? 2.5 : 1.5
        layer.addSublayer(ring)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        var animations: [CAAnimation] = [fade]
        if !reduceMotion {
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = held ? 1.25 : 0.4
            scale.toValue = held ? 0.8 : 1.25
            animations.append(scale)
        }
        let group = CAAnimationGroup()
        group.animations = animations
        group.duration = held ? 0.6 : 0.38
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
