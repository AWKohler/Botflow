import Foundation
import simd

/// The iPhone Duo as numbers: its dimensions, how its two halves move about
/// the hinge, where each panel's picture sits on the body, and which way up
/// iOS should draw for a given way of holding it. The same model as the web
/// app's (`src/components/persistent-workspace/duo/duo-geometry.ts`); keep the
/// two in step.
///
/// THE DEVICE FRAME. Millimetres. The device lies open and flat, inner screen
/// towards +Z (the viewer), hinge along the Y axis, top edge at +Y:
///
///   - the CAMERA HALF is x ≥ 0. It never moves in this frame. Its back (−Z)
///     carries the rear cameras, near the top.
///   - the COVER HALF is x ≤ 0. It turns about the hinge by the fold `beta`.
///     Its back carries the cover screen.
///
/// FOLD. `hinge` is what iOS and the wire protocol use: the angle between the
/// halves, 180° open flat … 0° shut. `beta = 180° − hinge` (in radians) is how
/// far the cover half has turned from flat.
enum Duo {
    /// One half: hinge edge to outer edge.
    static let halfWidth = 82.4
    static let height = 117.8
    /// One half, back to inner face.
    static let thickness = 5.6
    /// Space left between the two inner faces when shut.
    static let closedGap = 0.5
    static let cornerRadius = 11.6
    static let hingeCornerRadius = 1.6
    static let edgeBevel = 0.9

    /// Inner panel, centred on the open device.
    static let innerWidth = 158.0
    static let innerHeight = 110.8
    static let innerCornerRadius = 9.7

    /// Cover panel, on the back of the cover half. `coverHingeInset` is from
    /// that half's hinge edge to the panel's near edge.
    static let coverWidth = 77.4
    static let coverHeight = 112.2
    static let coverHingeInset = 2.5
    static let coverCornerRadiusOuter = 10.9
    static let coverCornerRadiusHinge = 1.2

    /// Half the width of the strip of inner panel that bends at the fold.
    static let bendHalfWidth = 4.0

    /// Framebuffer sizes in pixels (what the host streams).
    static let innerPixels = CGSize(width: 2007, height: 2853)
    static let coverPixels = CGSize(width: 1398, height: 2034)

    /// Z of the inner faces (device frame, flat).
    static let innerFaceZ = thickness / 2
    /// The hinge axis: x = 0, parallel to Y, this far towards the viewer.
    static let hingeAxisZ = innerFaceZ + closedGap / 2

    static func beta(hinge: Double) -> Double {
        (180 - min(180, max(0, hinge))) * .pi / 180
    }

    static func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        let t = min(1, max(0, (x - edge0) / (edge1 - edge0)))
        return t * t * (3 - 2 * t)
    }

    // MARK: Hinge

    /// A point that rides with the cover half, given where it is when open flat.
    static func coverHalfPoint(_ flat: SIMD3<Double>, beta: Double) -> SIMD3<Double> {
        let c = cos(beta), s = sin(beta)
        let dx = flat.x, dz = flat.z - hingeAxisZ
        return SIMD3(dx * c + dz * s, flat.y, hingeAxisZ - dx * s + dz * c)
    }

    static func coverHalfDirection(_ flat: SIMD3<Double>, beta: Double) -> SIMD3<Double> {
        let c = cos(beta), s = sin(beta)
        return SIMD3(flat.x * c + flat.z * s, flat.y, -flat.x * s + flat.z * c)
    }

    /// A point on the inner face, which is one flexible sheet across both
    /// halves. `x` is the position across the open device, measured along the
    /// sheet. Away from the fold the sheet lies flat on its half; within
    /// `bendHalfWidth` of it the sheet follows an arc that leaves both halves
    /// tangentially.
    static func innerFacePoint(x: Double, y: Double, beta: Double, lift: Double = 0) -> (position: SIMD3<Double>, normal: SIMD3<Double>) {
        let zs = innerFaceZ + lift
        let t0 = bendHalfWidth
        if x >= t0 || beta < 1e-4 {
            return (SIMD3(x, y, zs), SIMD3(0, 0, 1))
        }
        if x <= -t0 {
            return (coverHalfPoint(SIMD3(x, y, zs), beta: beta), coverHalfDirection(SIMD3(0, 0, 1), beta: beta))
        }
        let d = hingeAxisZ - zs
        let radius = d + t0 / tan(beta / 2)
        let phi = beta * (t0 - x) / (2 * t0)
        return (SIMD3(t0 - radius * sin(phi), y, zs + radius * (1 - cos(phi))), SIMD3(sin(phi), 0, cos(phi)))
    }

    /// Where the device's weight is: the midpoint of the two halves' centres.
    static func centroid(beta: Double) -> SIMD3<Double> {
        let camera = SIMD3(halfWidth / 2, 0.0, 0.0)
        let cover = coverHalfPoint(SIMD3(-halfWidth / 2, 0, 0), beta: beta)
        return (camera + cover) / 2
    }

    /// How far to turn the whole device about its hinge so the side in use
    /// faces the viewer: half the fold while part folded, none when open or
    /// nearly shut. Radians about +Y.
    static func autoYaw(beta: Double) -> Double {
        let bookish = 1 - smoothstep(95 * .pi / 180, 165 * .pi / 180, beta)
        return -beta / 2 * bookish
    }

    /// The hinge's back in cross-section, for a fold: points from straight
    /// behind the camera half round to straight behind the cover half, each
    /// with its outward normal. Flush with both backs at its ends; in between
    /// it is pulled in towards the axis, more the further the device has
    /// closed, so that shut it stands `proud` beyond the halves' edges rather
    /// than a whole radius (a plain arc would look like a thick rail).
    static func spineProfile(beta: Double, segments: Int, radius: Double, proud: Double = 2.3) -> [(x: Double, z: Double, nx: Double, nz: Double)] {
        let flatten = (1 - proud / radius) * pow(sin(beta / 2), 2)
        let points: [(x: Double, z: Double)] = (0...segments).map { i in
            let t = Double(i) / Double(segments)
            let phi = beta * t
            let r = radius * (1 - flatten * sin(.pi * t))
            return (-r * sin(phi), hingeAxisZ - r * cos(phi))
        }
        return points.indices.map { i in
            // Outward normal: perpendicular to the run of the curve here.
            let a = points[max(0, i - 1)], b = points[min(segments, i + 1)]
            let tx = b.x - a.x, tz = b.z - a.z
            let length = max(1e-9, (tx * tx + tz * tz).squareRoot())
            return (points[i].x, points[i].z, -tz / length, tx / length)
        }
    }

    // MARK: Where the pictures sit
    // A framebuffer coordinate is (u, v) in 0…1, origin at the top left of the
    // image the host streams. Touches are sent in the same terms.

    /// Inner panel: the image's left edge is the device's top, its top edge
    /// the camera half's outer edge.
    static func innerFaceToFramebuffer(x: Double, y: Double) -> (u: Double, v: Double) {
        ((innerHeight / 2 - y) / innerHeight, (innerWidth / 2 - x) / innerWidth)
    }

    /// Cover panel, in the cover half's own flat coordinates (x ≤ 0, hinge at 0).
    static func coverFaceToFramebuffer(x: Double, y: Double) -> (u: Double, v: Double) {
        ((-x - coverHingeInset) / coverWidth, (coverHeight / 2 - y) / coverHeight)
    }
}

enum DuoDisplay: String, CaseIterable, Sendable {
    case cover, inner

    /// Stream index of the panel in a video chunk's flags (bits 1–2).
    var streamIndex: Int { self == .cover ? 0 : 1 }
}

/// How the device is held, as its motion sensors would report it (the wire
/// protocol's `device_orientation`).
enum DuoHeldOrientation: String, Sendable {
    case portrait
    case portraitUpsideDown = "portrait-upside-down"
    case landscapeLeft = "landscape-left"
    case landscapeRight = "landscape-right"

    /// How iOS should be told the device is held, from which way is up.
    /// `cameraHalf` and `coverHalf` are the world's up direction as each half
    /// sees it, in the flat device's axes (x across the device towards the
    /// camera half's outer edge, y towards its top); their length says how
    /// upright that half is. With the cover screen in use only its half
    /// counts. `previous` stands unless another way up is clearly better.
    static func from(cameraHalf: SIMD2<Double>, coverHalf: SIMD2<Double>, coverInUse: Bool, previous: DuoHeldOrientation) -> DuoHeldOrientation {
        let v = coverInUse ? coverHalf : cameraHalf + coverHalf
        let scale = coverInUse ? 1.0 : 2.0
        if simd_length(v) < 0.3 * scale { return previous }
        func score(_ o: DuoHeldOrientation) -> Double {
            switch o {
            case .portrait: return v.y
            case .portraitUpsideDown: return -v.y
            case .landscapeLeft: return v.x
            case .landscapeRight: return -v.x
            }
        }
        var best = previous
        for candidate in [DuoHeldOrientation.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight] where score(candidate) > score(best) {
            best = candidate
        }
        if best == previous { return previous }
        return score(best) - score(previous) > 0.28 * scale ? best : previous
    }
}

/// A named posture: a fold and an attitude together.
struct DuoPose: Identifiable, Equatable {
    enum ID: String { case closed, open, book, tabletop }
    var id: ID
    var label: String
    var symbol: String
    /// Hinge angle in degrees (180 open … 0 shut).
    var hinge: Double
    /// Tilt about the screen's horizontal axis, in degrees.
    var pitch: Double = 0
    /// Stand the device on its cover half, hinge level.
    var tabletop = false

    static let all: [DuoPose] = [
        DuoPose(id: .closed, label: "Closed", symbol: "iphone", hinge: 0),
        DuoPose(id: .open, label: "Open", symbol: "rectangle.split.2x1", hinge: 180),
        DuoPose(id: .book, label: "Book", symbol: "book", hinge: 125, pitch: -8),
        DuoPose(id: .tabletop, label: "Tabletop", symbol: "laptopcomputer", hinge: 105, tabletop: true),
    ]
}
