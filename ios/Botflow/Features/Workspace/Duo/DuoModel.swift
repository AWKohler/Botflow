import SceneKit
import UIKit
import simd

/// The iPhone Duo as a SceneKit object, built from primitives — no model file.
/// Building it here lets the inner panel bend with the hinge as one sheet, and
/// means every surface that can be touched (two screens, three buttons) is
/// something this code placed and can map back to the simulator exactly.
///
/// Everything is in the device frame described in `DuoGeometry.swift`
/// (millimetres, camera half fixed, cover half turning about the hinge).
final class DuoModel {
    enum Finish: String, CaseIterable {
        case natural, graphite

        var frame: UIColor { self == .natural ? UIColor(red: 0.79, green: 0.77, blue: 0.74, alpha: 1) : UIColor(red: 0.29, green: 0.29, blue: 0.31, alpha: 1) }
        var back: UIColor { self == .natural ? UIColor(red: 0.86, green: 0.85, blue: 0.82, alpha: 1) : UIColor(red: 0.18, green: 0.18, blue: 0.20, alpha: 1) }
        var label: String { self == .natural ? "Natural" : "Graphite" }
    }

    struct Button {
        /// The wire protocol's name for it.
        let name: String
        let label: String
        let node: SCNNode
        let rest: SCNVector3
        /// Unit direction the button travels when pressed.
        let inward: SCNVector3
    }

    /// The device frame. Parent this; do not move its children.
    let root = SCNNode()
    let cameraHalf = SCNNode()
    let coverHalf = SCNNode()
    private let innerBezel = SCNNode()
    private let innerScreen = SCNNode()
    private let coverScreen = SCNNode()
    private let spine = SCNNode()
    private(set) var buttons: [Button] = []

    /// The two panels' pictures. Unlit: the app looks exactly as it does on the device.
    let screenMaterials: [DuoDisplay: SCNMaterial]

    private let frameMaterial = DuoModel.metal(roughness: 0.34)
    private let spineMaterial = DuoModel.metal(roughness: 0.42)
    private let buttonMaterial = DuoModel.metal(roughness: 0.28)
    private let backMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.metalness.contents = 0.0
        m.roughness.contents = 0.52
        m.clearCoat.contents = 0.35
        m.clearCoatRoughness.contents = 0.4
        return m
    }()
    private let glassMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.diffuse.contents = UIColor(white: 0.018, alpha: 1)
        m.metalness.contents = 0.0
        m.roughness.contents = 0.07
        m.clearCoat.contents = 1.0
        m.clearCoatRoughness.contents = 0.04
        return m
    }()

    private static let W = Duo.halfWidth
    private static let H = Duo.height
    private static let T = Duo.thickness
    /// Glass and plates sit this far inside the frame's outline…
    private static let rim = 0.75
    /// …and this far proud of the slab, so they never fight it for depth.
    private static let skin = 0.02

    private static func metal(roughness: Double) -> SCNMaterial {
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.metalness.contents = 1.0
        m.roughness.contents = roughness
        return m
    }

    private static func screenMaterial() -> SCNMaterial {
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = UIColor.black
        m.diffuse.minificationFilter = .linear
        m.diffuse.magnificationFilter = .linear
        m.diffuse.mipFilter = .linear
        m.diffuse.maxAnisotropy = 8
        m.diffuse.wrapS = .clamp
        m.diffuse.wrapT = .clamp
        return m
    }

    init(finish: Finish = .natural) {
        screenMaterials = [.inner: Self.screenMaterial(), .cover: Self.screenMaterial()]
        root.addChildNode(cameraHalf)
        root.addChildNode(coverHalf)
        cameraHalf.name = "half.camera"
        coverHalf.name = "half.cover"
        buildBodies()
        buildCameras()
        buildButtons()
        buildFaces()
        setFinish(finish)
        setFold(0)
    }

    func setFinish(_ finish: Finish) {
        frameMaterial.diffuse.contents = finish.frame
        spineMaterial.diffuse.contents = finish.frame.scaled(0.92)
        buttonMaterial.diffuse.contents = finish.frame.scaled(0.96)
        backMaterial.diffuse.contents = finish.back
        lensRingMaterial.diffuse.contents = finish == .natural ? UIColor(white: 0.6, alpha: 1) : UIColor(white: 0.23, alpha: 1)
    }

    // MARK: Shapes

    /// A rectangle with a radius per corner, drawn with the slightly squarer,
    /// longer-running curve Apple hardware uses rather than a plain arc.
    private static func roundedRect(x0: Double, y0: Double, x1: Double, y1: Double, tl: Double, tr: Double, br: Double, bl: Double) -> UIBezierPath {
        let limit = min(x1 - x0, y1 - y0) / 2
        func corner(_ r: Double) -> (e: Double, c: Double) {
            let radius = min(r, limit / 1.3)
            return (radius * 1.3, radius * 0.348)
        }
        let (TL, TR, BR, BL) = (corner(tl), corner(tr), corner(br), corner(bl))
        let p = UIBezierPath()
        p.move(to: CGPoint(x: x0 + BL.e, y: y0))
        p.addLine(to: CGPoint(x: x1 - BR.e, y: y0))
        p.addCurve(to: CGPoint(x: x1, y: y0 + BR.e), controlPoint1: CGPoint(x: x1 - BR.c, y: y0), controlPoint2: CGPoint(x: x1, y: y0 + BR.c))
        p.addLine(to: CGPoint(x: x1, y: y1 - TR.e))
        p.addCurve(to: CGPoint(x: x1 - TR.e, y: y1), controlPoint1: CGPoint(x: x1, y: y1 - TR.c), controlPoint2: CGPoint(x: x1 - TR.c, y: y1))
        p.addLine(to: CGPoint(x: x0 + TL.e, y: y1))
        p.addCurve(to: CGPoint(x: x0, y: y1 - TL.e), controlPoint1: CGPoint(x: x0 + TL.c, y: y1), controlPoint2: CGPoint(x: x0, y: y1 - TL.c))
        p.addLine(to: CGPoint(x: x0, y: y0 + BL.e))
        p.addCurve(to: CGPoint(x: x0 + BL.e, y: y0), controlPoint1: CGPoint(x: x0, y: y0 + BL.c), controlPoint2: CGPoint(x: x0 + BL.c, y: y0))
        p.close()
        p.flatness = 0.04
        return p
    }

    /// One half's outline, seen from the inner side. `inset` shrinks it evenly.
    private static func halfOutline(camera: Bool, inset: Double = 0) -> UIBezierPath {
        let outer = max(0.2, Duo.cornerRadius - inset), hinge = max(0.2, Duo.hingeCornerRadius - inset)
        return camera
            ? roundedRect(x0: inset, y0: -H / 2 + inset, x1: W - inset, y1: H / 2 - inset, tl: hinge, tr: outer, br: outer, bl: hinge)
            : roundedRect(x0: -W + inset, y0: -H / 2 + inset, x1: -inset, y1: H / 2 - inset, tl: outer, tr: hinge, br: hinge, bl: outer)
    }

    private func buildBodies() {
        for camera in [true, false] {
            let slab = SCNShape(path: Self.halfOutline(camera: camera), extrusionDepth: Self.T)
            slab.chamferRadius = Duo.edgeBevel
            slab.chamferMode = .both
            slab.materials = [frameMaterial]
            (camera ? cameraHalf : coverHalf).addChildNode(SCNNode(geometry: slab))
        }
        // Frosted glass over the camera half's back.
        let back = SCNShape(path: Self.halfOutline(camera: true, inset: Self.rim), extrusionDepth: 0.04)
        back.materials = [backMaterial]
        let backNode = SCNNode(geometry: back)
        backNode.position = SCNVector3(0, 0, Float(-Self.T / 2 - Self.skin))
        cameraHalf.addChildNode(backNode)
        // Black glass over the cover half's back; the cover panel sits in it.
        let glass = SCNShape(path: Self.halfOutline(camera: false, inset: Self.rim), extrusionDepth: 0.04)
        glass.materials = [glassMaterial]
        let glassNode = SCNNode(geometry: glass)
        glassNode.name = "glass.cover"
        glassNode.position = SCNVector3(0, 0, Float(-Self.T / 2 - Self.skin))
        coverHalf.addChildNode(glassNode)
    }

    private let lensRingMaterial = DuoModel.metal(roughness: 0.2)

    /// Camera plateau and lenses, on the camera half's back near the top.
    private func buildCameras() {
        let backZ = -Self.T / 2 - Self.skin
        let depth = 2.6
        let plateau = SCNShape(path: Self.roundedRect(x0: 24, y0: 33.4, x1: 77.2, y1: 54.1, tl: 9.6, tr: 9.6, br: 9.6, bl: 9.6), extrusionDepth: depth)
        plateau.chamferRadius = 0.7
        plateau.chamferMode = .back
        plateau.materials = [backMaterial]
        let plateauNode = SCNNode(geometry: plateau)
        plateauNode.position = SCNVector3(0, 0, Float(backZ - depth / 2))
        cameraHalf.addChildNode(plateauNode)

        let lensGlass = SCNMaterial()
        lensGlass.lightingModel = .physicallyBased
        lensGlass.diffuse.contents = UIColor(red: 0.04, green: 0.05, blue: 0.07, alpha: 1)
        lensGlass.metalness.contents = 0.2
        lensGlass.roughness.contents = 0.04
        lensGlass.clearCoat.contents = 1.0
        let lensCore = SCNMaterial()
        lensCore.lightingModel = .physicallyBased
        lensCore.diffuse.contents = UIColor(red: 0.10, green: 0.13, blue: 0.25, alpha: 1)
        lensCore.metalness.contents = 0.6
        lensCore.roughness.contents = 0.12
        lensCore.clearCoat.contents = 1.0
        let flash = SCNMaterial()
        flash.lightingModel = .physicallyBased
        flash.diffuse.contents = UIColor(red: 0.95, green: 0.91, blue: 0.81, alpha: 1)
        flash.roughness.contents = 0.4

        let top = backZ - depth
        /// A disc lying on the back, its outer face at `zOuter` (further from the body = more negative).
        func disc(_ radius: Double, _ height: Double, _ material: SCNMaterial, x: Double, y: Double, zOuter: Double) {
            let cylinder = SCNCylinder(radius: radius, height: height)
            cylinder.radialSegmentCount = 48
            cylinder.materials = [material]
            let node = SCNNode(geometry: cylinder)
            node.eulerAngles = SCNVector3(Float.pi / 2, 0, 0)
            node.position = SCNVector3(Float(x), Float(y), Float(zOuter + height / 2))
            cameraHalf.addChildNode(node)
        }
        for cx in [67.0, 49.2] {
            let ringOuter = top - 2.0
            disc(8.15, 2.0, lensRingMaterial, x: cx, y: 43.75, zOuter: ringOuter)
            disc(6.9, 0.3, lensGlass, x: cx, y: 43.75, zOuter: ringOuter - 0.12)
            disc(3.5, 0.2, lensCore, x: cx, y: 43.75, zOuter: ringOuter - 0.2)
            disc(1.5, 0.12, lensGlass, x: cx, y: 43.75, zOuter: ringOuter - 0.26)
        }
        disc(1.9, 0.25, flash, x: 32.6, y: 39.3, zOuter: top - 0.1)
        disc(0.55, 0.2, lensGlass, x: 32.6, y: 48.0, zOuter: top - 0.05)
    }

    /// Side buttons, all on the camera half: power and camera control on its
    /// outer edge, volume on its top edge.
    private func buildButtons() {
        func add(_ name: String?, _ label: String, size: (Double, Double, Double), at p: (Double, Double, Double), inward: SCNVector3, material: SCNMaterial) {
            let box = SCNBox(width: size.0, height: size.1, length: size.2, chamferRadius: min(size.0, size.1, size.2) * 0.45)
            box.materials = [material]
            let node = SCNNode(geometry: box)
            node.position = SCNVector3(Float(p.0), Float(p.1), Float(p.2))
            cameraHalf.addChildNode(node)
            if let name {
                node.name = "button.\(buttons.count)"
                buttons.append(Button(name: name, label: label, node: node, rest: node.position, inward: inward))
            }
        }
        let W = Self.W, H = Self.H
        add("lock", "Side button", size: (1.5, 18.2, 2.5), at: (W + 0.25, 16.0, 0), inward: SCNVector3(-1, 0, 0), material: buttonMaterial)
        add(nil, "Camera control", size: (0.9, 17.1, 2.7), at: (W - 0.2, -26.1, 0), inward: SCNVector3(-1, 0, 0), material: glassMaterial)
        add("volumeUp", "Volume up", size: (10.9, 1.5, 2.5), at: (56.05, H / 2 + 0.25, 0), inward: SCNVector3(0, -1, 0), material: buttonMaterial)
        add("volumeDown", "Volume down", size: (10.9, 1.5, 2.5), at: (42.65, H / 2 + 0.25, 0), inward: SCNVector3(0, -1, 0), material: buttonMaterial)
    }

    private func buildFaces() {
        innerBezel.name = "bezel.inner"
        innerScreen.name = "screen.inner"
        coverScreen.name = "screen.cover"
        spine.name = "spine"
        root.addChildNode(innerBezel)
        root.addChildNode(innerScreen)
        root.addChildNode(spine)
        coverHalf.addChildNode(coverScreen)

        // The cover panel is rigid: built once, facing backwards.
        let x0 = -(Duo.coverHingeInset + Duo.coverWidth), x1 = -Duo.coverHingeInset
        let z = -Self.T / 2 - Self.skin - 0.04
        coverScreen.geometry = Self.strip(
            x0: x0, x1: x1, halfHeight: Duo.coverHeight / 2,
            radiusLeft: Duo.coverCornerRadiusOuter, radiusRight: Duo.coverCornerRadiusHinge, bend: false, facingBack: true,
            point: { x, y in (SIMD3(x, y, z), SIMD3(0, 0, -1)) },
            uv: { x, y in
                let fb = Duo.coverFaceToFramebuffer(x: x, y: y)
                return CGPoint(x: fb.u, y: fb.v)
            },
            material: screenMaterials[.cover]!
        )
    }

    // MARK: Folding

    /// Pose the model for a fold (radians from flat).
    func setFold(_ beta: Double) {
        // Cover half: turn about the hinge axis (x = 0, z = hingeAxisZ).
        coverHalf.eulerAngles = SCNVector3(0, Float(beta), 0)
        coverHalf.position = SCNVector3(Float(-Duo.hingeAxisZ * sin(beta)), 0, Float(Duo.hingeAxisZ * (1 - cos(beta))))

        // Inner face: black glass edge to edge, the panel a hair above it.
        let W = Self.W, H = Self.H, rim = Self.rim
        innerBezel.geometry = Self.strip(
            x0: -W + rim, x1: W - rim, halfHeight: H / 2 - rim,
            radiusLeft: Duo.cornerRadius - rim, radiusRight: Duo.cornerRadius - rim, bend: true, facingBack: false,
            point: { x, y in Duo.innerFacePoint(x: x, y: y, beta: beta, lift: Self.skin) },
            // The flat position, which says where on the face a touch landed.
            uv: { x, y in CGPoint(x: x, y: y) },
            material: glassMaterial
        )
        innerScreen.geometry = Self.strip(
            x0: -Duo.innerWidth / 2, x1: Duo.innerWidth / 2, halfHeight: Duo.innerHeight / 2,
            radiusLeft: Duo.innerCornerRadius, radiusRight: Duo.innerCornerRadius, bend: true, facingBack: false,
            point: { x, y in Duo.innerFacePoint(x: x, y: y, beta: beta, lift: Self.skin + 0.03) },
            uv: { x, y in
                let fb = Duo.innerFaceToFramebuffer(x: x, y: y)
                return CGPoint(x: fb.u, y: fb.v)
            },
            material: screenMaterials[.inner]!
        )

        spine.isHidden = beta < 0.01
        if !spine.isHidden { spine.geometry = spineGeometry(beta) }
    }

    /// A rounded rectangle as a row of vertical strips, each column running
    /// from its bottom to its top edge (shorter in the corners). `point` places
    /// a flat position in space, which is what lets the inner face bend.
    private static func strip(
        x0: Double, x1: Double, halfHeight: Double, radiusLeft: Double, radiusRight: Double, bend: Bool, facingBack: Bool,
        point: (Double, Double) -> (position: SIMD3<Double>, normal: SIMD3<Double>),
        uv: (Double, Double) -> CGPoint, material: SCNMaterial
    ) -> SCNGeometry {
        var xs: [Double] = []
        let cornerSteps = 10
        // Fine columns through each corner, where the height changes.
        for i in 0...cornerSteps {
            let t = Double(i) / Double(cornerSteps)
            xs.append(x0 + radiusLeft * (1 - cos(t * .pi / 2)))
        }
        if bend {
            // And across the fold, where the sheet curves.
            let t0 = Duo.bendHalfWidth, steps = 30
            xs.append(-t0 * 2.5)
            for i in 0...steps { xs.append(-t0 + 2 * t0 * Double(i) / Double(steps)) }
            xs.append(t0 * 2.5)
        }
        for i in 0...cornerSteps {
            let t = Double(i) / Double(cornerSteps)
            xs.append(x1 - radiusRight * cos(t * .pi / 2))
        }
        xs = Array(Set(xs.map { ($0 * 1e4).rounded() / 1e4 })).filter { $0 >= x0 - 1e-6 && $0 <= x1 + 1e-6 }.sorted()

        /// How far the corners cut into the height at `x`.
        func inset(_ x: Double) -> Double {
            func cut(_ distance: Double, _ r: Double) -> Double {
                distance >= r ? 0 : r - (max(0, r * r - (r - distance) * (r - distance))).squareRoot()
            }
            return max(cut(x - x0, radiusLeft), cut(x1 - x, radiusRight))
        }

        var vertices: [SCNVector3] = [], normals: [SCNVector3] = [], coordinates: [CGPoint] = []
        for x in xs {
            let half = halfHeight - inset(x)
            for y in [half, -half] {
                let p = point(x, y)
                vertices.append(SCNVector3(Float(p.position.x), Float(p.position.y), Float(p.position.z)))
                normals.append(SCNVector3(Float(p.normal.x), Float(p.normal.y), Float(p.normal.z)))
                coordinates.append(uv(x, y))
            }
        }
        var indices: [UInt16] = []
        for column in 0..<(xs.count - 1) {
            let top = UInt16(column * 2), bottom = top + 1, nextTop = top + 2, nextBottom = top + 3
            // Counter-clockwise seen from the side the face looks out of.
            indices += facingBack ? [top, nextBottom, bottom, top, nextTop, nextBottom] : [top, bottom, nextBottom, top, nextBottom, nextTop]
        }
        let geometry = SCNGeometry(
            sources: [SCNGeometrySource(vertices: vertices), SCNGeometrySource(normals: normals), SCNGeometrySource(textureCoordinates: coordinates)],
            elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)]
        )
        geometry.materials = [material]
        return geometry
    }

    /// The rounded back of the hinge, which shows between the halves as they
    /// close: a wedge of a cylinder about the hinge axis, exactly as wide as
    /// the gap that has opened.
    private func spineGeometry(_ beta: Double) -> SCNGeometry {
        let segments = 28
        let radius = Duo.hingeAxisZ + Self.T / 2 - 0.02
        let half = Self.H / 2 - 1.4
        var vertices: [SCNVector3] = [], normals: [SCNVector3] = []
        var indices: [UInt16] = []
        // The curved wall.
        for i in 0...segments {
            let phi = beta * Double(i) / Double(segments)
            let nx = -sin(phi), nz = -cos(phi)
            for y in [half, -half] {
                vertices.append(SCNVector3(Float(radius * nx), Float(y), Float(Duo.hingeAxisZ + radius * nz)))
                normals.append(SCNVector3(Float(nx), 0, Float(nz)))
            }
        }
        for i in 0..<segments {
            let a = UInt16(i * 2)
            indices += [a, a + 1, a + 3, a, a + 3, a + 2]
        }
        // The two end caps: fans from the axis.
        for (y, ny) in [(half, 1.0), (-half, -1.0)] {
            let centre = UInt16(vertices.count)
            vertices.append(SCNVector3(0, Float(y), Float(Duo.hingeAxisZ)))
            normals.append(SCNVector3(0, Float(ny), 0))
            for i in 0...segments {
                let phi = beta * Double(i) / Double(segments)
                vertices.append(SCNVector3(Float(-radius * sin(phi)), Float(y), Float(Duo.hingeAxisZ - radius * cos(phi))))
                normals.append(SCNVector3(0, Float(ny), 0))
            }
            for i in 0..<segments {
                indices += [centre, centre + 1 + UInt16(i), centre + 2 + UInt16(i)]
            }
        }
        let geometry = SCNGeometry(
            sources: [SCNGeometrySource(vertices: vertices), SCNGeometrySource(normals: normals)],
            elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)]
        )
        // Seen from outside only, but drawing both sides spares working out a winding per fold.
        spineMaterial.isDoubleSided = true
        geometry.materials = [spineMaterial]
        return geometry
    }
}

private extension UIColor {
    func scaled(_ factor: CGFloat) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return UIColor(red: r * factor, green: g * factor, blue: b * factor, alpha: a)
    }
}
