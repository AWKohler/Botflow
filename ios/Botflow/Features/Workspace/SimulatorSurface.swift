import AVFoundation
import SwiftUI
import UIKit

/// The simulated screen: draws the video and turns touches on it into touches
/// in the simulator. A tap is a tap; a drag is sent as one swipe when the
/// finger lifts (or, with live scrolling on, as scrolling while it moves); two
/// fingers always scroll live. It can also take the keyboard.
final class SimulatorSurfaceView: UIView, UIKeyInput {
    weak var controller: SimulatorController?
    var landscape = false { didSet { if landscape != oldValue { setNeedsLayout() } } }
    var liveScroll = false
    var interactive = false

    private let videoLayer: AVSampleBufferDisplayLayer
    private var touchStart: CGPoint?
    private var lastPoint: CGPoint?
    private var moved = false
    private var trail: CAShapeLayer?
    private var trailPath = UIBezierPath()

    init(layer: AVSampleBufferDisplayLayer) {
        videoLayer = layer
        super.init(frame: .zero)
        backgroundColor = .black
        isMultipleTouchEnabled = true
        clipsToBounds = true
        self.layer.addSublayer(videoLayer)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(twoFingerPan(_:)))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        pan.cancelsTouchesInView = true
        addGestureRecognizer(pan)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
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
        let point = touch.location(in: self)
        touchStart = point
        lastPoint = point
        moved = false
        trailPath = UIBezierPath()
        trailPath.move(to: point)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let start = touchStart, let touch = touches.first, event?.allTouches?.count == 1 else { return }
        let point = touch.location(in: self)
        if hypot(point.x - start.x, point.y - start.y) > 8 { moved = true }
        if moved {
            if liveScroll, let last = lastPoint {
                let position = normalised(point)
                // A finger moving up scrolls the content up, like a wheel turned down.
                controller?.scroll(x: position.0, y: position.1, deltaX: Double(last.x - point.x) * 2, deltaY: Double(last.y - point.y) * 2)
            } else {
                trailPath.addLine(to: point)
                showTrail()
            }
        }
        lastPoint = point
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard interactive, let start = touchStart, let touch = touches.first else { return }
        let end = touch.location(in: self)
        touchStart = nil
        lastPoint = nil
        let from = normalised(start), to = normalised(end)
        if !moved || hypot(to.0 - from.0, to.1 - from.1) < 0.015 {
            controller?.tap(x: to.0, y: to.1)
            ripple(at: end)
            UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.6)
        } else if !liveScroll {
            controller?.swipe(fromX: from.0, fromY: from.1, toX: to.0, toY: to.1)
        }
        fadeTrail()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchStart = nil
        lastPoint = nil
        fadeTrail()
    }

    @objc private func twoFingerPan(_ recognizer: UIPanGestureRecognizer) {
        guard interactive else { return }
        touchStart = nil
        fadeTrail()
        let translation = recognizer.translation(in: self)
        recognizer.setTranslation(.zero, in: self)
        let position = normalised(recognizer.location(in: self))
        controller?.scroll(x: position.0, y: position.1, deltaX: Double(-translation.x) * 2, deltaY: Double(-translation.y) * 2)
    }

    // MARK: Feedback

    private func ripple(at point: CGPoint) {
        let ring = CAShapeLayer()
        ring.path = UIBezierPath(ovalIn: CGRect(x: -18, y: -18, width: 36, height: 36)).cgPath
        ring.position = point
        ring.fillColor = UIColor.white.withAlphaComponent(0.28).cgColor
        ring.strokeColor = UIColor.white.withAlphaComponent(0.7).cgColor
        ring.lineWidth = 1.5
        layer.addSublayer(ring)
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.4
        scale.toValue = 1.25
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 0.38
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        group.isRemovedOnCompletion = false
        group.fillMode = .forwards
        ring.add(group, forKey: "ripple")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { ring.removeFromSuperlayer() }
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
