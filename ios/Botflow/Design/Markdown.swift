import SwiftUI

/// A small Markdown renderer for agent replies: headings, paragraphs, nested
/// lists, fenced code, quotes, rules and tables. Inline styling (bold, italic,
/// code, links) goes through Foundation's parser.
enum MarkdownBlock: Hashable {
    struct Item: Hashable {
        var marker: String
        var text: String
        var level: Int
    }

    case heading(level: Int, text: String)
    case paragraph(String)
    case list([Item])
    case code(language: String, text: String)
    case quote(String)
    case rule
    case table(header: [String], rows: [[String]])
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: [MarkdownBlock.Item] = []
        var quote: [String] = []
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        func flushList() {
            if !list.isEmpty { blocks.append(.list(list)); list = [] }
        }
        func flushQuote() {
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }
        func flushAll() { flushParagraph(); flushList(); flushQuote() }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[index])
                    index += 1
                }
                blocks.append(.code(language: language, text: body.joined(separator: "\n")))
                index += 1
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                flushQuote()
                // A blank line between items keeps the list going.
                if index + 1 < lines.count, listItem(lines[index + 1]) == nil { flushList() }
                index += 1
                continue
            }

            if let heading = heading(trimmed) {
                flushAll()
                blocks.append(.heading(level: heading.0, text: heading.1))
                index += 1
                continue
            }

            let compact = trimmed.replacingOccurrences(of: " ", with: "")
            if compact.count >= 3, let mark = compact.first, "-*_".contains(mark), compact.allSatisfy({ $0 == mark }) {
                flushAll()
                blocks.append(.rule)
                index += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph(); flushList()
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                index += 1
                continue
            }

            if trimmed.contains("|"), index + 1 < lines.count, isTableDivider(lines[index + 1]) {
                flushAll()
                let header = cells(trimmed)
                var rows: [[String]] = []
                index += 2
                while index < lines.count, lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(cells(lines[index]))
                    index += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }

            if let item = listItem(line) {
                flushParagraph(); flushQuote()
                // A numbered list after a bulleted one (or the reverse) is a new list.
                if let first = list.first, item.level == 0, (first.marker == "•") != (item.marker == "•") { flushList() }
                list.append(item)
                index += 1
                continue
            }

            if !list.isEmpty, line.hasPrefix("  ") {
                // A wrapped line of the previous item.
                list[list.count - 1].text += " " + trimmed
                index += 1
                continue
            }

            flushList(); flushQuote()
            paragraph.append(trimmed)
            index += 1
        }
        flushAll()
        return blocks
    }

    private static func heading(_ line: String) -> (Int, String)? {
        var level = 0
        for character in line {
            if character == "#" { level += 1 } else { break }
        }
        guard (1...6).contains(level), line.count > level, line[line.index(line.startIndex, offsetBy: level)] == " " else { return nil }
        return (level, String(line.dropFirst(level + 1)).trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> MarkdownBlock.Item? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let body = line.drop { $0 == " " || $0 == "\t" }
        guard let first = body.first else { return nil }
        if "-*+".contains(first), body.dropFirst().first == " " {
            return .init(marker: "•", text: String(body.dropFirst(2)).trimmingCharacters(in: .whitespaces), level: min(3, indent / 2))
        }
        let digits = body.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 3 {
            let rest = body.dropFirst(digits.count)
            if let mark = rest.first, mark == "." || mark == ")", rest.dropFirst().first == " " {
                return .init(marker: "\(digits).", text: String(rest.dropFirst(2)).trimmingCharacters(in: .whitespaces), level: min(3, indent / 2))
            }
        }
        return nil
    }

    private static func isTableDivider(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.contains("-") && trimmed.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Inline Markdown to attributed text, with code spans and links restyled
    /// for the sand palette.
    static func inline(_ text: String, baseFont: Font = .body) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        options.failurePolicy = .returnPartiallyParsedIfPossible
        guard var attributed = try? AttributedString(markdown: text, options: options) else {
            return AttributedString(text)
        }
        for run in attributed.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                attributed[run.range].font = .system(.callout, design: .monospaced)
                attributed[run.range].backgroundColor = Sand.elevated
                attributed[run.range].foregroundColor = Sand.text
            }
            if run.link != nil {
                attributed[run.range].foregroundColor = Sand.accent
                attributed[run.range].underlineStyle = .single
            }
        }
        return attributed
    }
}

struct MarkdownView: View {
    var text: String
    private let blocks: [MarkdownBlock]

    init(_ text: String) {
        self.text = text
        self.blocks = MarkdownParser.parse(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(MarkdownParser.inline(text))
                .font(level <= 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .foregroundStyle(Sand.text)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(MarkdownParser.inline(text))
                .font(.body)
                .foregroundStyle(Sand.text)
                .lineSpacing(3.5)
                .fixedSize(horizontal: false, vertical: true)
        case .list(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.marker)
                            .font(.body)
                            .foregroundStyle(Sand.subtle)
                            .monospacedDigit()
                            .frame(minWidth: 14, alignment: .trailing)
                        Text(MarkdownParser.inline(item.text))
                            .font(.body)
                            .foregroundStyle(Sand.text)
                            .lineSpacing(3.5)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.level) * 18)
                }
            }
        case .code(let language, let text):
            CodeBlock(language: language, text: text)
        case .quote(let text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(Sand.borderStrong).frame(width: 3)
                Text(MarkdownParser.inline(text))
                    .font(.body)
                    .foregroundStyle(Sand.muted)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle().fill(Sand.border).frame(height: 1).padding(.vertical, 4)
        case .table(let header, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                            Text(MarkdownParser.inline(cell)).font(.subheadline.weight(.semibold)).foregroundStyle(Sand.text)
                        }
                    }
                    Divider().overlay(Sand.border)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(MarkdownParser.inline(cell)).font(.subheadline).foregroundStyle(Sand.text)
                            }
                        }
                    }
                }
                .padding(Space.m)
            }
            .scrollIndicators(.hidden)
            .background(Sand.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
        }
    }
}

struct CodeBlock: View {
    var language: String
    var text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Sand.subtle)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    Haptics.tap()
                    withAnimation { copied = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { withAnimation { copied = false } }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(copied ? Sand.success : Sand.muted)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, 7)
            Divider().overlay(Sand.border)
            ScrollView(.horizontal) {
                Text(CodeHighlighter.highlight(text, language: language, size: 12.5))
                    .padding(Space.m)
                    .fixedSize(horizontal: true, vertical: true)
            }
            .scrollIndicators(.hidden)
        }
        .background(Sand.elevated.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
    }
}
