import SwiftUI

// MARK: - Publish

/// Build the web app and put it online, with the build's progress as it happens.
struct PublishSheet: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss

    enum Phase: Equatable {
        case ready, publishing, published(URL), failed(String)
    }

    @State private var phase: Phase = .ready
    @State private var status = ""
    @State private var log: [String] = []
    @State private var task: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    header
                    switch phase {
                    case .ready:
                        if let live = store.project.liveURL {
                            liveCard(live, fresh: false)
                        }
                        Button {
                            start()
                        } label: {
                            Label(store.project.liveURL == nil ? "Publish to the web" : "Publish the latest version", systemImage: "globe")
                        }
                        .buttonStyle(InkButtonStyle(size: .large, fullWidth: true))
                        .accessibilityIdentifier("publish.start")
                        Text("Botflow builds your app and deploys it to a fast global network. Custom domains are managed on the web.")
                            .font(.footnote)
                            .foregroundStyle(Sand.subtle)
                    case .publishing:
                        VStack(alignment: .leading, spacing: Space.m) {
                            HStack(spacing: Space.m) {
                                ProgressView()
                                Text(status.isEmpty ? "Starting" : status)
                                    .font(.body.weight(.medium))
                                    .foregroundStyle(Sand.text)
                                    .contentTransition(.opacity)
                            }
                            if !log.isEmpty { logView }
                        }
                        .padding(Space.l)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .sandCard()
                    case .published(let url):
                        liveCard(url, fresh: true)
                    case .failed(let message):
                        ErrorBanner(message: ToolSummary.firstLine(message, limit: 400)) { start() }
                        if !log.isEmpty { logView }
                    }
                }
                .padding(Space.gutter)
            }
            .background(Sand.canvas)
            .navigationTitle("Publish")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .motion(.snappy, value: phase)
        }
        .presentationDetents([.medium, .large])
        .onDisappear { task?.cancel() }
    }

    private var header: some View {
        HStack(spacing: Space.m) {
            ProjectCover(project: store.project)
                .frame(width: 72, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(store.project.name).font(.headline).foregroundStyle(Sand.text).lineLimit(1)
                Text(store.project.liveURL == nil ? "Not published yet" : "Published")
                    .font(.subheadline)
                    .foregroundStyle(Sand.muted)
            }
        }
    }

    private func liveCard(_ url: URL, fresh: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.s) {
                Image(systemName: fresh ? "checkmark.circle.fill" : "globe")
                    .foregroundStyle(fresh ? Sand.success : Sand.muted)
                Text(fresh ? "Your app is live" : "Live now")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Sand.text)
            }
            Text(url.host ?? url.absoluteString)
                .codeFont(14)
                .foregroundStyle(Sand.accent)
                .lineLimit(1)
                .truncationMode(.middle)
            HStack(spacing: Space.s) {
                Link(destination: url) { Label("Open", systemImage: "safari") }
                    .buttonStyle(RaisedButtonStyle(size: .small))
                ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
                    .buttonStyle(RaisedButtonStyle(size: .small))
                Button {
                    UIPasteboard.general.url = url
                    Haptics.tap()
                    ToastCenter.shared.show("Link copied", symbol: "doc.on.doc.fill")
                } label: { Label("Copy", systemImage: "doc.on.doc") }
                    .buttonStyle(RaisedButtonStyle(size: .small))
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(fresh ? Sand.successSoft : Sand.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(fresh ? Sand.success.opacity(0.3) : Sand.border, lineWidth: 1))
    }

    private var logView: some View {
        ScrollView(.horizontal) {
            Text(log.suffix(14).joined(separator: "\n"))
                .codeFont(11)
                .foregroundStyle(Sand.subtle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Space.m)
        }
        .scrollIndicators(.hidden)
        .background(Sand.elevated.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }

    private func start() {
        phase = .publishing
        status = ""
        log = []
        Haptics.firm()
        task = Task {
            do {
                for try await event in store.service.publish(projectId: store.projectId) {
                    switch event {
                    case .status(let text): withMotion { status = text }
                    case .output(let line): log.append(line)
                    case .failed(let message):
                        phase = .failed(message)
                        Haptics.error()
                        return
                    case .published(let urlString):
                        if let url = URL(string: urlString) {
                            store.project.cloudflareDeploymentUrl = urlString
                            phase = .published(store.project.liveURL ?? url)
                            Haptics.success()
                        }
                    }
                }
                if phase == .publishing { phase = .failed("Publishing ended before the site went live. Try again.") }
            } catch {
                phase = .failed(error.localizedDescription)
                Haptics.error()
            }
        }
    }
}

// MARK: - Share

struct ShareProjectSheet: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var members: [ProjectMember] = []
    @State private var loaded = false
    @State private var email = ""
    @State private var inviting = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if store.project.isOwner {
                    Section {
                        HStack(spacing: Space.s) {
                            TextField("name@example.com", text: $email)
                                .keyboardType(.emailAddress)
                                .textContentType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.send)
                                .onSubmit(invite)
                            Button(action: invite) {
                                if inviting { ProgressView() } else { Text("Invite").fontWeight(.semibold) }
                            }
                            .disabled(!email.contains("@") || inviting)
                        }
                        .listRowBackground(Sand.card)
                    } header: {
                        Text("Invite by email")
                    } footer: {
                        Text(error ?? "Collaborators can chat with the agents, see every chat live, and edit code. Secrets stay with you.")
                            .foregroundStyle(error == nil ? Sand.subtle : Sand.danger)
                    }
                }
                Section("People with access") {
                    if !loaded {
                        ProgressView().frame(maxWidth: .infinity).listRowBackground(Sand.card)
                    } else if members.isEmpty {
                        Text("Only you so far.").foregroundStyle(Sand.muted).listRowBackground(Sand.card)
                    }
                    ForEach(members) { member in
                        HStack(spacing: Space.m) {
                            AvatarView(initials: String((member.name ?? member.email ?? "?").prefix(2)).uppercased(), imageURL: member.imageUrl, size: 34)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(member.name ?? member.email ?? "Member").foregroundStyle(Sand.text).lineLimit(1)
                                if let address = member.email, address != member.name {
                                    Text(address).font(.footnote).foregroundStyle(Sand.subtle).lineLimit(1)
                                }
                            }
                            Spacer()
                            Badge(text: member.status == "pending" ? "Invited" : "Editor", tone: member.status == "pending" ? .warning : .neutral)
                        }
                        .listRowBackground(Sand.card)
                    }
                }
                if store.project.isPublic == true, let slug = store.project.publicSlug {
                    Section("Public page") {
                        ShareLink(item: AppConfig.baseURL.appendingPathComponent("p/\(slug)")) {
                            Label("Share the public page", systemImage: "link")
                        }
                        .listRowBackground(Sand.card)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Sand.canvas)
            .navigationTitle("Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        members = (try? await store.service.members(projectId: store.projectId)) ?? []
        loaded = true
    }

    private func invite() {
        let address = email.trimmingCharacters(in: .whitespaces)
        guard address.contains("@"), !inviting else { return }
        inviting = true
        error = nil
        Task {
            defer { inviting = false }
            do {
                try await store.service.invite(projectId: store.projectId, email: address)
                email = ""
                Haptics.success()
                ToastCenter.shared.show("Invite sent to \(address)", symbol: "paperplane.fill")
                await load()
            } catch let failure {
                error = failure.localizedDescription
                Haptics.error()
            }
        }
    }
}

// MARK: - Environment variables

struct EnvSheet: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var vars: [EnvVar] = []
    @State private var loaded = false
    @State private var adding = false
    @State private var key = ""
    @State private var value = ""
    @State private var secret = false
    @State private var saving = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if !loaded {
                        ProgressView().frame(maxWidth: .infinity).listRowBackground(Sand.card)
                    } else if vars.isEmpty {
                        Text("No variables yet.").foregroundStyle(Sand.muted).listRowBackground(Sand.card)
                    }
                    ForEach(vars) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(item.key).codeFont(13.5).foregroundStyle(Sand.text)
                                if item.isSystem == true { Badge(text: "Managed", tone: .neutral) }
                                if item.isSecret == true { Image(systemName: "lock.fill").font(.caption).foregroundStyle(Sand.subtle) }
                            }
                            Text(item.isSecret == true ? "••••••••" : (item.value ?? ""))
                                .codeFont(12)
                                .foregroundStyle(Sand.subtle)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .listRowBackground(Sand.card)
                        .swipeActions {
                            if item.isSystem != true {
                                Button(role: .destructive) { Task { await remove(item) } } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    }
                } footer: {
                    Text("Variables are written to the project's .env file. Secrets are encrypted and never shown again.")
                }
                Section {
                    if adding {
                        TextField("KEY_NAME", text: $key)
                            .codeFont(14)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .listRowBackground(Sand.card)
                        TextField("Value", text: $value)
                            .codeFont(14)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .listRowBackground(Sand.card)
                        Toggle("Keep secret", isOn: $secret).tint(Sand.accent).listRowBackground(Sand.card)
                        Button {
                            Task { await save() }
                        } label: {
                            if saving { ProgressView().frame(maxWidth: .infinity) } else { Text("Add variable").fontWeight(.semibold).frame(maxWidth: .infinity) }
                        }
                        .disabled(key.isEmpty || value.isEmpty || saving)
                        .listRowBackground(Sand.card)
                    } else {
                        Button { withMotion { adding = true } } label: { Label("Add a variable", systemImage: "plus") }
                            .listRowBackground(Sand.card)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Sand.canvas)
            .navigationTitle("Environment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        vars = (try? await store.service.envVars(projectId: store.projectId)) ?? []
        loaded = true
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await store.service.setEnvVar(projectId: store.projectId, key: key.trimmingCharacters(in: .whitespaces), value: value, secret: secret)
            key = ""
            value = ""
            secret = false
            withMotion { adding = false }
            Haptics.success()
            await load()
        } catch { ToastCenter.shared.error(error) }
    }

    private func remove(_ item: EnvVar) async {
        withMotion { vars.removeAll { $0.key == item.key } }
        do { try await store.service.deleteEnvVar(projectId: store.projectId, key: item.key) }
        catch {
            ToastCenter.shared.error(error)
            await load()
        }
    }
}

// MARK: - Terminal

/// Run commands in the project's sandbox, one at a time.
struct TerminalSheet: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @State private var output = AttributedString("")
    @State private var command = ""
    @State private var running = false
    @State private var task: Task<Void, Never>?
    @FocusState private var focused: Bool

    private let shortcuts = ["ls", "git status", "pnpm build", "pnpm install", "cat package.json"]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(output)
                            .codeFont(12.5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(Space.m)
                        Color.clear.frame(height: 1).id("end")
                    }
                    .onChange(of: output) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                }
                .background(Color(hex: 0x161412))

                VStack(spacing: Space.s) {
                    ScrollView(.horizontal) {
                        HStack(spacing: 6) {
                            ForEach(shortcuts, id: \.self) { item in
                                Button(item) {
                                    command = item
                                    run()
                                }
                                .codeFont(12)
                                .foregroundStyle(Sand.muted)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 30)
                                .background(Sand.card, in: Capsule())
                                .overlay(Capsule().strokeBorder(Sand.border, lineWidth: 1))
                            }
                        }
                        .padding(.horizontal, Space.m)
                    }
                    .scrollIndicators(.hidden)
                    HStack(spacing: Space.s) {
                        Text("$").codeFont(15).foregroundStyle(Sand.subtle)
                        TextField("Command", text: $command)
                            .codeFont(15)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focused)
                            .submitLabel(.go)
                            .onSubmit(run)
                        if running {
                            Button {
                                task?.cancel()
                                running = false
                            } label: { Image(systemName: "stop.fill") }
                                .buttonStyle(CircleIconButtonStyle(diameter: 34, filled: true))
                                .accessibilityLabel("Stop")
                        } else {
                            Button(action: run) { Image(systemName: "return") }
                                .buttonStyle(CircleIconButtonStyle(diameter: 34, filled: true))
                                .disabled(command.trimmingCharacters(in: .whitespaces).isEmpty)
                                .accessibilityLabel("Run")
                        }
                    }
                    .padding(.horizontal, Space.m)
                }
                .padding(.vertical, Space.s)
                .background(Sand.canvas)
            }
            .navigationTitle("Terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .onDisappear { task?.cancel() }
    }

    private func append(_ text: String, color: Color) {
        var piece = AttributedString(Self.stripANSI(text))
        piece.foregroundColor = color
        output.append(piece)
    }

    private func run() {
        let line = command.trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty, !running else { return }
        command = ""
        running = true
        append("$ \(line)\n", color: Color(hex: 0x8aa6ff))
        task = Task {
            do {
                for try await event in store.service.run(projectId: store.projectId, command: line) {
                    switch event {
                    case .output(let text, let isError): append(text, color: isError ? Color(hex: 0xff9d93) : Color(hex: 0xede6db))
                    case .exit(let code):
                        if code != 0 { append("exit \(code)\n", color: Color(hex: 0xff7a6e)) }
                    case .failed(let message): append(message + "\n", color: Color(hex: 0xff7a6e))
                    }
                }
            } catch {
                append(error.localizedDescription + "\n", color: Color(hex: 0xff7a6e))
            }
            running = false
        }
    }

    static func stripANSI(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
    }
}
