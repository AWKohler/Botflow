import MetalKit
import SwiftUI
import UIKit

/// The iPhone Duo preview: the device as an object you can turn, fold and use.
/// Both of its screens play the simulator's video; touching either one touches
/// the app. The 3D work is in `DuoSceneView`; this lays the controls under it
/// and keeps it in step with the session.
struct DuoStage: View {
    @ObservedObject var controller: SimulatorController
    var keyboard: Bool
    /// Edge to edge over the workspace: dark, and the controls stay compact.
    var fullScreen = false
    var onShowIssues: () -> Void

    @StateObject private var link = DuoSceneLink()
    @State private var hinge = 180.0
    @State private var pose: DuoPose.ID? = .open
    @AppStorage("sim.duo.finish") private var finishName = DuoModel.Finish.natural.rawValue
    @AppStorage("sim.duo.hintSeen") private var hintSeen = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var finish: DuoModel.Finish { DuoModel.Finish(rawValue: finishName) ?? .natural }
    private var live: Bool { controller.phase == .live }

    var body: some View {
        VStack(spacing: Space.s) {
            ZStack {
                DuoSceneRepresentable(controller: controller, link: link, keyboardShown: keyboard, finish: finish) { shown in
                    hinge = shown.rounded()
                }
                if !live {
                    // The model stays in view (and can be posed) behind the status.
                    SimulatorStateOverlay(controller: controller, onShowIssues: onShowIssues)
                        .padding(controller.phase == .stopped ? 0 : Space.l)
                        .background {
                            if controller.phase != .stopped {
                                RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.black.opacity(0.66))
                                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                            }
                        }
                        .frame(maxWidth: 340)
                        .padding(Space.l)
                } else if !hintSeen, !fullScreen {
                    hint
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            controls
        }
        .environment(\.colorScheme, fullScreen ? .dark : colorSchemeFromEnvironment)
        #if DEBUG
        .task {
            // `-BotflowDuoPose book` opens in a posture, for tests and screenshots.
            guard let raw = UserDefaults.standard.string(forKey: "BotflowDuoPose"), let id = DuoPose.ID(rawValue: raw),
                  let item = DuoPose.all.first(where: { $0.id == id }) else { return }
            try? await Task.sleep(nanoseconds: 600_000_000)
            pose = id
            link.view?.apply(item)
        }
        #endif
    }

    @Environment(\.colorScheme) private var colorSchemeFromEnvironment

    private var hint: some View {
        VStack {
            Text("Drag beside the device to turn it. Pinch to zoom.")
                .font(.footnote)
                .foregroundStyle(Sand.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Space.m)
                .padding(.vertical, Space.s)
                .background(Sand.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Sand.border, lineWidth: 1))
                .onTapGesture { hintSeen = true }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Dismisses this note")
            Spacer()
        }
        .padding(.top, Space.s)
        .allowsHitTesting(true)
        .transition(.opacity)
    }

    // MARK: Controls

    private var controls: some View {
        // One row where it fits; postures above the hinge and view controls where it does not.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.m) {
                postures(labels: true)
                hingeSlider.frame(minWidth: 150, maxWidth: 240)
                viewButtons
            }
            VStack(spacing: Space.s) {
                HStack(spacing: Space.s) {
                    postures(labels: !typeSize.isAccessibilitySize)
                    Spacer(minLength: 0)
                    viewButtons
                }
                hingeSlider
            }
            VStack(spacing: Space.s) {
                HStack(spacing: Space.s) {
                    postures(labels: false)
                    Spacer(minLength: 0)
                    viewButtons
                }
                hingeSlider
            }
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, Space.s)
        .background(Sand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
    }

    private func isActive(_ item: DuoPose) -> Bool {
        if hinge <= 3 { return item.id == .closed }
        if hinge >= 177 { return item.id == .open }
        return pose == item.id && abs(item.hinge - hinge) < 1
    }

    private func postures(labels: Bool) -> some View {
        HStack(spacing: 2) {
            ForEach(DuoPose.all) { item in
                let active = isActive(item)
                Button {
                    Haptics.select()
                    pose = item.id
                    hintSeen = true
                    link.view?.apply(item)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: item.symbol).imageScale(.small)
                        if labels { Text(item.label).lineLimit(1).fixedSize() }
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(active ? Sand.text : Sand.muted)
                    .padding(.horizontal, labels ? 10 : 9)
                    .frame(minHeight: 36)
                    .background(active ? Sand.surface : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(active ? Sand.borderStrong : Color.clear, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(scale: 0.96))
                .accessibilityLabel(item.label)
                .accessibilityAddTraits(active ? .isSelected : [])
            }
        }
    }

    private var hingeSlider: some View {
        HStack(spacing: Space.s) {
            Slider(
                value: Binding(get: { hinge }, set: { value in
                    hinge = value
                    pose = nil
                    link.view?.setHinge(value, settled: false)
                }),
                in: 0...180,
                step: 1
            ) { editing in
                if !editing { link.view?.setHinge(hinge, settled: true) }
            }
            .tint(Sand.text)
            .accessibilityLabel("Hinge angle")
            .accessibilityValue("\(Int(hinge)) degrees")
            Text("\(Int(hinge))°")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(Sand.muted)
                .frame(width: 38, alignment: .trailing)
                .accessibilityHidden(true)
        }
    }

    private var viewButtons: some View {
        HStack(spacing: 2) {
            iconButton("house", "Home Screen") { controller.pressButton("home") }
                .disabled(!live)
                .opacity(live ? 1 : 0.4)
            iconButton("rotate.left", "Turn the device left") { link.view?.rollQuarter(left: true) }
            iconButton("rotate.right", "Turn the device right") { link.view?.rollQuarter(left: false) }
            Menu {
                Button { link.view?.resetView() } label: { Label("Reset the view", systemImage: "scope") }
                Picker("Finish", selection: $finishName) {
                    ForEach(DuoModel.Finish.allCases, id: \.rawValue) { Text($0.label).tag($0.rawValue) }
                }
                if live {
                    Button { controller.pressButton("lock") } label: { Label("Side button", systemImage: "lock") }
                    Button { controller.pressButton("volumeUp") } label: { Label("Volume up", systemImage: "speaker.plus") }
                    Button { controller.pressButton("volumeDown") } label: { Label("Volume down", systemImage: "speaker.minus") }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Sand.muted)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("More device controls")
        }
    }

    private func iconButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Sand.muted)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.92))
        .accessibilityLabel(label)
    }
}

/// Lets the SwiftUI controls reach the UIKit scene view.
@MainActor
final class DuoSceneLink: ObservableObject {
    weak var view: DuoSceneView?
}

struct DuoSceneRepresentable: UIViewRepresentable {
    @ObservedObject var controller: SimulatorController
    var link: DuoSceneLink
    var keyboardShown: Bool
    var finish: DuoModel.Finish
    var onHingeShown: (Double) -> Void

    final class Coordinator {
        var sink: UUID?
        weak var controller: SimulatorController?
        /// The session this view last told its posture to.
        var announced = false
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> DuoSceneView {
        let view = DuoSceneView(frame: .zero)
        link.view = view
        let controller = controller
        context.coordinator.controller = controller
        view.onTouch = { [weak controller] display, phase, x, y, finger in
            controller?.duoTouch(display, phase: phase, x: x, y: y, finger: finger)
        }
        view.onHingeRequest = { [weak controller] hinge, settled in controller?.setDuoHinge(hinge, settled: settled) }
        view.onHingeShown = { hinge in onHingeShown(hinge) }
        view.onOrientation = { [weak controller] orientation in controller?.setDuoOrientation(orientation) }
        view.onButton = { [weak controller] button in controller?.pressButton(button) }
        view.onText = { [weak controller] text in controller?.type(text) }
        view.onKey = { [weak controller] key in controller?.key(key) }
        context.coordinator.sink = controller.addDuoSink { [weak view] display, frame in view?.setFrame(display, frame) }
        return view
    }

    func updateUIView(_ view: DuoSceneView, context: Context) {
        let live = controller.phase == .live
        view.live = live
        view.dim = live ? 0 : 0.55
        view.finish = finish
        if !controller.phase.isActive, !controller.hasFrame { view.clearFrames() }
        // A session comes up open and upright. The first time it reports in,
        // the device here may already be folded or turned (posed while the app
        // was building): then the session is told, instead of the device being
        // put back. After that the host's reports are followed.
        if live, let state = controller.duoState {
            view.lit = [.cover: state.coverLit, .inner: state.innerLit]
            if context.coordinator.announced {
                view.setReportedHinge(state.hingeAngle)
            } else {
                context.coordinator.announced = true
                if abs(view.hingeTarget - state.hingeAngle) > 1 {
                    // Through the view, so it also holds off the host's reports while the hinge eases there.
                    view.setHinge(view.hingeTarget, settled: true)
                } else {
                    view.setReportedHinge(state.hingeAngle)
                }
                controller.setDuoOrientation(view.orientation)
            }
        } else {
            context.coordinator.announced = false
        }
        if keyboardShown, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !keyboardShown, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }

    static func dismantleUIView(_ view: DuoSceneView, coordinator: Coordinator) {
        if let sink = coordinator.sink { coordinator.controller?.removeDuoSink(sink) }
    }
}

/// Stand-in pictures for a Duo's two panels in demo mode: the demo app, drawn
/// the way each panel's framebuffer holds it.
@MainActor
enum DuoDemoFrames {
    static func make() -> [DuoDisplay: DuoFrame] {
        guard let device = DuoVideoDecoder.device else { return [:] }
        let loader = MTKTextureLoader(device: device)
        var frames: [DuoDisplay: DuoFrame] = [:]
        // The cover is upright in its framebuffer. The inner panel's interface
        // is drawn a quarter turn round in its (taller than wide) framebuffer.
        let jobs: [(DuoDisplay, CGSize, Bool)] = [
            (.cover, CGSize(width: 466, height: 678), false),
            (.inner, CGSize(width: 951, height: 669), true),
        ]
        for (display, points, quarterTurn) in jobs {
            let renderer = ImageRenderer(content: DemoAppScreen().frame(width: points.width, height: points.height).background(Color.black))
            renderer.scale = 2
            guard let upright = renderer.cgImage else { continue }
            let image = quarterTurn ? rotatedQuarterTurnCounterClockwise(upright) ?? upright : upright
            let options: [MTKTextureLoader.Option: Any] = [.SRGB: true, .origin: MTKTextureLoader.Origin.topLeft, .generateMipmaps: false]
            guard let texture = try? loader.newTexture(cgImage: image, options: options) else { continue }
            frames[display] = DuoFrame(texture: texture, backing: nil, pixelBuffer: nil)
        }
        return frames
    }

    /// The image turned so its top is at the left: how the inner panel's
    /// framebuffer holds an interface that reads upright on the open device.
    private static func rotatedQuarterTurnCounterClockwise(_ image: CGImage) -> CGImage? {
        let w = image.width, h = image.height
        guard let context = CGContext(
            data: nil, width: h, height: w, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.translateBy(x: CGFloat(h), y: 0)
        context.rotate(by: .pi / 2)
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return context.makeImage()
    }
}
