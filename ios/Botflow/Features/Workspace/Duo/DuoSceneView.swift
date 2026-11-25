import Metal
import SceneKit
import UIKit
import simd

/// The iPhone Duo on screen: draws the model, plays the two panels' video on
/// it, and turns touches into either a move of the model (turn it, fold it,
/// zoom) or input for the simulator (a finger on a screen, a press of a side
/// button).
///
/// How the device is placed (see `DuoGeometry.swift` for the device frame):
///
///     scene ─ pivot ─ model.root
///
/// `model.root` is shifted so the device's centre of weight is at the pivot.
/// `pivot` carries the orientation: the person's own turn (`userQuat`) applied
/// over the turn the fold itself asks for (`Duo.autoYaw`), so the side in use
/// keeps facing the viewer while the device opens and closes.
///
/// The scene is drawn on demand: a new video frame, an animation in flight or
/// a touch asks for a frame; a still simulator costs nothing.
final class DuoSceneView: UIView, SCNSceneRendererDelegate, UIKeyInput {
    // MARK: Outputs

    /// A finger on a panel: display, phase ("down" / "move" / "up"), position
    /// as a fraction of that panel's framebuffer, finger index (0 or 1).
    var onTouch: ((DuoDisplay, String, Double, Double, Int) -> Void)?
    /// The person set the hinge (degrees, 180 open). `settled`: not mid-drag.
    var onHingeRequest: ((Double, Bool) -> Void)?
    /// The angle the model is shown at changed (for the readout).
    var onHingeShown: ((Double) -> Void)?
    /// The way the device is held changed enough that iOS should turn.
    var onOrientation: ((DuoHeldOrientation) -> Void)?
    /// A side button was pressed (the wire protocol's name for it).
    var onButton: ((String) -> Void)?
    var onText: ((String) -> Void)?
    var onKey: ((String) -> Void)?

    // MARK: Inputs

    /// Whether the simulator is streaming: only then do the screens take touches.
    var live = false {
        didSet {
            guard live != oldValue else { return }
            accessibilityTraits = live ? [.allowsDirectInteraction] : [.image]
            if !live { liftAllFingers() }
            invalidate()
        }
    }
    /// Which panels iOS has on.
    var lit: [DuoDisplay: Bool] = [.cover: false, .inner: true] { didSet { invalidate() } }
    /// Darken the pictures (behind a status message). 0 … 1.
    var dim: Double = 0 { didSet { invalidate() } }
    var finish: DuoModel.Finish = .natural { didSet { model.setFinish(finish); invalidate() } }

    // MARK: Scene

    private let sceneView: SCNView
    private let scene = SCNScene()
    private let cameraNode = SCNNode()
    private let pivot = SCNNode()
    private let shadow = SCNNode()
    private let model = DuoModel()
    private var link: CADisplayLink?
    private var lastTick: CFTimeInterval = 0
    private var settleFrames = 0

    /// Vertical field of view. Narrow, so the device reads as a product shot.
    private static let fov = 24.0
    /// The device fills this fraction of the view.
    private static let fill = 0.86
    private static let zoomRange = 0.5...3.2
    /// A half can be folded by its outer edge: this close to it counts.
    private static let hingeGrab = 15.0
    /// After the person moves the hinge, the host's reports are ignored this long.
    private static let hingeUserHold: CFTimeInterval = 1.4

    // Fold.
    private var hingeShown = 180.0
    private(set) var hingeTarget = 180.0
    private var hingeUserAt: CFTimeInterval = 0
    private var foldApplied = -1.0

    // Attitude and framing.
    private var userQuat = simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)
    private var userQuatTarget = simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)
    /// When set, the pose being travelled to is the device's whole attitude
    /// (tabletop): the person's part is recomputed as the fold's own turn changes.
    private var attitudeTarget: simd_quatd?
    private var spin = SIMD2<Double>(0, 0)
    private var zoom = 1.0
    private var zoomTarget = 1.0
    private var distance = 600.0
    private var framed = false
    /// The person has folded or turned the device themselves.
    private(set) var posed = false
    /// Called when the device comes to rest in a new posture.
    var onPostureSettled: ((Posture) -> Void)?
    private var keepAlive: Timer?

    /// How the device was left: fold, attitude and zoom. Carried from one view
    /// of the device to the next (the pane to full screen and back), so it
    /// does not spring back to open and square on.
    struct Posture: Equatable {
        var hinge = 180.0
        var turn = simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)
        var attitude: simd_quatd?
        var zoom = 1.0
        var posed = false
    }

    var posture: Posture {
        Posture(hinge: hingeTarget, turn: userQuatTarget, attitude: attitudeTarget, zoom: zoomTarget, posed: posed)
    }

    /// Put the device as it was left (no animation, nothing sent).
    func restore(_ posture: Posture) {
        hingeTarget = min(180, max(0, posture.hinge))
        hingeShown = hingeTarget
        attitudeTarget = posture.attitude
        userQuatTarget = posture.attitude.map { $0 * autoQuat(Duo.beta(hinge: hingeTarget)).inverse } ?? posture.turn
        userQuat = userQuatTarget
        zoomTarget = min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, posture.zoom))
        zoom = zoomTarget
        posed = posture.posed
        spin = .zero
        applyFold()
        if framed { distance = fitDistance() }
        invalidate()
    }

    // Panels.
    private var dimShown = 0.0

    // Held orientation.
    private(set) var orientation: DuoHeldOrientation = .portrait
    private var orientationCandidate: DuoHeldOrientation = .portrait
    private var orientationSince: CFTimeInterval = 0

    // Textures. The decoder's textures have no mipmaps, and a 2,853-pixel
    // panel drawn a few hundred points wide shimmers without them; so each new
    // frame is copied into a mipmapped texture, on SceneKit's own command
    // queue just before it draws.
    private let textureLock = NSLock()
    private var pending: [DuoDisplay: DuoFrame] = [:]
    private var shown: [DuoDisplay: DuoFrame] = [:]
    private var mipped: [DuoDisplay: MTLTexture] = [:]
    /// Bumped by `clearFrames`: a texture made for an earlier session is not shown.
    private var textureGeneration = 0

    // Touches.
    private enum Pick {
        case button(Int)
        case screen(DuoDisplay, u: Double, v: Double)
        case body(camera: Bool, flat: SIMD3<Double>, edge: Bool)
    }

    private enum Drag {
        case orbit(last: CGPoint)
        case hinge(last: CGPoint, camera: Bool, flat: SIMD3<Double>)
        case finger(display: DuoDisplay, index: Int, u: Double, v: Double)
        case button(Int)
    }

    private var drags: [ObjectIdentifier: Drag] = [:]
    private var pressed: Set<Int> = []
    private var buttonTravel: [Double]
    private var lastTapAt: CFTimeInterval = 0

    private var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    override init(frame: CGRect) {
        sceneView = SCNView(frame: frame, options: DuoVideoDecoder.device.map { [SCNView.Option.preferredDevice.rawValue: $0] })
        buttonTravel = model.buttons.map { _ in 0 }
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = .clear
        isAccessibilityElement = true
        accessibilityLabel = "iPhone Duo simulator"
        accessibilityHint = "Shows your app on both screens of an iPhone Duo. Drag beside the device to turn it. The buttons below fold and rotate it."
        accessibilityTraits = [.image]

        sceneView.scene = scene
        sceneView.backgroundColor = .clear
        sceneView.isOpaque = false
        sceneView.antialiasingMode = .multisampling4X
        sceneView.rendersContinuously = false
        sceneView.autoenablesDefaultLighting = false
        sceneView.isUserInteractionEnabled = false
        sceneView.delegate = self
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(sceneView)

        let camera = SCNCamera()
        camera.fieldOfView = Self.fov
        camera.projectionDirection = .vertical
        camera.zNear = 10
        camera.zFar = 6000
        cameraNode.camera = camera
        cameraNode.position = SCNVector3(0, 0, Float(distance))
        scene.rootNode.addChildNode(cameraNode)
        sceneView.pointOfView = cameraNode

        // A neutral studio to reflect in the metal and glass, and one key light.
        scene.lightingEnvironment.contents = Self.studio()
        scene.lightingEnvironment.intensity = 1.25
        let key = SCNNode()
        key.light = SCNLight()
        key.light?.type = .directional
        key.light?.intensity = 520
        key.eulerAngles = SCNVector3(-0.6, -0.45, 0)
        scene.rootNode.addChildNode(key)

        pivot.addChildNode(model.root)
        scene.rootNode.addChildNode(pivot)

        // A soft shadow on the "wall" behind the device, so it sits in space.
        let plane = SCNPlane(width: 1, height: 1)
        let shadowMaterial = SCNMaterial()
        shadowMaterial.lightingModel = .constant
        shadowMaterial.diffuse.contents = Self.shadowImage()
        shadowMaterial.writesToDepthBuffer = false
        shadowMaterial.isDoubleSided = true
        plane.materials = [shadowMaterial]
        shadow.geometry = plane
        shadow.renderingOrder = -1
        shadow.opacity = 0.3
        scene.rootNode.addChildNode(shadow)

        applyFold()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: DuoSceneView, _) in view.updateBackdrop() }
        updateBackdrop()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        link?.invalidate()
        keepAlive?.invalidate()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            link?.invalidate()
            link = nil
            liftAllFingers()
        } else {
            invalidate()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sceneView.frame = bounds
        if !framed, bounds.width > 1, bounds.height > 1 {
            distance = fitDistance()
            framed = true
        }
        invalidate()
    }

    private func updateBackdrop() {
        shadow.opacity = traitCollection.userInterfaceStyle == .dark ? 0.55 : 0.26
        invalidate()
    }

    // MARK: Public surface

    /// A decoded frame for a panel. Call on the main thread.
    func setFrame(_ display: DuoDisplay, _ frame: DuoFrame) {
        textureLock.lock()
        pending[display] = frame
        textureLock.unlock()
        sceneView.setNeedsDisplay()
        invalidate()
    }

    /// Drop the pictures (the session ended or restarted).
    func clearFrames() {
        textureLock.lock()
        pending.removeAll()
        shown.removeAll()
        mipped.removeAll()
        textureGeneration += 1
        textureLock.unlock()
        for display in DuoDisplay.allCases { model.screenMaterials[display]?.diffuse.contents = UIColor.black }
        invalidate()
    }

    /// The host's report of where the hinge is. Followed unless the person has
    /// just moved it (`adopt` follows it regardless: joining a session under way).
    func setReportedHinge(_ hinge: Double, adopt: Bool = false) {
        let held = !adopt && CACurrentMediaTime() - hingeUserAt <= Self.hingeUserHold
        if !held, abs(hinge - hingeTarget) > 0.5 {
            hingeTarget = hinge
            invalidate()
        }
    }

    /// Take up the way the session's device is already held (joining a session
    /// under way): turn the model to match, so this view does not then tell
    /// iOS the device has been turned back.
    func adoptOrientation(_ held: DuoHeldOrientation) {
        guard held != orientation else { return }
        let quarters: Double
        switch held {
        case .portrait: quarters = 0
        case .landscapeLeft: quarters = 1
        case .portraitUpsideDown: quarters = 2
        case .landscapeRight: quarters = -1
        }
        attitudeTarget = nil
        userQuatTarget = simd_quatd(angle: quarters * .pi / 2, axis: SIMD3(0, 0, 1))
        orientation = held
        orientationCandidate = held
        invalidate()
    }

    /// Fold to an angle (from the slider).
    func setHinge(_ hinge: Double, settled: Bool) {
        posed = true
        hingeTarget = min(180, max(0, hinge))
        hingeUserAt = CACurrentMediaTime()
        onHingeRequest?(hingeTarget, settled)
        invalidate()
    }

    /// Move to a named posture: fold and attitude together.
    func apply(_ pose: DuoPose) {
        spin = .zero
        zoomTarget = 1
        if pose.tabletop {
            // Stand the device on its cover half: that half flat with its
            // inner face up, reaching towards the viewer, the camera half
            // upright behind it, and the whole thing tipped forward enough to
            // see the lower screen. (This way up is one every app can turn to.)
            let lying = simd_quatd(simd_double3x3(columns: (
                SIMD3(0, 0, -1), // across the cover half, towards the hinge → away from the viewer
                SIMD3(-1, 0, 0), // along the hinge → across the screen
                SIMD3(0, 1, 0)   // the cover half's inner face → up
            )))
            // The device frame is the camera half's; bring the cover half's into it.
            let unfold = simd_quatd(angle: Duo.beta(hinge: pose.hinge), axis: SIMD3(0, 1, 0)).inverse
            let tip = simd_quatd(angle: 38 * .pi / 180, axis: SIMD3(1, 0, 0))
            attitudeTarget = tip * lying * unfold
        } else {
            attitudeTarget = nil
            userQuatTarget = simd_quatd(angle: pose.pitch * .pi / 180, axis: SIMD3(1, 0, 0))
        }
        setHinge(pose.hinge, settled: true)
    }

    /// Turn the device a quarter turn in the plane of the screen.
    func rollQuarter(left: Bool) {
        posed = true
        settleAttitude()
        userQuatTarget = simd_quatd(angle: (left ? 1 : -1) * .pi / 2, axis: SIMD3(0, 0, 1)) * userQuatTarget
        spin = .zero
        invalidate()
    }

    /// Square the device up to the viewer again and undo any zoom.
    func resetView() {
        attitudeTarget = nil
        userQuatTarget = simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)
        spin = .zero
        zoomTarget = 1
        invalidate()
    }

    /// The panel in use, for callers that need to know which screen is showing.
    var displayInUse: DuoDisplay { (lit[.inner] ?? true) || !(lit[.cover] ?? false) ? .inner : .cover }

    // MARK: Frame loop

    private func invalidate() {
        settleFrames = 2
        guard window != nil else { return }
        if link == nil {
            let created = CADisplayLink(target: self, selector: #selector(tick(_:)))
            created.add(to: .main, forMode: .common)
            link = created
        }
        link?.isPaused = false
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = lastTick > 0 ? min(0.05, now - lastTick) : 1.0 / 60
        lastTick = now
        let moving = advance(dt: dt, now: now)
        if moving { settleFrames = 2 } else { settleFrames -= 1 }
        if settleFrames <= 0 {
            link.isPaused = true
            lastTick = 0
            onPostureSettled?(posture)
        }
    }

    /// Smooth a value towards a target; `tau` is the time to cover ~63% of the gap.
    private func approach(_ current: Double, _ target: Double, _ dt: Double, _ tau: Double) -> Double {
        reduceMotion ? target : current + (target - current) * (1 - exp(-dt / tau))
    }

    private func autoQuat(_ beta: Double) -> simd_quatd {
        simd_quatd(angle: Duo.autoYaw(beta: beta), axis: SIMD3(0, 1, 0))
    }

    /// Step every animation. Returns whether anything is still in motion.
    private func advance(dt: Double, now: CFTimeInterval) -> Bool {
        var moving = false

        // Fold.
        if abs(hingeShown - hingeTarget) > 0.02 {
            hingeShown = approach(hingeShown, hingeTarget, dt, 0.085)
            if abs(hingeShown - hingeTarget) <= 0.02 { hingeShown = hingeTarget }
            moving = true
        }
        let beta = Duo.beta(hinge: hingeShown)

        // Attitude: either free spin after a flick, or travel to a target.
        let orbiting = drags.values.contains { if case .orbit = $0 { return true } else { return false } }
        if !orbiting {
            if simd_length(spin) > 0.02, !reduceMotion {
                turn(aboutY: spin.x * dt, aboutX: spin.y * dt)
                spin *= exp(-dt / 0.22)
                moving = true
            } else {
                spin = .zero
                if let attitudeTarget {
                    userQuatTarget = attitudeTarget * autoQuat(beta).inverse
                }
                let gap = Self.angle(userQuat, userQuatTarget)
                if gap > 0.0008 {
                    userQuat = reduceMotion ? userQuatTarget : simd_slerp(userQuat, userQuatTarget, 1 - exp(-dt / 0.11))
                    moving = true
                } else {
                    userQuat = userQuatTarget
                }
            }
        }

        if foldApplied != hingeShown { applyFold() }
        let total = userQuat * autoQuat(beta)
        pivot.simdOrientation = simd_quatf(ix: Float(total.imag.x), iy: Float(total.imag.y), iz: Float(total.imag.z), r: Float(total.real))

        // Framing.
        if abs(zoom - zoomTarget) > 0.001 {
            zoom = approach(zoom, zoomTarget, dt, 0.09)
            moving = true
        }
        let fit = fitDistance()
        if abs(distance - fit) > 0.05 {
            distance = approach(distance, fit, dt, 0.16)
            moving = true
        }
        cameraNode.simdPosition = SIMD3(0, 0, Float(distance / zoom))
        placeShadow(total)

        // A picture is always shown as it is (dimmed behind a status message).
        // Whether a panel is "off" is only a guess from its pixels, and must
        // never hide an app that happens to be dark; an off panel streams
        // black anyway.
        for display in DuoDisplay.allCases {
            model.screenMaterials[display]?.multiply.contents = UIColor(white: 1 - dimShown, alpha: 1)
        }
        if abs(dimShown - dim) > 0.004 {
            dimShown = approach(dimShown, dim, dt, 0.12)
            moving = true
        } else {
            dimShown = dim
        }

        // Buttons travel inwards while held.
        for (index, button) in model.buttons.enumerated() {
            let target = pressed.contains(index) ? 1.0 : 0.0
            if abs(buttonTravel[index] - target) > 0.01 {
                buttonTravel[index] = approach(buttonTravel[index], target, dt, 0.035)
                moving = true
            } else {
                buttonTravel[index] = target
            }
            let travel = Float(0.55 * buttonTravel[index])
            button.node.position = SCNVector3(
                button.rest.x + button.inward.x * travel, button.rest.y + button.inward.y * travel, button.rest.z + button.inward.z * travel
            )
        }

        senseOrientation(beta: beta, total: total, now: now, moving: moving)
        return moving
    }

    private func applyFold() {
        let beta = Duo.beta(hinge: hingeShown)
        model.setFold(beta)
        let c = Duo.centroid(beta: beta)
        model.root.simdPosition = SIMD3(Float(-c.x), Float(-c.y), Float(-c.z))
        foldApplied = hingeShown
        onHingeShown?(hingeShown)
    }

    // MARK: Framing

    /// Points that bound the device, in the pivot's frame, for a fold.
    private func boundingPoints(beta: Double, quat: simd_quatd) -> [SIMD3<Double>] {
        let W = Duo.halfWidth, H = Duo.height / 2, T = Duo.thickness / 2
        let c = Duo.centroid(beta: beta)
        var points: [SIMD3<Double>] = []
        for y in [-H, H] {
            for z in [-T, T] {
                for x in [0, W] { points.append(SIMD3(x, y, z)) }
                for x in [0, -W] { points.append(Duo.coverHalfPoint(SIMD3(x, y, z), beta: beta)) }
            }
        }
        // The camera plateau stands proud of the back.
        points.append(SIMD3(77, 54, -T - 5))
        points.append(SIMD3(24, 34, -T - 5))
        return points.map { quat.act($0 - c) }
    }

    /// Camera distance at which the device, as posed, just fits the view.
    private func fitDistance() -> Double {
        let beta = Duo.beta(hinge: hingeShown)
        let quat = userQuat * autoQuat(beta)
        let aspect = Double(bounds.width / max(1, bounds.height))
        let tanV = tan(Self.fov * .pi / 360) * Self.fill
        let tanH = tan(Self.fov * .pi / 360) * aspect * Self.fill
        var fit = 100.0
        for p in boundingPoints(beta: beta, quat: quat) {
            fit = max(fit, p.z + abs(p.x) / tanH, p.z + abs(p.y) / tanV)
        }
        return fit
    }

    private func placeShadow(_ total: simd_quatd) {
        var maxX = 1.0, maxY = 1.0, minZ = 0.0
        for p in boundingPoints(beta: Duo.beta(hinge: hingeShown), quat: total) {
            maxX = max(maxX, abs(p.x))
            maxY = max(maxY, abs(p.y))
            minZ = min(minZ, p.z)
        }
        shadow.simdScale = SIMD3(Float(maxX * 2 * 1.5), Float(maxY * 2 * 1.42), 1)
        shadow.simdPosition = SIMD3(0, Float(-maxY * 0.09), Float(minZ - 22))
    }

    // MARK: Attitude

    private static func angle(_ a: simd_quatd, _ b: simd_quatd) -> Double {
        2 * acos(min(1, abs(simd_dot(a, b))))
    }

    /// Turn about the screen's vertical and horizontal axes (radians).
    private func turn(aboutY: Double, aboutX: Double) {
        let q = simd_quatd(angle: aboutY, axis: SIMD3(0, 1, 0)) * simd_quatd(angle: aboutX, axis: SIMD3(1, 0, 0))
        userQuat = simd_normalize(q * userQuat)
        userQuatTarget = userQuat
    }

    /// Stop aiming at a whole-device attitude; keep the device where it is headed.
    private func settleAttitude() {
        guard let attitudeTarget else { return }
        userQuatTarget = attitudeTarget * autoQuat(Duo.beta(hinge: hingeTarget)).inverse
        self.attitudeTarget = nil
    }

    /// After a turn by hand: if the device is nearly square on to the viewer
    /// (in any of its quarter-turn attitudes, front or back), finish the job.
    private func snapIfNearlySquare() {
        let auto = autoQuat(Duo.beta(hinge: hingeTarget))
        let total = userQuat * auto
        var best: simd_quatd?
        var bestAngle = 13 * Double.pi / 180
        for flip in [0, Double.pi] {
            for quarter in 0..<4 {
                let candidate = simd_quatd(angle: Double(quarter) * .pi / 2, axis: SIMD3(0, 0, 1)) * simd_quatd(angle: flip, axis: SIMD3(0, 1, 0))
                let gap = Self.angle(total, candidate)
                if gap < bestAngle {
                    bestAngle = gap
                    best = candidate
                }
            }
        }
        if let best {
            userQuatTarget = best * auto.inverse
            spin = .zero
        }
    }

    /// Work out how the device is being held and, once it has stayed that way
    /// a moment, say so (iOS turns the interface to match).
    private func senseOrientation(beta: Double, total: simd_quatd, now: CFTimeInterval, moving: Bool) {
        // World up, in the device's own axes.
        let up = total.inverse.act(SIMD3(0, 1, 0))
        let coverX = Duo.coverHalfDirection(SIMD3(1, 0, 0), beta: beta)
        let next = DuoHeldOrientation.from(
            cameraHalf: SIMD2(up.x, up.y),
            coverHalf: SIMD2(simd_dot(up, coverX), up.y),
            coverInUse: displayInUse == .cover,
            previous: orientation
        )
        if next != orientationCandidate {
            orientationCandidate = next
            orientationSince = now
        }
        if orientationCandidate != orientation {
            if now - orientationSince > 0.26 {
                orientation = orientationCandidate
                onOrientation?(orientation)
            } else if !moving {
                settleFrames = max(settleFrames, 2)
            }
        }
    }

    // MARK: Picking

    private func pick(_ point: CGPoint) -> Pick? {
        let options: [SCNHitTestOption: Any] = [
            .searchMode: SCNHitTestSearchMode.closest.rawValue,
            .backFaceCulling: true,
            .ignoreHiddenNodes: true,
        ]
        // The shadow is not part of the device.
        guard let hit = sceneView.hitTest(point, options: options).first(where: { $0.node !== shadow }) else { return nil }
        let name = hit.node.name ?? ""
        let W = Duo.halfWidth
        if name.hasPrefix("button."), let index = Int(name.dropFirst(7)) { return .button(index) }
        if name == "screen.inner" {
            let uv = hit.textureCoordinates(withMappingChannel: 0)
            return .screen(.inner, u: Double(uv.x), v: Double(uv.y))
        }
        if name == "screen.cover" {
            let uv = hit.textureCoordinates(withMappingChannel: 0)
            return .screen(.cover, u: Double(uv.x), v: Double(uv.y))
        }
        if name == "bezel.inner" {
            // Its texture coordinates are the flat position on the open face.
            let flat = hit.textureCoordinates(withMappingChannel: 0)
            return .body(camera: flat.x >= 0, flat: SIMD3(Double(flat.x), Double(flat.y), Duo.thickness / 2), edge: abs(Double(flat.x)) > W - Self.hingeGrab)
        }
        // A solid part: find its half, and where on that half (in flat coordinates) it was held.
        var node: SCNNode? = hit.node
        var camera = true
        while let current = node {
            if current === model.coverHalf { camera = false; break }
            if current === model.cameraHalf { break }
            node = current.parent
        }
        let half = camera ? model.cameraHalf : model.coverHalf
        let local = half.presentation.convertPosition(hit.worldCoordinates, from: nil)
        let flat = SIMD3(Double(local.x), Double(local.y), Double(local.z))
        return .body(camera: camera, flat: flat, edge: abs(flat.x) > W - Self.hingeGrab)
    }

    /// Where a point held on a half would be in this view at a hinge angle.
    private func viewPoint(camera: Bool, flat: SIMD3<Double>, hinge: Double) -> CGPoint {
        let beta = Duo.beta(hinge: hinge)
        let p = camera ? flat : Duo.coverHalfPoint(flat, beta: beta)
        let world = (userQuat * autoQuat(beta)).act(p - Duo.centroid(beta: beta))
        let projected = sceneView.projectPoint(SCNVector3(Float(world.x), Float(world.y), Float(world.z)))
        return CGPoint(x: CGFloat(projected.x), y: CGFloat(projected.y))
    }

    // MARK: Touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            let point = touch.location(in: self)
            let picked = pick(point)
            let drag: Drag
            switch picked {
            case .button(let index)?:
                drag = .button(index)
                pressed.insert(index)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case .screen(let display, let u, let v)? where live:
                // A second finger on a panel is a second finger in the app.
                let used = drags.values.compactMap { drag -> Int? in if case .finger(_, let index, _, _) = drag { return index } else { return nil } }
                guard used.count < 2 else { continue }
                let index = used.contains(0) ? 1 : 0
                drag = .finger(display: display, index: index, u: u, v: v)
                onTouch?(display, "down", u, v, index)
            case .body(let camera, let flat, let edge)? where edge:
                drag = .hinge(last: point, camera: camera, flat: flat)
                hingeUserAt = CACurrentMediaTime()
                posed = true
            default:
                // Beside the device, or on its body: turn it. Two quick taps beside it reset the view.
                if picked == nil {
                    if touch.timestamp - lastTapAt < 0.35 { resetView() }
                    lastTapAt = touch.timestamp
                }
                drag = .orbit(last: point)
                posed = true
                settleAttitude()
                spin = .zero
                userQuatTarget = userQuat
            }
            drags[ObjectIdentifier(touch)] = drag
        }
        keepFingersAlive()
        invalidate()
    }

    /// The host lifts a finger it has heard nothing of for a few seconds (in
    /// case the client has gone). A finger held still sends nothing, so while
    /// any is down its position is repeated every couple of seconds: a long
    /// press, or a drag paused mid-way, stays down.
    private func keepFingersAlive() {
        let touching = drags.values.contains { if case .finger = $0 { return true } else { return false } }
        guard touching else {
            keepAlive?.invalidate()
            keepAlive = nil
            return
        }
        guard keepAlive == nil else { return }
        keepAlive = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self else { return }
            for drag in self.drags.values {
                if case .finger(let display, let index, let u, let v) = drag { self.onTouch?(display, "move", u, v, index) }
            }
            self.keepFingersAlive()
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            let id = ObjectIdentifier(touch)
            guard let drag = drags[id] else { continue }
            let point = touch.location(in: self)
            switch drag {
            case .orbit(let last):
                let dx = Double(point.x - last.x), dy = Double(point.y - last.y)
                drags[id] = .orbit(last: point)
                // Two orbiting fingers at once: a pinch, which zooms.
                let others = drags.filter { $0.key != id }.compactMap { entry -> CGPoint? in if case .orbit(let p) = entry.value { return p } else { return nil } }
                if let other = others.first {
                    let before = hypot(Double(last.x - other.x), Double(last.y - other.y))
                    let after = hypot(Double(point.x - other.x), Double(point.y - other.y))
                    if before > 10 { zoomTarget = min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, zoomTarget * after / before)) }
                } else {
                    let k = Double.pi * 1.15 / Double(max(1, min(bounds.width, bounds.height)))
                    turn(aboutY: dx * k, aboutX: dy * k)
                    // Remember the pace, so letting go mid-turn carries on a little.
                    spin = SIMD2(dx * k * 60, dy * k * 60)
                }
            case .hinge(let last, let camera, let flat):
                let dx = Double(point.x - last.x), dy = Double(point.y - last.y)
                drags[id] = .hinge(last: point, camera: camera, flat: flat)
                // How the held point moves on screen per degree of hinge, here and now.
                let a = viewPoint(camera: camera, flat: flat, hinge: min(180, hingeTarget + 0.5))
                let b = viewPoint(camera: camera, flat: flat, hinge: max(0, hingeTarget - 0.5))
                let gx = Double(a.x - b.x), gy = Double(a.y - b.y)
                let g2 = gx * gx + gy * gy
                let delta: Double
                if g2 > 0.09 {
                    delta = (dx * gx + dy * gy) / g2   // the point follows the finger
                } else {
                    // Square on and nearly flat the edge barely moves on screen:
                    // treat a pull towards the middle as "fold".
                    let centre = viewPoint(camera: camera, flat: .zero, hinge: hingeTarget)
                    let here = viewPoint(camera: camera, flat: flat, hinge: hingeTarget)
                    let outward: Double = here.x >= centre.x ? 1 : -1
                    delta = dx * outward * 220 / Double(max(120, bounds.width))
                }
                hingeTarget = min(180, max(0, hingeTarget + delta))
                hingeShown = hingeTarget   // follow the hand exactly; the host eases its own
                hingeUserAt = CACurrentMediaTime()
                onHingeRequest?(hingeTarget, false)
            case .finger(let display, let index, _, _):
                if case .screen(let hitDisplay, let u, let v)? = pick(point), hitDisplay == display {
                    let cu = min(1, max(0, u)), cv = min(1, max(0, v))
                    drags[id] = .finger(display: display, index: index, u: cu, v: cv)
                    onTouch?(display, "move", cu, cv, index)
                }
            case .button(let index):
                // Sliding off the button cancels the press.
                if case .button(let over)? = pick(point), over == index { pressed.insert(index) } else { pressed.remove(index) }
            }
        }
        invalidate()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        finish(touches, cancelled: false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        finish(touches, cancelled: true)
    }

    private func finish(_ touches: Set<UITouch>, cancelled: Bool) {
        for touch in touches {
            guard let drag = drags.removeValue(forKey: ObjectIdentifier(touch)) else { continue }
            switch drag {
            case .orbit:
                if simd_length(spin) < 0.6 {
                    spin = .zero
                    snapIfNearlySquare()
                }
            case .hinge:
                // Let go close to shut or flat: finish the move.
                if hingeTarget < 12 { hingeTarget = 0 } else if hingeTarget > 168 { hingeTarget = 180 }
                hingeUserAt = CACurrentMediaTime()
                onHingeRequest?(hingeTarget, true)
                UISelectionFeedbackGenerator().selectionChanged()
            case .finger(let display, let index, let u, let v):
                onTouch?(display, "up", u, v, index)
            case .button(let index):
                if pressed.remove(index) != nil, !cancelled { onButton?(model.buttons[index].name) }
            }
        }
        keepFingersAlive()
        invalidate()
    }

    /// Lift any finger still down on the simulator (the view is going away, or the session is).
    private func liftAllFingers() {
        for (id, drag) in drags {
            if case .finger(let display, let index, let u, let v) = drag {
                onTouch?(display, "up", u, v, index)
                drags[id] = nil
            }
        }
    }

    // MARK: Textures

    func renderer(_ renderer: SCNSceneRenderer, willRenderScene scene: SCNScene, atTime time: TimeInterval) {
        textureLock.lock()
        let frames = pending
        pending.removeAll()
        textureLock.unlock()
        guard !frames.isEmpty, let device = renderer.device, let queue = renderer.commandQueue,
              let commands = queue.makeCommandBuffer(), let blit = commands.makeBlitCommandEncoder() else { return }
        var fresh: [DuoDisplay: MTLTexture] = [:]
        textureLock.lock()
        let generation = textureGeneration
        for (display, frame) in frames {
            let source = frame.texture
            var target = mipped[display]
            if target == nil || target!.width != source.width || target!.height != source.height || target!.pixelFormat != source.pixelFormat {
                // Same format as the source: a blit copies bytes, it does not convert.
                let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: source.pixelFormat, width: source.width, height: source.height, mipmapped: true)
                descriptor.usage = [.shaderRead, .renderTarget]
                descriptor.storageMode = .private
                target = device.makeTexture(descriptor: descriptor)
                mipped[display] = target
                if let target { fresh[display] = target }
            }
            guard let target else { continue }
            blit.copy(from: source, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                      sourceSize: MTLSize(width: source.width, height: source.height, depth: 1),
                      to: target, destinationSlice: 0, destinationLevel: 0, destinationOrigin: MTLOrigin(x: 0, y: 0, z: 0))
            blit.generateMipmaps(for: target)
            shown[display] = frame   // the latest picture, for screenshots
        }
        textureLock.unlock()
        blit.endEncoding()
        // The decoder's buffers go back to its pool when nothing holds them:
        // hold these until the GPU has actually copied out of them.
        commands.addCompletedHandler { _ in _ = frames }
        commands.commit()
        if !fresh.isEmpty {
            // A new texture object: hand it to the material (on the main thread), then draw again.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.textureLock.lock()
                let current = self.textureGeneration == generation
                self.textureLock.unlock()
                guard current else { return }   // the session it belonged to has gone
                for (display, texture) in fresh { self.model.screenMaterials[display]?.diffuse.contents = texture }
                self.sceneView.setNeedsDisplay()
            }
        }
    }

    /// The latest picture of a panel, for screenshots.
    func latestPixelBuffer(_ display: DuoDisplay) -> CVPixelBuffer? {
        textureLock.lock()
        defer { textureLock.unlock() }
        return (pending[display] ?? shown[display])?.pixelBuffer
    }

    // MARK: Keyboard

    override var canBecomeFirstResponder: Bool { live }
    var hasText: Bool { true }
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no

    func insertText(_ text: String) { onText?(text) }
    func deleteBackward() { onKey?("Backspace") }

    // MARK: Images

    /// A studio to reflect: a dim room with a broad light overhead and two
    /// soft boxes, as an equirectangular image.
    private static func studio() -> UIImage {
        let size = CGSize(width: 512, height: 256)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            let colors = [UIColor(white: 0.95, alpha: 1).cgColor, UIColor(white: 0.42, alpha: 1).cgColor, UIColor(white: 0.16, alpha: 1).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.45, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            }
            // Soft boxes: one to the upper left of the viewer, one behind to the right.
            for (rect, alpha) in [(CGRect(x: 70, y: 52, width: 120, height: 56), 0.95), (CGRect(x: 330, y: 70, width: 90, height: 44), 0.7)] {
                cg.setShadow(offset: .zero, blur: 18, color: UIColor(white: 1, alpha: alpha).cgColor)
                cg.setFillColor(UIColor(white: 1, alpha: alpha).cgColor)
                cg.fillEllipse(in: rect)
            }
        }
    }

    /// A soft dark oval, fading to nothing: the device's shadow.
    private static func shadowImage() -> UIImage {
        let size = CGSize(width: 256, height: 256)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let colors = [UIColor(white: 0, alpha: 0.85).cgColor, UIColor(white: 0, alpha: 0.5).cgColor, UIColor(white: 0, alpha: 0.14).cgColor, UIColor(white: 0, alpha: 0).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.45, 0.75, 1]) {
                let centre = CGPoint(x: size.width / 2, y: size.height / 2)
                context.cgContext.drawRadialGradient(gradient, startCenter: centre, startRadius: 0, endCenter: centre, endRadius: size.width / 2, options: [])
            }
        }
    }
}
