import SwiftUI

/// The app being built: its running preview and its code.
struct AppPane: View {
    @ObservedObject var store: WorkspaceStore
    @Binding var sheet: WorkspaceSheet?
    @Binding var immersive: Bool
    @StateObject private var simulator: SimulatorController
    @State private var tab: Tab = AppConfig.demoRoute == "workspace-code" ? .code : .preview

    enum Tab: Hashable { case preview, code }

    init(store: WorkspaceStore, sheet: Binding<WorkspaceSheet?>, immersive: Binding<Bool>) {
        self.store = store
        _sheet = sheet
        _immersive = immersive
        _simulator = StateObject(wrappedValue: SimulatorController(projectId: store.projectId, service: store.service))
    }

    var body: some View {
        VStack(spacing: 0) {
            if !immersive {
                HStack(spacing: Space.s) {
                    SegmentedTabs(
                        selection: $tab,
                        items: [.init(value: .preview, title: "Preview"), .init(value: .code, title: "Code")],
                        compact: true
                    )
                    Spacer(minLength: 0)
                    Button { sheet = .share } label: {
                        Image(systemName: "person.badge.plus").frame(width: 20, height: 20)
                    }
                    .buttonStyle(RaisedButtonStyle(size: .small))
                    .accessibilityLabel("Share project")
                    if !store.project.isSwift {
                        Button { sheet = .publish } label: {
                            Label("Publish", systemImage: "globe")
                        }
                        .buttonStyle(InkButtonStyle(size: .small))
                        .accessibilityIdentifier("workspace.publish")
                    }
                }
                .padding(.horizontal, Space.m)
                .padding(.vertical, Space.s)
            }
            switch tab {
            case .preview:
                if store.project.isSwift {
                    SimulatorView(controller: simulator, immersive: $immersive)
                } else {
                    WebPreviewView(store: store)
                }
            case .code:
                CodeBrowser(store: store)
            }
        }
        .background(Sand.canvas)
        .onAppear {
            if store.project.isSwift { simulator.watchAgentRequests() }
        }
        .task {
            // Demo entry points: the simulator already running, or full screen.
            guard let route = AppConfig.demoRoute, route == "workspace-sim" || route == "workspace-immersive" else { return }
            await simulator.start()
            if route == "workspace-immersive" { immersive = true }
        }
        .onDisappear {
            simulator.stopWatching()
            immersive = false
        }
    }
}

/// The running web app. Starts the dev server on first view and reloads after
/// each agent turn.
struct WebPreviewView: View {
    @ObservedObject var store: WorkspaceStore
    @StateObject private var web = WebViewModel()
    @State private var width: PreviewWidth = .fill
    @Environment(\.horizontalSizeClass) private var sizeClass

    enum PreviewWidth: String, CaseIterable {
        case fill = "Fit", phone = "Phone", tablet = "Tablet"

        var points: CGFloat? { self == .phone ? 390 : self == .tablet ? 768 : nil }
        var symbol: String { self == .phone ? "iphone" : self == .tablet ? "ipad" : "arrow.left.and.right" }
    }

    var body: some View {
        VStack(spacing: Space.s) {
            bar
            content
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
                .frame(maxWidth: width.points ?? .infinity)
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, Space.m)
        .padding(.bottom, Space.m)
        .task { await store.startPreview() }
    }

    private var bar: some View {
        HStack(spacing: Space.s) {
            HStack(spacing: 6) {
                if store.previewStarting || web.isLoading {
                    ProgressView().controlSize(.mini)
                } else {
                    Circle().fill(store.previewURL == nil ? Sand.borderStrong : Sand.successSolid).frame(width: 7, height: 7)
                }
                Text(addressLabel)
                    .font(.code(12.5))
                    .foregroundStyle(Sand.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.m)
            .frame(minHeight: 36)
            .background(Sand.card, in: Capsule())
            .overlay(Capsule().strokeBorder(Sand.border, lineWidth: 1))

            if sizeClass == .regular {
                Menu {
                    Picker("Width", selection: $width) {
                        ForEach(PreviewWidth.allCases, id: \.self) { item in
                            Label(item.rawValue, systemImage: item.symbol).tag(item)
                        }
                    }
                } label: {
                    Image(systemName: width.symbol).frame(width: 20, height: 20)
                }
                .buttonStyle(RaisedButtonStyle(size: .small))
                .accessibilityLabel("Preview width")
            }
            Button {
                Haptics.tap()
                if store.previewURL == nil { Task { await store.startPreview(force: true) } } else { web.reload() }
            } label: {
                Image(systemName: "arrow.clockwise").frame(width: 20, height: 20)
            }
            .buttonStyle(RaisedButtonStyle(size: .small))
            .accessibilityLabel("Reload preview")
            if let url = store.previewURL, url.scheme?.hasPrefix("http") == true {
                Link(destination: url) {
                    Image(systemName: "safari").frame(width: 20, height: 20)
                }
                .buttonStyle(RaisedButtonStyle(size: .small))
                .accessibilityLabel("Open in Safari")
            }
        }
    }

    private var addressLabel: String {
        if store.previewStarting { return "Starting the preview…" }
        guard let url = web.currentURL ?? store.previewURL else { return "Preview stopped" }
        if url.scheme == "demo" { return "tidewater-coffee.preview/" }
        return (url.host ?? "") + (url.path == "/" ? "" : url.path)
    }

    @ViewBuilder
    private var content: some View {
        if let url = store.previewURL {
            if url.scheme == "demo" {
                DemoWebPage()
            } else {
                WebView(url: url, model: web, reloadToken: store.previewReloadToken)
                    .background(Color.white)
            }
        } else if let error = store.previewError {
            VStack(spacing: Space.m) {
                EmptyState(symbol: "exclamationmark.triangle", title: "The preview didn't start", message: ToolSummary.firstLine(error, limit: 220), actionTitle: "Try again") {
                    Task { await store.startPreview(force: true) }
                }
            }
            .background(Sand.card)
        } else {
            VStack(spacing: Space.m) {
                ProgressView().controlSize(.large)
                Text(store.sandbox == .booting ? "Waking the sandbox" : "Starting the preview")
                    .font(.headline)
                    .foregroundStyle(Sand.text)
                Text("Installing packages and starting the dev server. The first start takes the longest.")
                    .font(.subheadline)
                    .foregroundStyle(Sand.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Sand.card)
        }
    }
}

/// A stand-in for the user's running site in demo mode.
struct DemoWebPage: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ZStack(alignment: .bottomLeading) {
                    LinearGradient(colors: [Color(hex: 0x2c4a37), Color(hex: 0x1f3d2b)], startPoint: .top, endPoint: .bottom)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("TIDEWATER COFFEE").font(.caption.weight(.semibold)).kerning(1.6).foregroundStyle(Color(hex: 0xf7f1e3).opacity(0.8))
                        Text("Slow coffee\nby the water").font(.system(size: 38, weight: .semibold, design: .serif)).foregroundStyle(Color(hex: 0xf7f1e3))
                        Text("Order ahead")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color(hex: 0x1f3d2b))
                            .padding(.horizontal, 18).padding(.vertical, 10)
                            .background(Color(hex: 0xf7f1e3), in: Capsule())
                            .padding(.top, 6)
                    }
                    .padding(24)
                }
                .frame(height: 300)
                VStack(alignment: .leading, spacing: 16) {
                    Text("On the bar").font(.system(size: 24, weight: .semibold, design: .serif))
                    ForEach([("Harbour Flat White", "$4.50"), ("Slow Pour Filter", "$5.00"), ("Salted Honey Latte", "$5.50")], id: \.0) { item in
                        HStack {
                            Text(item.0)
                            Spacer()
                            Text(item.1).monospacedDigit()
                        }
                        .font(.body)
                        Divider()
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Opening hours").font(.headline)
                        Text("Weekdays 7–5 · Saturday 8–5 · Sunday 8–3").font(.subheadline).opacity(0.75)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(hex: 0xefe6d0), in: RoundedRectangle(cornerRadius: 14))
                }
                .foregroundStyle(Color(hex: 0x1f3d2b))
                .padding(24)
            }
        }
        .background(Color(hex: 0xf7f1e3))
        .environment(\.colorScheme, .light)
    }
}
