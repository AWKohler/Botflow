import SwiftUI

/// The live iOS simulator for a Swift project, framed like the device it is
/// running. Touch it as you would the real app; full screen takes over the
/// whole workspace (`ImmersiveSimulatorView`).
struct SimulatorView: View {
    @ObservedObject var controller: SimulatorController
    @Binding var immersive: Bool
    @State private var keyboard = false
    @State private var showIssues = false

    var body: some View {
        VStack(spacing: Space.m) {
            controlBar
            if immersive {
                // The video is on the full-screen surface; say so here.
                VStack(spacing: Space.m) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.title2).foregroundStyle(Sand.subtle)
                    Text("Playing full screen").font(.subheadline).foregroundStyle(Sand.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                device.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if !controller.diagnostics.isEmpty { issuesButton }
        }
        .padding(.horizontal, Space.m)
        .padding(.bottom, Space.m)
        .sheet(isPresented: $showIssues) { BuildIssuesSheet(controller: controller).tint(Sand.text) }
        .onChange(of: controller.phase) { _, phase in
            if phase != .live { keyboard = false }
            if case .failed = phase, !controller.diagnostics.isEmpty { showIssues = true }
        }
        .onDisappear { keyboard = false }
    }

    // MARK: Controls

    /// One row that sheds labels and then controls as the pane narrows (an
    /// open Duo's app pane, a large text size) instead of wrapping.
    private var controlBar: some View {
        ViewThatFits(in: .horizontal) {
            bar(deviceLabel: true, rotateInline: true)
            bar(deviceLabel: false, rotateInline: true)
            bar(deviceLabel: false, rotateInline: false)
        }
    }

    private func bar(deviceLabel: Bool, rotateInline: Bool) -> some View {
        HStack(spacing: Space.s) {
            SimulatorStatusPill(controller: controller)
            Spacer(minLength: Space.s)
            Menu {
                Picker("Device", selection: Binding(get: { controller.device }, set: { device in Task { await controller.setDevice(device) } })) {
                    ForEach(SimDevice.allCases, id: \.self) { device in
                        Label(device.label, systemImage: device.symbol).tag(device)
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: controller.device.symbol)
                    if deviceLabel { Text(controller.device.label).lineLimit(1).fixedSize() }
                    Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(Sand.subtle)
                }
            }
            .buttonStyle(RaisedButtonStyle(size: .small))
            .accessibilityLabel("Device: \(controller.device.label)")

            if rotateInline {
                Button {
                    controller.toggleOrientation()
                } label: {
                    Image(systemName: controller.landscape ? "rectangle.landscape.rotate" : "rectangle.portrait.rotate")
                }
                .buttonStyle(RaisedButtonStyle(size: .small))
                .accessibilityLabel(controller.landscape ? "Rotate to portrait" : "Rotate to landscape")
            }

            if controller.phase == .live {
                Button {
                    Haptics.tap()
                    immersive = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(RaisedButtonStyle(size: .small))
                .accessibilityLabel("Full screen")
                .accessibilityIdentifier("simulator.fullscreen")
            }

            Menu {
                if controller.phase.isActive {
                    Button { Task { await controller.rebuild() } } label: { Label("Rebuild", systemImage: "hammer") }
                    Button { keyboard.toggle() } label: { Label(keyboard ? "Hide keyboard" : "Type with the keyboard", systemImage: "keyboard") }
                        .disabled(controller.phase != .live)
                }
                if !rotateInline {
                    Button { controller.toggleOrientation() } label: { Label(controller.landscape ? "Rotate to portrait" : "Rotate to landscape", systemImage: "rectangle.portrait.rotate") }
                }
                Toggle(isOn: $controller.liveScroll) { Label("Drags scroll the page", systemImage: "hand.draw") }
                Button { controller.touchHintSeen = false } label: { Label("How touch works", systemImage: "hand.tap") }
                if controller.phase.isActive {
                    Divider()
                    Button(role: .destructive) { Task { await controller.stop() } } label: { Label("Stop simulator", systemImage: "stop.fill") }
                }
            } label: {
                Image(systemName: "ellipsis").frame(width: 20, height: 20)
            }
            .buttonStyle(RaisedButtonStyle(size: .small))
            .accessibilityLabel("Simulator options")
        }
    }

    private var issuesButton: some View {
        Button { showIssues = true } label: {
            HStack(spacing: Space.s) {
                Image(systemName: controller.errors.isEmpty ? "exclamationmark.triangle" : "xmark.octagon.fill")
                    .foregroundStyle(controller.errors.isEmpty ? Sand.warning : Sand.danger)
                Text(issueSummary)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Sand.text)
                Spacer()
                Image(systemName: "chevron.up").font(.footnote.weight(.semibold)).foregroundStyle(Sand.subtle)
            }
            .padding(.horizontal, Space.l)
            .frame(minHeight: 46)
            .sandCard(radius: 14)
        }
        .buttonStyle(PressableStyle())
    }

    private var issueSummary: String {
        let errors = controller.errors.count, warnings = controller.warnings.count
        var parts: [String] = []
        if errors > 0 { parts.append(errors == 1 ? "1 error" : "\(errors) errors") }
        if warnings > 0 { parts.append(warnings == 1 ? "1 warning" : "\(warnings) warnings") }
        return parts.joined(separator: ", ")
    }

    // MARK: Device

    private var device: some View {
        GeometryReader { proxy in
            let aspect = controller.displaySize.width / max(1, controller.displaySize.height)
            let bezel: CGFloat = 9
            let available = CGSize(width: proxy.size.width - bezel * 2, height: proxy.size.height - bezel * 2)
            let width = max(1, min(available.width, available.height * aspect))
            let height = width / aspect
            let radius = min(width, height) * (controller.device == .iPhone ? 0.125 : 0.045)
            ZStack {
                RoundedRectangle(cornerRadius: radius + bezel, style: .continuous)
                    .fill(Color(hex: 0x1a1a1c))
                    .overlay(
                        RoundedRectangle(cornerRadius: radius + bezel, style: .continuous)
                            .strokeBorder(LinearGradient(colors: [Color(hex: 0x8e8e93), Color(hex: 0x3a3a3c), Color(hex: 0x6e6e73)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 2)
                    )
                    .shadow(color: Sand.shadow.opacity(0.22), radius: 26, y: 14)
                    .frame(width: width + bezel * 2, height: height + bezel * 2)
                SimulatorScreen(controller: controller, keyboard: keyboard, cornerRadius: radius) { showIssues = true }
                    .frame(width: width, height: height)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// What the simulator is doing, in a pill. Only the pill animates when the
/// phase changes.
struct SimulatorStatusPill: View {
    @ObservedObject var controller: SimulatorController

    private var key: String {
        switch controller.phase {
        case .live: return "live"
        case .starting(let label): return "starting-\(label)"
        case .building: return "building"
        case .installing: return "installing"
        case .failed: return "failed"
        case .ended, .stopped: return "stopped"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            switch controller.phase {
            case .live:
                Circle().fill(Sand.successSolid).frame(width: 7, height: 7)
                Text("Live")
            case .starting(let label):
                ProgressView().controlSize(.mini)
                Text(label)
            case .building:
                ProgressView().controlSize(.mini)
                if let started = controller.buildStartedAt {
                    Text("Building ") + Text(started, style: .timer).monospacedDigit()
                } else {
                    Text("Building")
                }
            case .installing:
                ProgressView().controlSize(.mini)
                Text("Launching")
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Sand.danger)
                Text("Build failed")
            case .ended, .stopped:
                Circle().fill(Sand.borderStrong).frame(width: 7, height: 7)
                Text("Stopped")
            }
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Sand.muted)
        .lineLimit(1)
        .fixedSize()
        .id(key)
        .transition(.opacity)
        .padding(.horizontal, Space.m)
        .frame(minHeight: 38)
        .background(Sand.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Sand.border, lineWidth: 1))
        .animation(.snappy(duration: 0.25), value: key)
        .accessibilityElement(children: .combine)
    }
}

/// The simulated screen itself: video (or the demo stand-in), the state shown
/// over it, and the one-time note on how touch works. Used framed in the pane
/// and edge to edge in full screen.
struct SimulatorScreen: View {
    @ObservedObject var controller: SimulatorController
    var keyboard: Bool
    var cornerRadius: CGFloat
    var onShowIssues: () -> Void

    var body: some View {
        ZStack {
            Color.black
            if controller.isDemoSession, controller.phase == .live {
                DemoAppScreen()
            } else {
                SimulatorSurface(controller: controller, keyboardShown: keyboard)
                    .opacity(controller.hasFrame ? 1 : 0)
                    .animation(.easeOut(duration: 0.4), value: controller.hasFrame)
            }
            overlay
            if controller.phase == .live, !controller.touchHintSeen {
                touchHint
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .aspectRatio(controller.displaySize.width / max(1, controller.displaySize.height), contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .animation(.snappy(duration: 0.3), value: controller.touchHintSeen)
    }

    private var touchHint: some View {
        VStack {
            Spacer()
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Touch it like the real thing")
                    .font(.subheadline.weight(.semibold))
                Text("Tap, scroll and type as you would on the phone. Touch and hold works too. Sideways swipes are sent when you lift your finger.")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
                Button("Got it") { controller.touchHintSeen = true }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 34)
                    .background(.white, in: Capsule())
                    .contentShape(Capsule().inset(by: -6))
                    .padding(.top, 2)
            }
            .foregroundStyle(.white)
            .padding(Space.l)
            .frame(maxWidth: 340, alignment: .leading)
            .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.18), lineWidth: 1))
            .padding(Space.l)
            .padding(.bottom, 64)
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch controller.phase {
        case .stopped:
            startButton
        case .ended(let reason):
            VStack(spacing: Space.l) {
                Text(reason).font(.subheadline).foregroundStyle(.white.opacity(0.75)).multilineTextAlignment(.center).padding(.horizontal, Space.xl)
                startButton
            }
        case .starting(let label):
            progress(label == "Reserving" ? "Reserving a simulator" : label == "Starting" ? "Starting the simulator" : label, detail: "A Mac in the cloud is getting a simulator ready.")
        case .building:
            progress("Building your app", detail: controller.logTail.last.map { ToolSummary.firstLine($0, limit: 60) } ?? "Compiling Swift")
        case .installing:
            progress("Launching", detail: "Installing the app on the simulator.")
        case .failed(let message):
            VStack(spacing: Space.m) {
                Image(systemName: "xmark.octagon.fill").font(.largeTitle).foregroundStyle(Color(hex: 0xff7a6e))
                Text("Build failed").font(.headline).foregroundStyle(.white)
                Text(message).font(.footnote).foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center).lineLimit(4)
                HStack(spacing: Space.s) {
                    if !controller.diagnostics.isEmpty {
                        Button("See issues", action: onShowIssues).buttonStyle(RaisedButtonStyle(size: .small))
                    }
                    Button("Try again") { Task { await controller.rebuild() } }.buttonStyle(RaisedButtonStyle(size: .small))
                }
                .environment(\.colorScheme, .dark)
            }
            .padding(Space.xl)
        case .live:
            if !controller.hasFrame { ProgressView().tint(.white) }
        }
    }

    private var startButton: some View {
        Button {
            Haptics.firm()
            Task { await controller.start() }
        } label: {
            Image(systemName: "play.fill")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.white)
                .offset(x: 2)
                .frame(width: 76, height: 76)
                .background(Color(hex: 0x1d52f1), in: Circle())
                .shadow(color: Color(hex: 0x1d52f1).opacity(0.5), radius: 18, y: 6)
        }
        .buttonStyle(PressableStyle(scale: 0.94))
        .accessibilityLabel("Run in the simulator")
        .accessibilityIdentifier("simulator.play")
    }

    private func progress(_ title: String, detail: String) -> some View {
        VStack(spacing: Space.m) {
            ProgressView().controlSize(.large).tint(.white)
            Text(title).font(.headline).foregroundStyle(.white)
            Text(detail)
                .font(.code(11.5))
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.horizontal, Space.xl)
        }
    }
}

/// The simulator over the whole workspace, edge to edge. On a phone the
/// simulated screen lines up with the real one. The controls are one small
/// pill that can be dragged out of the way or folded down to a dot, so they
/// never sit on the part of the app being tested.
struct ImmersiveSimulatorView: View {
    @ObservedObject var controller: SimulatorController
    @Binding var immersive: Bool
    @State private var keyboard = false
    @State private var expanded = true
    @State private var offset: CGSize = .zero
    @State private var dragStart: CGSize?
    @State private var collapseTask: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black
                SimulatorScreen(controller: controller, keyboard: keyboard, cornerRadius: 0) { immersive = false }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                controls(in: proxy.size)
            }
        }
        .ignoresSafeArea()
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear { scheduleCollapse() }
        .onDisappear { collapseTask?.cancel() }
        .onChange(of: controller.phase) { _, phase in
            // A build that fails, or a session that ends, is dealt with back in the pane.
            if phase != .live, phase != .building, phase != .installing { immersive = false }
        }
        .accessibilityAction(.escape) { immersive = false }
    }

    private func controls(in size: CGSize) -> some View {
        Group {
            if expanded {
                HStack(spacing: 2) {
                    control("arrow.down.right.and.arrow.up.left", "Exit full screen") { immersive = false }
                        .accessibilityIdentifier("simulator.exitFullscreen")
                    control(keyboard ? "keyboard.chevron.compact.down" : "keyboard", keyboard ? "Hide keyboard" : "Keyboard") { keyboard.toggle() }
                    control("rectangle.portrait.rotate", "Rotate") { controller.toggleOrientation() }
                    control("hammer", "Rebuild") { Task { await controller.rebuild() } }
                    control("chevron.down", "Hide controls") { setExpanded(false) }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(.black.opacity(0.62), in: Capsule())
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.white.opacity(0.22), lineWidth: 1))
            } else {
                Button { setExpanded(true) } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.5), in: Circle())
                        .background(.ultraThinMaterial, in: Circle())
                        .overlay(Circle().strokeBorder(.white.opacity(0.22), lineWidth: 1))
                }
                .buttonStyle(PressableStyle(scale: 0.9))
                .accessibilityLabel("Show simulator controls")
            }
        }
        .environment(\.colorScheme, .dark)
        .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
        .opacity(expanded ? 1 : 0.7)
        // Starts at the bottom centre, above the home indicator; stays where it is dragged.
        .position(x: size.width / 2 + offset.width, y: size.height - 62 + offset.height)
        .highPriorityGesture(
            DragGesture(minimumDistance: 6)
                .onChanged { value in
                    let start = dragStart ?? offset
                    dragStart = start
                    offset = CGSize(
                        width: min(size.width / 2 - 40, max(-size.width / 2 + 40, start.width + value.translation.width)),
                        height: min(20, max(-size.height + 140, start.height + value.translation.height))
                    )
                    collapseTask?.cancel()
                }
                .onEnded { _ in
                    dragStart = nil
                    scheduleCollapse()
                }
        )
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: expanded)
    }

    private func control(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button {
            action()
            scheduleCollapse()
        } label: {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(.white)
                .frame(width: 46, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.9))
        .accessibilityLabel(label)
    }

    private func setExpanded(_ value: Bool) {
        expanded = value
        if value { scheduleCollapse() } else { collapseTask?.cancel() }
    }

    /// The pill folds itself away after a few quiet seconds (never while VoiceOver is on).
    private func scheduleCollapse() {
        collapseTask?.cancel()
        guard !UIAccessibility.isVoiceOverRunning else { return }
        collapseTask = Task {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard !Task.isCancelled else { return }
            expanded = false
        }
    }
}

struct BuildIssuesSheet: View {
    @ObservedObject var controller: SimulatorController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if !controller.errors.isEmpty {
                    Section("Errors") { ForEach(controller.errors) { row($0) } }
                }
                if !controller.warnings.isEmpty {
                    Section("Warnings") { ForEach(controller.warnings) { row($0) } }
                }
                if !controller.logTail.isEmpty {
                    Section("Build log") {
                        Text(controller.logTail.suffix(60).joined(separator: "\n"))
                            .font(.code(11))
                            .foregroundStyle(Sand.muted)
                            .textSelection(.enabled)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Sand.canvas)
            .navigationTitle("Build issues")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ issue: SimDiagnostic) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: issue.isError ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(issue.isError ? Sand.danger : Sand.warning)
            VStack(alignment: .leading, spacing: 3) {
                Text(issue.message).font(.subheadline).foregroundStyle(Sand.text).textSelection(.enabled)
                if let location = issue.location {
                    Text(location).font(.code(11.5)).foregroundStyle(Sand.subtle)
                }
            }
        }
        .listRowBackground(Sand.card)
    }
}

/// A stand-in app screen for demo sessions, where there is no real video.
struct DemoAppScreen: View {
    private let bars: [(String, Double, Color)] = [
        ("Food", 0.82, Color(hex: 0x1d52f1)), ("Rent", 1.0, Color(hex: 0x3b6fe0)), ("Travel", 0.44, Color(hex: 0x7c9cf5)),
        ("Fun", 0.58, Color(hex: 0x5f82f7)), ("Bills", 0.36, Color(hex: 0xa9bdfb)),
    ]

    var body: some View {
        GeometryReader { proxy in
            let unit = proxy.size.width / 390
            VStack(alignment: .leading, spacing: 18 * unit) {
                HStack {
                    Text("9:41").font(.system(size: 15 * unit, weight: .semibold))
                    Spacer()
                    Image(systemName: "wifi").font(.system(size: 13 * unit, weight: .semibold))
                    Image(systemName: "battery.100").font(.system(size: 15 * unit))
                }
                .padding(.top, 14 * unit)
                Text("November")
                    .font(.system(size: 34 * unit, weight: .bold))
                Text("$2,184 spent · $416 left")
                    .font(.system(size: 15 * unit))
                    .foregroundStyle(.secondary)
                HStack(alignment: .bottom, spacing: 12 * unit) {
                    ForEach(bars, id: \.0) { bar in
                        VStack(spacing: 6 * unit) {
                            RoundedRectangle(cornerRadius: 7 * unit, style: .continuous)
                                .fill(bar.2)
                                .frame(height: 170 * unit * bar.1)
                            Text(bar.0).font(.system(size: 11 * unit)).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: 200 * unit, alignment: .bottom)
                .padding(16 * unit)
                .background(Color(hex: 0xf2f2f7), in: RoundedRectangle(cornerRadius: 18 * unit, style: .continuous))
                ForEach(["Harbour Market", "Tidewater Coffee", "City Transit"], id: \.self) { name in
                    HStack(spacing: 12 * unit) {
                        Circle().fill(Color(hex: 0xe5e5ea)).frame(width: 38 * unit, height: 38 * unit)
                        VStack(alignment: .leading, spacing: 2 * unit) {
                            Text(name).font(.system(size: 16 * unit, weight: .medium))
                            Text("Today").font(.system(size: 13 * unit)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(name == "City Transit" ? "−$2.90" : name == "Tidewater Coffee" ? "−$5.50" : "−$42.18")
                            .font(.system(size: 16 * unit, weight: .medium))
                            .monospacedDigit()
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 22 * unit)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(.white)
            .environment(\.colorScheme, .light)
        }
    }
}
