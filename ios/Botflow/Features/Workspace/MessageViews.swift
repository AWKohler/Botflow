import SwiftUI

// MARK: - Grouping

/// A message's parts regrouped for display: runs of tool calls become one
/// activity block, everything else stays its own item.
enum MessageSegment: Identifiable {
    case text(id: String, text: String)
    case reasoning(id: String, text: String, streaming: Bool)
    case tools(id: String, calls: [ToolCall])
    case question(ToolCall)
    case images([ImageAttachment])
    case notice(id: String, text: String, isError: Bool)

    var id: String {
        switch self {
        case .text(let id, _): return "t-\(id)"
        case .reasoning(let id, _, _): return "r-\(id)"
        case .tools(let id, _): return "g-\(id)"
        case .question(let call): return "q-\(call.id)"
        case .images(let images): return "i-\(images.first?.url ?? "")"
        case .notice(let id, _, _): return "n-\(id)"
        }
    }

    static func build(from message: ChatMessage) -> [MessageSegment] {
        var segments: [MessageSegment] = []
        var run: [ToolCall] = []
        var images: [ImageAttachment] = []
        func flush() {
            if !run.isEmpty {
                segments.append(.tools(id: run[0].id, calls: run))
                run = []
            }
        }
        for part in message.parts {
            switch part {
            case .tool(let call):
                if call.name == "ask_question" {
                    flush()
                    segments.append(.question(call))
                } else {
                    run.append(call)
                }
            case .text(let id, let text):
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                flush()
                segments.append(.text(id: id, text: text))
            case .reasoning(let id, let text, let streaming):
                flush()
                segments.append(.reasoning(id: id, text: text, streaming: streaming))
            case .image(let image):
                images.append(image)
            case .notice(let id, let text, let isError):
                flush()
                segments.append(.notice(id: id, text: text, isError: isError))
            }
        }
        flush()
        if !images.isEmpty { segments.insert(.images(images), at: 0) }
        return segments
    }
}

// MARK: - Messages

struct MessageView: View, Equatable {
    var message: ChatMessage
    var author: ThreadPerson?
    var showAuthor = false
    var onAnswer: (ToolCall, [String], [String], String?) -> Void = { _, _, _, _ in }
    var onInspect: (ToolCall) -> Void = { _ in }

    /// The callbacks never change what is drawn, so they are left out.
    static func == (a: MessageView, b: MessageView) -> Bool {
        a.message == b.message && a.author == b.author && a.showAuthor == b.showAuthor
    }

    var body: some View {
        if message.role == .user {
            UserMessageView(message: message, author: showAuthor ? author : nil)
        } else {
            AssistantMessageView(message: message, onAnswer: onAnswer, onInspect: onInspect)
        }
    }
}

struct UserMessageView: View {
    var message: ChatMessage
    var author: ThreadPerson?

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if let author {
                Text(author.name)
                    .font(.caption)
                    .foregroundStyle(Sand.subtle)
                    .padding(.trailing, 4)
            }
            let images = message.parts.compactMap { part -> ImageAttachment? in
                if case .image(let image) = part { return image }
                return nil
            }
            if !images.isEmpty {
                HStack(spacing: 6) {
                    ForEach(images) { image in
                        AttachmentThumb(url: image.url, size: 96)
                    }
                }
            }
            if !message.plainText.isEmpty {
                Text(message.plainText)
                    .font(.body)
                    .foregroundStyle(Sand.text)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Sand.elevated, in: UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18, style: .continuous))
                    .overlay(
                        UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18, style: .continuous)
                            .strokeBorder(Sand.border, lineWidth: 1)
                    )
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(message.plainText)")
    }
}

struct AttachmentThumb: View {
    var url: String
    var size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Sand.elevated)
            if let remote = URL(string: url), remote.scheme?.hasPrefix("http") == true {
                AsyncImage(url: remote) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    ProgressView().controlSize(.small)
                }
            } else {
                Image(systemName: "photo").foregroundStyle(Sand.subtle)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
    }
}

struct AssistantMessageView: View {
    var message: ChatMessage
    var onAnswer: (ToolCall, [String], [String], String?) -> Void
    var onInspect: (ToolCall) -> Void

    var body: some View {
        let segments = MessageSegment.build(from: message)
        VStack(alignment: .leading, spacing: 14) {
            ForEach(segments) { segment in
                switch segment {
                case .text(_, let text):
                    MarkdownView(text)
                case .reasoning(_, let text, let streaming):
                    ThinkingView(text: text, streaming: streaming)
                case .tools(_, let calls):
                    ToolGroupView(calls: calls, live: message.streaming && segment.id == segments.last?.id, onInspect: onInspect)
                case .question(let call):
                    QuestionCard(call: call, onAnswer: onAnswer)
                        // Where the card starts in the transcript, so the chat can bring its heading into view.
                        .background {
                            GeometryReader { proxy in
                                Color.clear.preference(key: QuestionTopKey.self, value: proxy.frame(in: .named("transcript")).minY)
                            }
                        }
                case .images(let images):
                    HStack { ForEach(images) { AttachmentThumb(url: $0.url, size: 96) } }
                case .notice(_, let text, let isError):
                    NoticeView(text: text, isError: isError)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NoticeView: View {
    var text: String
    var isError: Bool

    var body: some View {
        HStack(alignment: .top, spacing: Space.s) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "stop.circle")
                .foregroundStyle(isError ? Sand.danger : Sand.subtle)
                .font(.subheadline)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(isError ? Sand.text : Sand.muted)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(isError ? Space.m : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isError ? Sand.dangerSoft : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            if isError {
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Sand.danger.opacity(0.22), lineWidth: 1)
            }
        }
    }
}

// MARK: - Thinking

struct ThinkingView: View {
    var text: String
    var streaming: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Haptics.select()
                withMotion(.snappy(duration: 0.25)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "sparkle")
                        .pulsing(streaming)
                    Text(streaming ? "Thinking" : "Thought it through")
                        .shimmer(streaming)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .font(.subheadline)
                .foregroundStyle(Sand.subtle)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(text.isEmpty)

            if expanded, !text.isEmpty {
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(Sand.muted)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1).fill(Sand.border).frame(width: 2)
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

// MARK: - Tool calls

/// A run of tool calls as one compact block. Finished runs fold to a single
/// summary line; the run the agent is on right now stays open.
struct ToolGroupView: View {
    var calls: [ToolCall]
    var live: Bool
    var onInspect: (ToolCall) -> Void
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var open: Bool { live || expanded || calls.count <= 3 }
    private var failures: Int { calls.filter { $0.state == .error }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if calls.count > 3 {
                Button {
                    Haptics.select()
                    withMotion(.snappy(duration: 0.28)) { expanded.toggle() }
                } label: {
                    HStack(spacing: Space.s) {
                        Image(systemName: live ? "bolt.fill" : "checklist")
                            .font(.footnote)
                            .foregroundStyle(live ? Sand.accent : Sand.subtle)
                            .pulsing(live)
                        Text(summary)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Sand.muted)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if !live {
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Sand.subtle)
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                        }
                    }
                    .padding(.horizontal, Space.m)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(live)
                if open { Divider().overlay(Sand.border) }
            }
            if open {
                // While the agent works only its latest steps show, with a way
                // to see the rest.
                let folded = live && !expanded && calls.count > 5
                let shown = folded ? Array(calls.suffix(5)) : calls
                VStack(alignment: .leading, spacing: 0) {
                    if folded {
                        Button {
                            Haptics.select()
                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { expanded = true }
                        } label: {
                            Text("\(calls.count - shown.count) earlier steps")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(Sand.subtle)
                                .padding(.horizontal, Space.m)
                                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(shown) { call in
                        ToolRow(call: call, onInspect: onInspect)
                            .transition(reduceMotion ? .opacity : .asymmetric(insertion: .offset(y: 8).combined(with: .opacity), removal: .opacity))
                    }
                }
                .padding(.vertical, 3)
            }
        }
        .background(Sand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        // Arriving rows stay inside the card.
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
        .motion(.snappy(duration: 0.3), value: calls.count)
    }

    private var summary: String {
        if live { return "Working · \(calls.count) steps" }
        var edits = Set<String>()
        var commands = 0
        var reads = 0
        // Group by what the step does, so each agent's own tool names count.
        for call in calls {
            switch ToolPresentation.info(for: call.name).verb {
            case "Editing", "Writing": edits.insert(ToolSummary.detail(for: call))
            case "Running": commands += 1
            case "Reading", "Searching": reads += 1
            default: break
            }
        }
        var bits: [String] = []
        if !edits.isEmpty { bits.append(edits.count == 1 ? "edited 1 file" : "edited \(edits.count) files") }
        if commands > 0 { bits.append(commands == 1 ? "ran 1 command" : "ran \(commands) commands") }
        if bits.isEmpty, reads > 0 { bits.append("looked through the code") }
        let tail = failures > 0 ? " · \(failures) failed" : ""
        let lead = "\(calls.count) steps"
        return bits.isEmpty ? lead + tail : "\(lead) · \(bits.joined(separator: ", "))\(tail)"
    }
}

struct ToolRow: View {
    var call: ToolCall
    var onInspect: (ToolCall) -> Void

    var body: some View {
        let info = ToolPresentation.info(for: call.name)
        let detail = ToolSummary.detail(for: call)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptics.tap()
                onInspect(call)
            } label: {
                HStack(spacing: Space.s) {
                    ZStack {
                        switch call.state {
                        case .running:
                            ProgressView().controlSize(.mini)
                        case .done:
                            Image(systemName: info.symbol).foregroundStyle(Sand.subtle)
                        case .error:
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Sand.danger)
                        }
                    }
                    .font(.footnote)
                    .frame(width: 20)
                    Text(Self.label(for: call, info: info))
                        .font(.subheadline)
                        .foregroundStyle(call.state == .running ? Sand.text : Sand.muted)
                        .shimmer(call.state == .running)
                        .layoutPriority(1)
                    if !detail.isEmpty {
                        Text(detail)
                            .codeFont(12.5)
                            .foregroundStyle(Sand.subtle)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Sand.borderStrong)
                }
                .padding(.horizontal, Space.m)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(Self.label(for: call, info: info)) \(detail)")
            .accessibilityHint("Shows what the agent did")

            if !call.subagentSteps.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(call.subagentSteps.suffix(4)) { step in
                        HStack(spacing: 6) {
                            Circle().fill(step.state == .running ? Sand.accent : Sand.borderStrong).frame(width: 4, height: 4)
                            Text(step.kind == .tool ? ToolPresentation.info(for: step.toolName ?? "").verb : step.text)
                                .font(.footnote)
                                .foregroundStyle(Sand.subtle)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.leading, 44)
                .padding(.bottom, 8)
            }
        }
    }

    /// Past tense once a step is done: "Reading" → "Read".
    static func label(for call: ToolCall, info: ToolPresentation.Info) -> String {
        guard call.state != .running else { return info.verb }
        switch info.verb {
        case "Reading": return "Read"
        case "Writing": return "Wrote"
        case "Editing": return "Edited"
        case "Running": return "Ran"
        case "Searching": return "Searched"
        case "Delegating": return "Delegated"
        case "Browsing": return "Browsed"
        case "Planning": return "Planned"
        case "Building for iPhone": return call.state == .error ? "iPhone build failed" : "Built for iPhone"
        case "Starting the preview": return "Started the preview"
        case "Checking the preview": return "Checked the preview"
        case "Deploying the backend": return "Deployed the backend"
        case "Drawing an image": return "Drew an image"
        case "Asking for a key": return "Asked for a key"
        default: return info.verb
        }
    }
}

/// What a tool call was given and what came back.
struct ToolDetailSheet: View {
    var call: ToolCall
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let info = ToolPresentation.info(for: call.name)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    HStack(spacing: Space.m) {
                        Image(systemName: info.symbol)
                            .font(.title3)
                            .foregroundStyle(Sand.text)
                            .frame(width: 44, height: 44)
                            .background(Sand.elevated, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ToolRow.label(for: call, info: info)).font(.headline).foregroundStyle(Sand.text)
                            Text(call.name).codeFont(12).foregroundStyle(Sand.subtle)
                        }
                        Spacer()
                        Badge(text: call.state == .running ? "Running" : call.state == .error ? "Failed" : "Done", tone: call.state == .running ? .accent : call.state == .error ? .danger : .success)
                    }
                    section("Input", text: inputText, language: inputLanguage)
                    if let error = call.errorText {
                        section("Error", text: error, language: "")
                    } else if let output = call.output {
                        section("Result", text: String(output.displayText.prefix(12_000)), language: "")
                    }
                }
                .padding(Space.gutter)
            }
            .background(Sand.bg)
            .navigationTitle("Step")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Sand.bg)
    }

    private var inputText: String {
        if let command = call.input["command"]?.stringValue { return command }
        if let patch = call.input["patchText"]?.stringValue { return patch }
        if let content = call.input["content"]?.stringValue { return content }
        if let newString = call.input["new_string"]?.stringValue {
            let old = call.input["old_string"]?.stringValue ?? ""
            return old.split(separator: "\n", omittingEmptySubsequences: false).map { "- \($0)" }.joined(separator: "\n")
                + "\n" + newString.split(separator: "\n", omittingEmptySubsequences: false).map { "+ \($0)" }.joined(separator: "\n")
        }
        return call.input.prettyPrinted
    }

    private var inputLanguage: String {
        if call.input["command"] != nil { return "sh" }
        if let path = call.input["file_path"]?.stringValue, call.input["content"] != nil { return CodeHighlighter.language(forPath: path) }
        return "json"
    }

    @ViewBuilder
    private func section(_ title: String, text: String, language: String) -> some View {
        if !text.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Sand.subtle)
                    .textCase(.uppercase)
                    .kerning(0.4)
                if let path = call.input["file_path"]?.stringValue, title == "Input" {
                    Text(ToolSummary.shortPath(path)).codeFont(12.5).foregroundStyle(Sand.muted)
                }
                CodeBlock(language: language, text: text)
            }
        }
    }
}

// MARK: - Questions

/// The agent asked something and is waiting. Answering here unblocks it.
struct QuestionCard: View {
    var call: ToolCall
    var onAnswer: (ToolCall, [String], [String], String?) -> Void

    @State private var selected: [String: Set<String>] = [:]
    @State private var note = ""
    @State private var sending = false

    private var questions: [AgentQuestion] { AgentQuestion.parse(call.input) }
    private var answered: Bool { call.state != .running }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack(spacing: Space.s) {
                Image(systemName: answered ? "checkmark.bubble.fill" : "questionmark.bubble.fill")
                    .foregroundStyle(answered ? Sand.success : Sand.warningSolid)
                Text(answered ? "You answered" : "The agent needs your input")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Sand.text)
            }
            ForEach(questions) { question in
                VStack(alignment: .leading, spacing: Space.s) {
                    if let header = question.header {
                        Text(header.uppercased())
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Sand.subtle)
                            .kerning(0.4)
                    }
                    Text(question.question)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Sand.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if !answered {
                        VStack(spacing: Space.s) {
                            ForEach(question.options) { option in
                                optionRow(question, option)
                            }
                        }
                        .padding(.top, 2)
                    }
                }
            }
            if answered {
                if let text = call.output?.displayText, !text.isEmpty {
                    Text(text)
                        .font(.subheadline)
                        .foregroundStyle(Sand.muted)
                        .lineLimit(4)
                }
            } else {
                TextField("Or answer in your own words", text: $note, axis: .vertical)
                    .lineLimit(1...4)
                    .font(.subheadline)
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, 10)
                    .background(Sand.bg, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Sand.borderStrong, lineWidth: 1))
                Button {
                    submit()
                } label: {
                    HStack(spacing: Space.s) {
                        if sending { ProgressView().tint(Sand.bg) }
                        Text("Send answer")
                    }
                }
                .buttonStyle(InkButtonStyle(fullWidth: true))
                .disabled(!canSubmit || sending)
            }
        }
        .padding(Space.l)
        .background(answered ? Sand.card : Sand.warningSoft, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(answered ? Sand.border : Sand.warningSolid.opacity(0.35), lineWidth: 1)
        )
    }

    private var canSubmit: Bool {
        !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || questions.allSatisfy { !(selected[$0.id] ?? []).isEmpty }
    }

    private func optionRow(_ question: AgentQuestion, _ option: AgentQuestion.Option) -> some View {
        let isOn = selected[question.id]?.contains(option.id) ?? false
        return Button {
            Haptics.select()
            withMotion(.snappy(duration: 0.2)) {
                var set = selected[question.id] ?? []
                if question.multiSelect {
                    if isOn { set.remove(option.id) } else { set.insert(option.id) }
                } else {
                    set = isOn ? [] : [option.id]
                }
                selected[question.id] = set
            }
        } label: {
            HStack(alignment: .top, spacing: Space.m) {
                Image(systemName: isOn ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle") : (question.multiSelect ? "square" : "circle"))
                    .font(.title3)
                    .foregroundStyle(isOn ? Sand.accent : Sand.control)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Sand.text)
                    if let description = option.description {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(Sand.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(Space.m)
            .frame(minHeight: 48)
            .background(Sand.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(isOn ? Sand.accent : Sand.border, lineWidth: isOn ? 1.5 : 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .multilineTextAlignment(.leading)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    private func submit() {
        sending = true
        var ids: [String] = []
        var labels: [String] = []
        for question in questions {
            for option in question.options where selected[question.id]?.contains(option.id) == true {
                ids.append(option.id)
                labels.append(option.label)
            }
        }
        onAnswer(call, ids, labels, note.isEmpty ? nil : note)
    }
}


/// The top of the waiting question's card, in the transcript's own coordinates.
struct QuestionTopKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        // The last card in the transcript is the one waiting.
        if let next = nextValue() { value = next }
    }
}
