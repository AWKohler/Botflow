import SwiftUI

/// The project's files: a tree to browse, full-text search, and a viewer that
/// can also edit and save.
struct CodeBrowser: View {
    @ObservedObject var store: WorkspaceStore
    @State private var expanded: Set<String> = ["src", "convex", "app"]
    @State private var selected: String? = AppConfig.demoRoute == "workspace-file" ? "src/components/Cart.tsx" : nil
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var searching = false

    private static let hidden: Set<String> = ["node_modules", ".git", "dist", ".next", ".vite", "build", ".DS_Store", "DerivedData", ".build"]

    private struct Row: Identifiable {
        var file: SandboxFile
        var depth: Int
        var id: String { file.path }
    }

    private var rows: [Row] {
        var result: [Row] = []
        let visible = store.files.filter { file in
            !file.path.split(separator: "/").contains { Self.hidden.contains(String($0)) }
        }
        // Folders first, then files, alphabetically within each folder.
        let sorted = visible.sorted { a, b in
            let pa = a.path.split(separator: "/").map(String.init), pb = b.path.split(separator: "/").map(String.init)
            for index in 0..<min(pa.count, pb.count) where pa[index] != pb[index] {
                let aIsFolder = index < pa.count - 1 || a.isDirectory
                let bIsFolder = index < pb.count - 1 || b.isDirectory
                if aIsFolder != bIsFolder { return aIsFolder }
                return pa[index].localizedCaseInsensitiveCompare(pb[index]) == .orderedAscending
            }
            return pa.count < pb.count
        }
        for file in sorted {
            let parts = file.path.split(separator: "/").map(String.init)
            var parent = ""
            var shown = true
            for part in parts.dropLast() {
                parent = parent.isEmpty ? part : parent + "/" + part
                if !expanded.contains(parent) { shown = false; break }
            }
            if shown { result.append(Row(file: file, depth: parts.count - 1)) }
        }
        return result
    }

    var body: some View {
        GeometryReader { proxy in
            let split = proxy.size.width >= 640
            if split {
                HStack(spacing: 0) {
                    tree.frame(width: 270)
                    Divider().overlay(Sand.border)
                    if let selected {
                        FileViewer(store: store, path: selected)
                            .id(selected)
                    } else {
                        EmptyState(symbol: "doc.text", title: "Pick a file", message: "Its code opens here.")
                            .background(Sand.card)
                    }
                }
            } else if let selected {
                // One column: the file replaces the list, with a way back.
                FileViewer(store: store, path: selected, onBack: {
                    withMotion(.snappy(duration: 0.25)) { self.selected = nil }
                })
                .id(selected)
                .transition(.move(edge: .trailing))
            } else {
                tree.transition(.move(edge: .leading))
            }
        }
        .task {
            if store.files.isEmpty { await store.loadFiles() }
        }
    }

    private var tree: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                Image(systemName: "magnifyingglass").foregroundStyle(Sand.subtle)
                TextField("Search in files", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { Task { await search() } }
                if !query.isEmpty {
                    Button {
                        query = ""
                        hits = []
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Sand.subtle)
                    }
                    .accessibilityLabel("Clear search")
                }
            }
            .font(.subheadline)
            .padding(.horizontal, Space.m)
            .frame(minHeight: 38)
            .background(Sand.card, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
            .padding(.horizontal, Space.m)
            .padding(.bottom, Space.s)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if searching {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    } else if !query.isEmpty, !hits.isEmpty {
                        ForEach(hits) { hit in
                            Button {
                                selected = hit.path
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(ToolSummary.shortPath(hit.path)):\(hit.line)")
                                        .codeFont(11.5)
                                        .foregroundStyle(Sand.subtle)
                                    Text(hit.text.trimmingCharacters(in: .whitespaces))
                                        .codeFont(12.5)
                                        .foregroundStyle(Sand.text)
                                        .lineLimit(2)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, Space.l)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    } else if store.filesLoading || (store.files.isEmpty && store.sandbox != .ready) {
                        VStack(spacing: Space.m) {
                            ProgressView()
                            Text(store.sandbox == .booting ? "Waking the sandbox" : "Loading files")
                                .font(.subheadline)
                                .foregroundStyle(Sand.muted)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                    } else if case .failed(let message) = store.sandbox {
                        ErrorBanner(message: message) { Task { await store.bootSandbox() } }
                            .padding(Space.m)
                    } else {
                        ForEach(rows) { row in
                            fileRow(row)
                        }
                    }
                }
                .padding(.bottom, Space.xl)
            }
            .refreshable { await store.loadFiles() }
        }
        .background(Sand.canvas)
    }

    private func fileRow(_ row: Row) -> some View {
        let isSelected = row.file.path == selected
        return Button {
            Haptics.select()
            if row.file.isDirectory {
                withMotion(.snappy(duration: 0.2)) {
                    if expanded.contains(row.file.path) { expanded.remove(row.file.path) } else { expanded.insert(row.file.path) }
                }
            } else {
                withMotion(.snappy(duration: 0.25)) { selected = row.file.path }
            }
        } label: {
            HStack(spacing: 7) {
                if row.file.isDirectory {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Sand.subtle)
                        .rotationEffect(.degrees(expanded.contains(row.file.path) ? 90 : 0))
                        .frame(width: 12)
                    Image(systemName: expanded.contains(row.file.path) ? "folder.fill" : "folder")
                        .foregroundStyle(Sand.muted)
                        .frame(width: 22)
                } else {
                    Spacer().frame(width: 12)
                    Image(systemName: Self.symbol(for: row.file.name))
                        .foregroundStyle(Sand.subtle)
                        .frame(width: 22)
                }
                Text(row.file.name)
                    .font(.subheadline)
                    .foregroundStyle(Sand.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, Space.m + CGFloat(row.depth) * 16)
            .padding(.trailing, Space.m)
            .frame(minHeight: 44)
            .background(isSelected ? Sand.elevated : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(row.file.isDirectory ? "Folder \(row.file.name)" : row.file.name)
    }

    static func symbol(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "swift": return "swift"
        case "ts", "tsx", "js", "jsx", "mjs": return "curlybraces"
        case "json", "yml", "yaml", "toml": return "list.bullet.indent"
        case "css", "scss": return "paintbrush"
        case "html": return "chevron.left.forwardslash.chevron.right"
        case "md", "mdx", "txt": return "doc.plaintext"
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "ico": return "photo"
        default: return "doc"
        }
    }

    private func search() async {
        let pattern = query.trimmingCharacters(in: .whitespaces)
        guard !pattern.isEmpty else { return }
        searching = true
        defer { searching = false }
        do { hits = try await store.service.searchFiles(projectId: store.projectId, pattern: pattern) }
        catch { ToastCenter.shared.error(error) }
    }
}

struct FileViewer: View {
    @ObservedObject var store: WorkspaceStore
    var path: String
    /// Set when the viewer replaces the file list: shows a "Files" back control.
    var onBack: (() -> Void)?

    @State private var content = ""
    @State private var original = ""
    @State private var hash: String?
    @State private var loading = true
    @State private var error: String?
    @State private var binary = false
    @State private var editing = false
    @State private var saving = false
    @State private var highlighted = AttributedString("")

    private var dirty: Bool { content != original }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                if let onBack {
                    Button(action: onBack) {
                        HStack(spacing: 3) {
                            Image(systemName: "chevron.left").font(.subheadline.weight(.semibold))
                            Text("Files")
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Sand.text)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back to files")
                } else {
                    Image(systemName: CodeBrowser.symbol(for: (path as NSString).lastPathComponent)).foregroundStyle(Sand.subtle)
                }
                Text(onBack == nil ? path : (path as NSString).lastPathComponent)
                    .codeFont(12.5)
                    .foregroundStyle(Sand.muted)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer()
                actions
            }
            .padding(.horizontal, Space.m)
            .frame(minHeight: 44)
            Divider().overlay(Sand.border)
            Group {
                if loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error {
                    EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't open the file", message: error)
                } else if binary {
                    EmptyState(symbol: "doc.zipper", title: "Binary file", message: "This file isn't text, so there's nothing to show.")
                } else if editing {
                    TextEditor(text: $content)
                        .codeFont(13)
                        .foregroundStyle(Sand.text)
                        .scrollContentBackground(.hidden)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, Space.s)
                } else {
                    ScrollView([.vertical, .horizontal]) {
                        HStack(alignment: .top, spacing: Space.m) {
                            Text(lineNumbers)
                                .codeFont(13)
                                .foregroundStyle(Sand.borderStrong)
                                .multilineTextAlignment(.trailing)
                                .accessibilityHidden(true)
                            Text(highlighted)
                                .codeFont(13)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: true)
                        }
                        .lineSpacing(3)
                        .padding(Space.m)
                    }
                }
            }
            .background(Sand.card)
        }
        .task { await load() }
    }

    @ViewBuilder
    private var actions: some View {
        if !loading, error == nil, !binary {
            if editing {
                HStack(spacing: Space.m) {
                    Button("Cancel") {
                        content = original
                        editing = false
                    }
                    .foregroundStyle(Sand.muted)
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Save").fontWeight(.semibold) }
                    }
                    .disabled(!dirty || saving)
                }
                .font(.subheadline)
            } else {
                Button("Edit") { editing = true }
                    .font(.subheadline.weight(.medium))
            }
        }
    }

    private var lineNumbers: String {
        let count = max(1, content.components(separatedBy: "\n").count)
        return (1...count).map(String.init).joined(separator: "\n")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let file = try await store.service.readFile(projectId: store.projectId, path: path)
            binary = file.binary
            content = file.binary ? "" : file.content
            original = content
            hash = file.hash
            highlighted = CodeHighlighter.highlight(content, language: CodeHighlighter.language(forPath: path))
        } catch let failure {
            error = failure.localizedDescription
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            hash = try await store.service.writeFile(projectId: store.projectId, path: path, content: content, baseHash: hash)
            original = content
            highlighted = CodeHighlighter.highlight(content, language: CodeHighlighter.language(forPath: path))
            editing = false
            store.previewReloadToken += 1
            Haptics.success()
            ToastCenter.shared.show("Saved \((path as NSString).lastPathComponent)")
        } catch let failure as APIError where failure.status == 409 {
            ToastCenter.shared.show("This file changed while you were editing. Close and reopen it to see the new version.", symbol: "exclamationmark.triangle.fill", tone: .warning)
        } catch {
            ToastCenter.shared.error(error)
        }
    }
}
