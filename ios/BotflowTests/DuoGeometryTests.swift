import XCTest
import simd
@testable import Botflow

/// The iPhone Duo's geometry: how the halves fold, where each panel's picture
/// sits, and which way up iOS is told the device is. The same cases as the
/// web app's `duo-geometry.test.ts`; the two models must agree.
final class DuoGeometryTests: XCTestCase {
    private let rad = Double.pi / 180

    func testHingeAngleAndFoldRunOppositeWays() {
        XCTAssertEqual(Duo.beta(hinge: 180), 0, accuracy: 1e-9)
        XCTAssertEqual(Duo.beta(hinge: 0), .pi, accuracy: 1e-9)
        XCTAssertEqual(Duo.beta(hinge: 500), 0, accuracy: 1e-9)
    }

    func testShutTheInnerFacesMeetWithTheClosedGapBetweenThem() {
        let p = Duo.coverHalfPoint(SIMD3(-40, 0, Duo.innerFaceZ), beta: .pi)
        XCTAssertEqual(p.x, 40, accuracy: 1e-6)
        XCTAssertEqual(p.z, Duo.innerFaceZ + Duo.closedGap, accuracy: 1e-6)
        XCTAssertEqual(Duo.coverHalfDirection(SIMD3(0, 0, 1), beta: .pi).z, -1, accuracy: 1e-6)
    }

    func testFoldingSwingsTheCoverHalfTowardsTheViewer() {
        let p = Duo.coverHalfPoint(SIMD3(-Duo.halfWidth, 0, 0), beta: 90 * rad)
        XCTAssertGreaterThan(p.z, Duo.halfWidth - 10)
        XCTAssertLessThan(abs(p.x), 10)
    }

    func testCentreOfWeightStartsInTheMiddleAndEndsOverTheCameraHalf() {
        XCTAssertEqual(Duo.centroid(beta: 0).x, 0, accuracy: 1e-9)
        XCTAssertEqual(Duo.centroid(beta: .pi).x, Duo.halfWidth / 2, accuracy: 1e-6)
    }

    func testTheDeviceTurnsToFaceItsHalvesEvenlyOnlyWhenPartFolded() {
        XCTAssertEqual(Duo.autoYaw(beta: 0), 0, accuracy: 1e-9)
        XCTAssertEqual(Duo.autoYaw(beta: 60 * rad), -30 * rad, accuracy: 1e-9)
        XCTAssertEqual(Duo.autoYaw(beta: .pi), 0, accuracy: 1e-9)
    }

    func testTheBendJoinsBothHalvesWithoutAStepOrAKink() {
        let t0 = Duo.bendHalfWidth
        for beta in [5 * rad, 60 * rad, 120 * rad, 175 * rad] {
            let a = Duo.innerFacePoint(x: t0 - 1e-7, y: 0, beta: beta), b = Duo.innerFacePoint(x: t0, y: 0, beta: beta)
            XCTAssertEqual(a.position.x, b.position.x, accuracy: 1e-4)
            XCTAssertEqual(a.position.z, b.position.z, accuracy: 1e-4)
            let c = Duo.innerFacePoint(x: -t0 + 1e-7, y: 0, beta: beta), d = Duo.innerFacePoint(x: -t0, y: 0, beta: beta)
            XCTAssertEqual(c.position.x, d.position.x, accuracy: 1e-4)
            XCTAssertEqual(c.position.z, d.position.z, accuracy: 1e-4)
            XCTAssertEqual(c.normal.x, d.normal.x, accuracy: 1e-4)
            XCTAssertEqual(c.normal.z, d.normal.z, accuracy: 1e-4)
        }
    }

    func testInnerImageIsAQuarterTurnFromThePanel() {
        // The image's top-left corner is the panel's top-right (camera half, top).
        let topRight = Duo.innerFaceToFramebuffer(x: Duo.innerWidth / 2, y: Duo.innerHeight / 2)
        XCTAssertEqual(topRight.u, 0, accuracy: 1e-9)
        XCTAssertEqual(topRight.v, 0, accuracy: 1e-9)
        // Its left edge runs along the device's top.
        let topLeft = Duo.innerFaceToFramebuffer(x: -Duo.innerWidth / 2, y: Duo.innerHeight / 2)
        XCTAssertEqual(topLeft.u, 0, accuracy: 1e-9)
        XCTAssertEqual(topLeft.v, 1, accuracy: 1e-9)
    }

    func testCoverImageHasTheHingeOnItsLeft() {
        let nearHingeTop = Duo.coverFaceToFramebuffer(x: -Duo.coverHingeInset, y: Duo.coverHeight / 2)
        XCTAssertEqual(nearHingeTop.u, 0, accuracy: 1e-9)
        XCTAssertEqual(nearHingeTop.v, 0, accuracy: 1e-9)
        let outerBottom = Duo.coverFaceToFramebuffer(x: -(Duo.coverHingeInset + Duo.coverWidth), y: -Duo.coverHeight / 2)
        XCTAssertEqual(outerBottom.u, 1, accuracy: 1e-9)
        XCTAssertEqual(outerBottom.v, 1, accuracy: 1e-9)
    }

    func testPanelsAndTheirImagesHaveTheSameProportions() {
        XCTAssertEqual(Duo.innerWidth / Duo.innerHeight, Double(Duo.innerPixels.height / Duo.innerPixels.width), accuracy: 0.01)
        XCTAssertEqual(Duo.coverHeight / Duo.coverWidth, Double(Duo.coverPixels.height / Duo.coverPixels.width), accuracy: 0.01)
    }

    func testWhichWayUp() {
        typealias O = DuoHeldOrientation
        XCTAssertEqual(O.from(cameraHalf: SIMD2(0, 1), coverHalf: SIMD2(0, 1), coverInUse: false, previous: .landscapeLeft), .portrait)
        XCTAssertEqual(O.from(cameraHalf: SIMD2(1, 0), coverHalf: SIMD2(1, 0), coverInUse: false, previous: .portrait), .landscapeLeft)
        XCTAssertEqual(O.from(cameraHalf: SIMD2(-1, 0), coverHalf: SIMD2(-1, 0), coverInUse: false, previous: .portrait), .landscapeRight)
        XCTAssertEqual(O.from(cameraHalf: SIMD2(0, -1), coverHalf: SIMD2(0, -1), coverInUse: false, previous: .portrait), .portraitUpsideDown)
        // Lying flat says nothing: the last answer stands.
        XCTAssertEqual(O.from(cameraHalf: SIMD2(0.05, 0.02), coverHalf: SIMD2(0.03, 0.02), coverInUse: false, previous: .landscapeRight), .landscapeRight)
        // Near a diagonal it does not flip-flop.
        XCTAssertEqual(O.from(cameraHalf: SIMD2(0.74, 0.67), coverHalf: SIMD2(0.74, 0.67), coverInUse: false, previous: .portrait), .portrait)
        XCTAssertEqual(O.from(cameraHalf: SIMD2(0.95, 0.3), coverHalf: SIMD2(0.95, 0.3), coverInUse: false, previous: .portrait), .landscapeLeft)
        // Standing on one half, the half that is upright decides.
        XCTAssertEqual(O.from(cameraHalf: SIMD2(0.95, 0), coverHalf: SIMD2(0, 0), coverInUse: false, previous: .portrait), .landscapeLeft)
        // With the cover screen in use only the cover half counts.
        XCTAssertEqual(O.from(cameraHalf: SIMD2(1, 0), coverHalf: SIMD2(0, 1), coverInUse: true, previous: .landscapeLeft), .portrait)
    }

    func testHingeSpineIsFlushAtItsEndsAndOnlyALittleProudWhenShut() {
        let radius = Duo.hingeAxisZ + Duo.thickness / 2
        let shut = Duo.spineProfile(beta: .pi, segments: 28, radius: radius)
        XCTAssertEqual(shut.first!.x, 0, accuracy: 1e-9)
        XCTAssertEqual(shut.first!.z, Duo.hingeAxisZ - radius, accuracy: 1e-9)
        XCTAssertEqual(shut.map(\.x).min()!, -2.3, accuracy: 0.2)
        for p in Duo.spineProfile(beta: 120 * rad, segments: 28, radius: radius) {
            XCTAssertGreaterThan(p.nx * p.x + p.nz * (p.z - Duo.hingeAxisZ), 0)
        }
    }

    func testStreamFlagsCarryTheDuoPanel() {
        XCTAssertEqual(DuoDisplay.cover.streamIndex, 0)
        XCTAssertEqual(DuoDisplay.inner.streamIndex, 1)
        XCTAssertEqual(SimDevice.duo.rawValue, "iPhone-Duo")
        XCTAssertEqual(DuoHeldOrientation.portraitUpsideDown.rawValue, "portrait-upside-down")
    }

    func testDuoInputsAreEncodedAsTheHostExpects() {
        XCTAssertEqual(SimInput.hinge(104.96).json["angle"]?.doubleValue, 105)
        XCTAssertEqual(SimInput.deviceOrientation("landscape-left").json["kind"]?.stringValue, "device_orientation")
        let touch = SimInput.touch(display: "inner", phase: "down", x: 0.25, y: 0.5, finger: 1).json
        XCTAssertEqual(touch["display"]?.stringValue, "inner")
        XCTAssertEqual(touch["finger"]?.intValue, 1)
        XCTAssertEqual(SimInput.button("volumeUp").json["button"]?.stringValue, "volumeUp")
    }
}
