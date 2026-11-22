import SwiftUI

/// The live iOS simulator for a Swift project. Touch it as you would the real
/// app; go full screen and it fills this device edge to edge.
struct SimulatorView: View {
    @ObservedObject var controller: SimulatorController
    @Binding var immersive: Bool
    @State private var keyboard = false
    @State private var showIssues = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if immersive {
                Color.black.ignoresSafeArea()
                screen(cornerRadius: 0)
                    .ignoresSafeArea(.container, edges: .bottom)
                immersiveControls
            } else {
                VStack(spacing: Space.m) {
                    controlBar
                    device
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if !controller.diagnostics.isEmpty {
                        issuesButton
                    }
                }
                .padding(.horizontal, Space.m)
                .padding(.bottom, Space.m)
            }
        }
        .animation(.smooth(duration: 0.35), value: immersive)
        .sheet(isPresented: $showIssues) { BuildIssuesSheet(controller: controller) }
        .onChange(of: controller.phase) { _, phase in
            if phase != .live { keyboard = false }
            if case .failed = phase, !controller.diagnostics.isEmpty { showIssues = true }
        }
        .onDisappear { keyboard = false }
    }

    // MARK: Controls

    private var controlBar: some View {
        HStack(spacing: Space.s) {
            statusPill
            Spacer(minLength: 0)
            Menu {
                Picker("Device", selection: Binding(get: { controller.device }, set: { device in Task { await controller.setDevice(device) } })) {
                    ForEach(SimDevice.allCases, id: \.self) { device in
                        Label(device.label, systemImage: device.symbol).tag(device)
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: controller.device.symbol)
                    Text(controller.device.label)
                    Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(Sand.subtle)
                }
            }
            .buttonStyle(RaisedButtonStyle(size: .small))

            Button {
                controller.toggleOrientation()
            } label: {
                Image(systemName: controller.landscape ? "rectangle.landscape.rotate" : "rectangle.portrait.rotate")
            }
            .buttonStyle(RaisedButtonStyle(size: .small))
            .accessibilityLabel(controller.landscape ? "Rotate to portrait" : "Rotate to landscape")

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
                Toggle(isOn: $controller.liveScroll) { Label("Scroll while dragging", systemImage: "hand.draw") }
                if controller.phase.isActive {
                    Divider()
                    Button(role: .destructive) { Task { await controller.stop() } } label: { Label("Stop simulator", systemImage: "stop.fill") }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(RaisedButtonStyle(size: .small))
            .accessibilityLabel("Simulator options")
        }
    }

    private var statusPill: some View {
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
        .padding(.horizontal, Space.m)
        .frame(minHeight: 36)
        .background(Sand.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Sand.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
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
            let width = min(available.width, available.height * aspect)
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
                screen(cornerRadius: radius)
                    .frame(width: width, height: height)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func screen(cornerRadius: CGFloat) -> some View {
        ZStack {
            Color.black
            if controller.isDemoSession, controller.phase == .live {
                DemoAppScreen()
            } else {
                SimulatorSurface(controller: controller, keyboardShown: keyboard)
                    .opacity(controller.hasFrame ? 1 : 0)
            }
            overlay
        }
        .aspectRatio(controller.displaySize.width / max(1, controller.displaySize.height), contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    @ViewBuilder
    private var overlay: some View {
        switch controller.phase {
        case .stopped:
            startButton(title: nil)
        case .ended(let reason):
            VStack(spacing: Space.l) {
                Text(reason).font(.subheadline).foregroundStyle(.white.opacity(0.75)).multilineTextAlignment(.center).padding(.horizontal, Space.xl)
                startButton(title: nil)
            }
        case .starting(let label):
            progress(label, detail: "A Mac in the cloud is getting a simulator ready.")
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
                        Button("See issues") { showIssues = true }.buttonStyle(RaisedButtonStyle(size: .small))
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

    private func startButton(title: String?) -> some View {
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

    // MARK: Full screen

    private var immersiveControls: some View {
        VStack {
            Spacer()
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    immersiveButton("arrow.down.right.and.arrow.up.left", "Exit full screen") { immersive = false }
                    immersiveButton(keyboard ? "keyboard.chevron.compact.down" : "keyboard", "Keyboard") { keyboard.toggle() }
                    immersiveButton("rectangle.portrait.rotate", "Rotate") { controller.toggleOrientation() }
                    immersiveButton("hammer", "Rebuild") { Task { await controller.rebuild() } }
                }
            }
            .padding(.bottom, Space.s)
        }
    }

    private func immersiveButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(.white)
                .frame(width: 46, height: 46)
        }
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(label)
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
