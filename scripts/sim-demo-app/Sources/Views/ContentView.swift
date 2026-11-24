import SwiftUI

/// Moves on every frame, so the stream's frame rate is measured under load
/// rather than on a still screen; the button checks that taps arrive.
struct ContentView: View {
    @State private var launchedAt = Date()
    @State private var taps = 0

    private let deviceLine: String = {
        let env = ProcessInfo.processInfo.environment
        let device = env["SIMULATOR_DEVICE_NAME"] ?? "Simulator"
        let os = env["SIMULATOR_RUNTIME_VERSION"].map { "iOS \($0)" }
            ?? ProcessInfo.processInfo.operatingSystemVersionString
        return "\(device) · \(os)"
    }()

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSince(launchedAt)
            ZStack {
                LinearGradient(
                    colors: [Color(red: 0.05, green: 0.06, blue: 0.09), Color(red: 0.10, green: 0.12, blue: 0.19)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()

                VStack(spacing: 32) {
                    VStack(spacing: 6) {
                        Text("Botflow host check")
                            .font(.title2.weight(.semibold))
                        Text(deviceLine)
                            .font(.footnote)
                            .foregroundStyle(.white.opacity(0.6))
                    }

                    ZStack {
                        Circle()
                            .stroke(.white.opacity(0.08), lineWidth: 14)
                        Circle()
                            .trim(from: 0, to: 0.3)
                            .stroke(
                                AngularGradient(colors: [.cyan, .blue, .purple, .cyan], center: .center),
                                style: StrokeStyle(lineWidth: 14, lineCap: .round)
                            )
                            .rotationEffect(.degrees(t * 240))
                        VStack(spacing: 2) {
                            Text(String(format: "%.1f s", t))
                                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                            Text("since launch")
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.6))
                        }
                    }
                    .frame(width: 200, height: 200)

                    HStack(alignment: .center, spacing: 6) {
                        ForEach(0..<12, id: \.self) { i in
                            Capsule()
                                .fill(Color.cyan.opacity(0.85))
                                .frame(width: 10, height: 16 + 44 * abs(sin(t * 3 + Double(i) * 0.5)))
                        }
                    }
                    .frame(height: 64)

                    Button {
                        taps += 1
                    } label: {
                        Text(taps == 0 ? "Tap to test input" : "Taps received: \(taps)")
                            .font(.headline)
                            .frame(maxWidth: 240)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("tapTest")
                }
                .foregroundStyle(.white)
                .padding()
            }
        }
        .preferredColorScheme(.dark)
    }
}
