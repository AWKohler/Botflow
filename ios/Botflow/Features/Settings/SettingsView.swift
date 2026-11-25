import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var push = PushManager.shared
    @State private var web: WebDestination?
    @State private var confirmSignOut = false
    @State private var liveActivities = LiveActivityManager.isEnabledByUser

    struct WebDestination: Identifiable {
        var title: String
        var path: String
        var id: String { path }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    profile
                        .listRowBackground(Sand.card)
                }

                Section("Plan") {
                    NavigationLink {
                        PaywallView(reason: nil, embedded: true)
                    } label: {
                        row("creditcard", "Subscription", value: session.tier.label)
                    }
                    .listRowBackground(Sand.card)
                    NavigationLink {
                        UsageView()
                    } label: {
                        row("gauge.with.needle", "Usage", value: session.credits.map { "\($0.pct)% this week" })
                    }
                    .listRowBackground(Sand.card)
                }

                Section {
                    NavigationLink { ConnectionsView() } label: {
                        row("link", "Connections", value: connectionSummary)
                    }
                    .listRowBackground(Sand.card)
                } header: {
                    Text("Models")
                } footer: {
                    Text("Connect your Claude or ChatGPT plan, or add API keys, to run agents on your own accounts.")
                }

                Section {
                    switch push.authorization {
                    case .notDetermined:
                        Button {
                            Task { await push.requestIfNeeded() }
                        } label: {
                            row("bell.badge", "Turn on notifications", value: nil)
                        }
                        .listRowBackground(Sand.card)
                    case .denied:
                        Button {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                        } label: {
                            row("bell.slash", "Notifications are off", value: "Open Settings")
                        }
                        .listRowBackground(Sand.card)
                    default:
                        Button {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                        } label: {
                            HStack(spacing: Space.s) {
                                row("bell.badge", "Notifications", value: "On")
                                Image(systemName: "arrow.up.forward")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(Sand.subtle)
                                    .accessibilityHidden(true)
                            }
                        }
                        .accessibilityHint("Opens notification settings")
                        .listRowBackground(Sand.card)
                    }
                    Toggle(isOn: $liveActivities) {
                        row("platter.filled.top.iphone", "Live Activities", value: nil)
                    }
                    .tint(Sand.accent)
                    .listRowBackground(Sand.card)
                    .onChange(of: liveActivities) { _, value in LiveActivityManager.isEnabledByUser = value }
                } header: {
                    Text("When agents work")
                } footer: {
                    Text("Get told when an agent finishes or needs your input, and follow its steps in the Dynamic Island and on the Lock Screen.")
                }

                Section("Account") {
                    Button { web = WebDestination(title: "Account", path: "account") } label: { row("person.crop.circle", "Profile and security", value: nil) }
                        .listRowBackground(Sand.card)
                    Button { web = WebDestination(title: "Domains", path: "domains") } label: { row("globe", "Custom domains", value: nil) }
                        .listRowBackground(Sand.card)
                }

                Section("About") {
                    Link(destination: URL(string: "https://docs.botflow.io")!) { row("book", "Documentation", value: nil) }
                        .listRowBackground(Sand.card)
                    Link(destination: AppConfig.productionURL.appendingPathComponent("terms")) { row("doc.text", "Terms of Service", value: nil) }
                        .listRowBackground(Sand.card)
                    Link(destination: AppConfig.productionURL.appendingPathComponent("privacy")) { row("hand.raised", "Privacy Policy", value: nil) }
                        .listRowBackground(Sand.card)
                    row("info.circle", "Version", value: AppConfig.version)
                        .listRowBackground(Sand.card)
                }

                Section {
                    Button(role: .destructive) {
                        confirmSignOut = true
                    } label: {
                        Text("Sign out").frame(maxWidth: .infinity)
                    }
                    .listRowBackground(Sand.card)
                    .accessibilityIdentifier("settings.signOut")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Sand.canvas)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .sheet(item: $web) { destination in
                WebSheet(title: destination.title, url: AppConfig.baseURL.appendingPathComponent(destination.path))
            }
            .confirmationDialog("Sign out of Botflow?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    dismiss()
                    Task { await session.signOut() }
                }
            } message: {
                Text("Agents that are running keep working. You can sign back in any time.")
            }
            .task {
                await session.loadAccount()
                await push.refreshStatus()
            }
        }
    }

    private var profile: some View {
        // At the largest text sizes the avatar goes above the name, and the
        // name and address wrap in full instead of being cut.
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: Space.m)) : AnyLayout(HStackLayout(spacing: Space.l))
        return layout {
            AvatarView(initials: session.user?.initials ?? "··", imageURL: session.user?.imageUrl, size: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.user?.displayName ?? "Your account")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Sand.text)
                    .lineLimit(stacked ? nil : 2)
                if let email = session.user?.email {
                    Text(email).font(.subheadline).foregroundStyle(Sand.muted)
                        .lineLimit(stacked ? nil : 1)
                        .truncationMode(.middle)
                }
            }
            if !stacked { Spacer(minLength: 0) }
            Badge(text: session.tier.label, tone: session.tier == .free ? .neutral : .accent)
                .fixedSize()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
    }

    private var connectionSummary: String {
        var parts: [String] = []
        if session.connections.hasClaudeOAuth == true { parts.append("Claude") }
        if session.connections.hasCodexOAuth == true { parts.append("ChatGPT") }
        return parts.isEmpty ? "None" : parts.joined(separator: ", ")
    }

    private func row(_ symbol: String, _ title: String, value: String?) -> some View {
        SettingsRow(symbol: symbol, title: title, value: value)
    }
}

/// One settings row: icon, title, and a value that moves under the title at
/// the largest text sizes instead of squeezing it.
struct SettingsRow: View {
    var symbol: String
    var title: String
    var value: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The icon column is as wide as the icons are at this text size.
    @ScaledMetric(relativeTo: .body) private var iconColumn: CGFloat = 24

    var body: some View {
        HStack(alignment: typeSize.isAccessibilitySize ? .firstTextBaseline : .center, spacing: Space.m) {
            Image(systemName: symbol)
                .foregroundStyle(Sand.muted)
                .frame(width: iconColumn)
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Sand.text)
                    if let value { Text(value).foregroundStyle(Sand.subtle) }
                }
                Spacer(minLength: 0)
            } else {
                Text(title).foregroundStyle(Sand.text)
                Spacer(minLength: Space.s)
                if let value {
                    Text(value).foregroundStyle(Sand.subtle).lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Usage

struct UsageView: View {
    @EnvironmentObject private var session: AppSession

    var body: some View {
        List {
            if let credits = session.credits {
                Section {
                    usageMeter("This week", used: credits.weeklyUsed, limit: credits.weeklyLimit, pct: credits.pct)
                        .listRowBackground(Sand.card)
                    usageMeter("This month", used: credits.monthlyUsed, limit: credits.monthlyLimit, pct: credits.monthlyPct ?? 0)
                        .listRowBackground(Sand.card)
                } header: {
                    Text("\(credits.tier.label) plan credits")
                } footer: {
                    Text("Credits are used only when an agent runs on Botflow's keys. Turns on your own Claude or ChatGPT plan, or your own API keys, don't count.")
                }
                if let models = credits.models, !models.isEmpty {
                    Section("By model, this month") {
                        ForEach(models) { usage in
                            HStack {
                                ProviderMark(provider: ModelCatalog.model(usage.model).provider, modelId: usage.model, size: 22)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(ModelCatalog.name(usage.model)).foregroundStyle(Sand.text)
                                    Text(usage.turns == 1 ? "1 turn" : "\(usage.turns) turns").font(.footnote).foregroundStyle(Sand.subtle)
                                }
                                Spacer()
                                Text(AIModel.compact(usage.credits)).monospacedDigit().foregroundStyle(Sand.muted)
                            }
                            .listRowBackground(Sand.card)
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            if let plan = session.claudePlan, plan.available {
                Section {
                    if let five = plan.fiveHour {
                        usageMeter("Current session (5 hours)", used: Double(five), limit: 100, pct: five, showAmounts: false).listRowBackground(Sand.card)
                    }
                    if let seven = plan.sevenDay {
                        usageMeter("This week", used: Double(seven), limit: 100, pct: seven, showAmounts: false).listRowBackground(Sand.card)
                    }
                } header: {
                    Text("Your Claude subscription")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Sand.canvas)
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await session.loadAccount() }
    }

    private func usageMeter(_ title: String, used: Double, limit: Double, pct: Int, showAmounts: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Text(title).foregroundStyle(Sand.text)
                Spacer()
                Text("\(pct)%").monospacedDigit().foregroundStyle(pct >= 90 ? Sand.danger : Sand.muted)
            }
            Meter(fraction: Double(pct) / 100, tint: pct >= 90 ? Sand.dangerSolid : pct >= 70 ? Sand.warningSolid : Sand.text, height: 6)
            if showAmounts, limit > 0 {
                Text("\(AIModel.compact(Int(used))) of \(AIModel.compact(Int(limit))) credits")
                    .font(.footnote)
                    .foregroundStyle(Sand.subtle)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Connections

struct ConnectionsView: View {
    @EnvironmentObject private var session: AppSession
    @State private var flow: Flow?
    @State private var github: (connected: Bool, username: String?)?
    @State private var web: SettingsView.WebDestination?
    @State private var editingKey: KeyField?

    enum Flow: String, Identifiable {
        case claude, chatgpt
        var id: String { rawValue }
    }

    struct KeyField: Identifiable {
        var title: String
        var field: String
        var id: String { field }
    }

    private var keys: [(String, String, Bool, ModelProvider)] {
        let c = session.connections
        return [
            ("Anthropic", "anthropicApiKey", c.hasAnthropicKey, .anthropic),
            ("OpenAI", "openaiApiKey", c.hasOpenAIKey, .openai),
            ("Google", "googleApiKey", c.hasGoogleKey, .google),
            ("xAI", "xaiApiKey", c.hasXaiKey, .xai),
            ("Fireworks", "fireworksApiKey", c.hasFireworksKey, .fireworks),
        ]
    }

    var body: some View {
        List {
            Section {
                subscriptionRow("Claude", detail: "Run Claude models on your Pro or Max plan", provider: .anthropic, connected: session.connections.hasClaudeOAuth == true, flow: .claude, disconnect: "api/oauth/claude/disconnect")
                subscriptionRow("ChatGPT", detail: "Run GPT models on your ChatGPT plan", provider: .openai, connected: session.connections.hasCodexOAuth == true, flow: .chatgpt, disconnect: "api/oauth/codex/disconnect")
            } header: {
                Text("Subscriptions")
            } footer: {
                Text("Turns on a connected subscription don't use Botflow credits.")
            }

            Section("GitHub") {
                Button {
                    web = SettingsView.WebDestination(title: "GitHub", path: "settings")
                } label: {
                    HStack(spacing: Space.m) {
                        Image(systemName: "chevron.left.forwardslash.chevron.right").foregroundStyle(Sand.muted).frame(width: 26)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("GitHub").foregroundStyle(Sand.text)
                            Text(github?.connected == true ? "Connected as \(github?.username ?? "you")" : "Sync projects to repositories")
                                .font(.footnote)
                                .foregroundStyle(Sand.subtle)
                        }
                        Spacer()
                        if github?.connected == true {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Sand.success)
                        } else {
                            Text("Connect").foregroundStyle(Sand.accent)
                        }
                    }
                }
                .listRowBackground(Sand.card)
            }

            Section {
                ForEach(keys, id: \.1) { key in
                    Button {
                        editingKey = KeyField(title: key.0, field: key.1)
                    } label: {
                        HStack(spacing: Space.m) {
                            ProviderMark(provider: key.3, size: 24).frame(width: 26)
                            Text(key.0).foregroundStyle(Sand.text)
                            Spacer()
                            if key.2 {
                                Badge(text: "Key added", symbol: "checkmark", tone: .success)
                            } else {
                                Text("Add key").foregroundStyle(Sand.accent)
                            }
                        }
                    }
                    .listRowBackground(Sand.card)
                }
            } header: {
                Text("Your API keys")
            } footer: {
                Text("Keys are encrypted and stay on Botflow's servers. They are never sent to a project's sandbox.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Sand.canvas)
        .navigationTitle("Connections")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $flow, onDismiss: { Task { await session.loadAccount() } }) { flow in
            switch flow {
            case .claude: ClaudeConnectSheet()
            case .chatgpt: ChatGPTConnectSheet()
            }
        }
        .sheet(item: $web, onDismiss: { Task { await loadGitHub() } }) { destination in
            WebSheet(title: destination.title, url: AppConfig.baseURL.appendingPathComponent(destination.path))
        }
        .sheet(item: $editingKey) { key in
            APIKeySheet(title: key.title, field: key.field)
        }
        .task { await loadGitHub() }
    }

    private func subscriptionRow(_ title: String, detail: String, provider: ModelProvider, connected: Bool, flow target: Flow, disconnect: String) -> some View {
        HStack(spacing: Space.m) {
            ProviderMark(provider: provider, size: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).foregroundStyle(Sand.text)
                Text(connected ? "Connected" : detail)
                    .font(.footnote)
                    .foregroundStyle(connected ? Sand.success : Sand.subtle)
            }
            Spacer(minLength: Space.s)
            if connected {
                Button("Disconnect") {
                    Task {
                        _ = try? await session.service.raw("POST", disconnect, body: nil)
                        await session.loadAccount()
                    }
                }
                .buttonStyle(.borderless)
                .font(.subheadline)
                .foregroundStyle(Sand.muted)
            } else {
                Button("Connect") { flow = target }
                    .buttonStyle(InkButtonStyle(size: .small))
            }
        }
        .listRowBackground(Sand.card)
    }

    private func loadGitHub() async {
        if let raw = try? await session.service.raw("GET", "api/oauth/github/status", body: nil) {
            github = (raw["connected"]?.boolValue ?? false, raw["username"]?.stringValue)
        }
    }
}

struct APIKeySheet: View {
    var title: String
    var field: String
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Paste your \(title) API key", text: $value)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .codeFont(14)
                        .listRowBackground(Sand.card)
                } footer: {
                    Text("Saving replaces any key already stored for \(title).")
                }
                Section {
                    Button(role: .destructive) {
                        save(nil)
                    } label: {
                        Text("Remove stored key").frame(maxWidth: .infinity)
                    }
                    .listRowBackground(Sand.card)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Sand.canvas)
            .navigationTitle("\(title) key")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { save(value) }
                        .fontWeight(.semibold)
                        .disabled(value.trimmingCharacters(in: .whitespaces).count < 8 || saving)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func save(_ key: String?) {
        saving = true
        Task {
            defer { saving = false }
            do {
                try await session.service.saveKey(field: field, value: key?.trimmingCharacters(in: .whitespaces))
                await session.loadAccount()
                Haptics.success()
                dismiss()
            } catch { ToastCenter.shared.error(error) }
        }
    }
}

/// Claude sign-in: open Claude's authorisation page, then paste the code it shows.
struct ClaudeConnectSheet: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var verifier: String?
    @State private var code = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Space.xl) {
                step(1, "Open Claude and approve access", detail: "You'll sign in to Claude and be shown a code.")
                Button {
                    Task { await start() }
                } label: {
                    Label("Open Claude", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(RaisedButtonStyle(fullWidth: true))
                .disabled(working)

                step(2, "Paste the code here", detail: nil)
                TextField("Authorisation code", text: $code, axis: .vertical)
                    .lineLimit(1...3)
                    .codeFont(14)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(Space.m)
                    .background(Sand.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Sand.borderStrong, lineWidth: 1))
                if let error { ErrorBanner(message: error) }
                Button {
                    Task { await finish() }
                } label: {
                    HStack { if working { ProgressView().tint(Sand.bg) }; Text("Connect Claude") }
                }
                .buttonStyle(InkButtonStyle(size: .large, fullWidth: true))
                .disabled(verifier == nil || code.trimmingCharacters(in: .whitespaces).isEmpty || working)
                Spacer()
            }
            .padding(Space.gutter)
            .background(Sand.canvas)
            .navigationTitle("Connect Claude")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.large])
    }

    private func step(_ number: Int, _ title: String, detail: String?) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Sand.bg)
                .frame(width: 24, height: 24)
                .background(Sand.text, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(Sand.text)
                if let detail { Text(detail).font(.subheadline).foregroundStyle(Sand.muted) }
            }
        }
    }

    private func start() async {
        working = true
        defer { working = false }
        do {
            let raw = try await session.service.raw("POST", "api/oauth/claude/start", body: nil)
            verifier = raw["verifier"]?.stringValue
            if let url = raw["authUrl"]?.stringValue.flatMap(URL.init(string:)) { openURL(url) }
        } catch let failure { error = failure.localizedDescription }
    }

    private func finish() async {
        guard let verifier else { return }
        working = true
        error = nil
        defer { working = false }
        do {
            _ = try await session.service.raw("POST", "api/oauth/claude/exchange", body: .object(["code": .string(code.trimmingCharacters(in: .whitespacesAndNewlines)), "verifier": .string(verifier)]))
            await session.loadAccount()
            Haptics.success()
            ToastCenter.shared.show("Claude connected")
            dismiss()
        } catch let failure {
            error = failure.localizedDescription
            Haptics.error()
        }
    }
}

/// ChatGPT sign-in by device code: show the code, open OpenAI's page, wait.
struct ChatGPTConnectSheet: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var userCode: String?
    @State private var verificationURL: URL?
    @State private var error: String?
    @State private var poll: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            VStack(spacing: Space.xl) {
                if let userCode {
                    Text("Enter this code on OpenAI's page")
                        .font(.body)
                        .foregroundStyle(Sand.muted)
                    Text(userCode)
                        .font(.system(size: 34, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Sand.text)
                        .kerning(2)
                        .padding(.horizontal, Space.xl)
                        .padding(.vertical, Space.l)
                        .sandCard()
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = userCode
                        Haptics.tap()
                        if let verificationURL { openURL(verificationURL) }
                    } label: {
                        Label("Copy code and open ChatGPT", systemImage: "arrow.up.forward.app")
                    }
                    .buttonStyle(InkButtonStyle(size: .large, fullWidth: true))
                    HStack(spacing: Space.s) {
                        ProgressView().controlSize(.small)
                        Text("Waiting for you to approve").font(.subheadline).foregroundStyle(Sand.subtle)
                    }
                } else if let error {
                    ErrorBanner(message: error) { Task { await start() } }
                } else {
                    ProgressView().padding(.top, 60)
                }
                Spacer()
            }
            .padding(Space.gutter)
            .padding(.top, Space.xl)
            .frame(maxWidth: .infinity)
            .background(Sand.canvas)
            .navigationTitle("Connect ChatGPT")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .task { await start() }
        .onDisappear { poll?.cancel() }
    }

    private func start() async {
        error = nil
        do {
            let raw = try await session.service.raw("POST", "api/oauth/codex/start", body: nil)
            guard let code = raw["user_code"]?.stringValue, let deviceId = raw["device_auth_id"]?.stringValue else {
                throw APIError(status: 502, message: "ChatGPT sign-in could not start. Try again.")
            }
            userCode = code
            verificationURL = raw["verification_url"]?.stringValue.flatMap(URL.init(string:))
            let interval = max(2, raw["interval"]?.doubleValue ?? 5)
            poll?.cancel()
            poll = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    let result = try? await session.service.raw("POST", "api/oauth/codex/poll", body: .object(["device_auth_id": .string(deviceId), "user_code": .string(code)]))
                    switch result?["status"]?.stringValue {
                    case "success":
                        await session.loadAccount()
                        Haptics.success()
                        ToastCenter.shared.show("ChatGPT connected")
                        dismiss()
                        return
                    case "failed":
                        error = "The code expired or was declined. Try again."
                        userCode = nil
                        return
                    default:
                        continue
                    }
                }
            }
        } catch let failure {
            error = failure.localizedDescription
        }
    }
}
