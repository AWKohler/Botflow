import SwiftUI

/// A small tokenizer that colours source code with the website's code palette.
/// It recognises comments, strings, numbers, keywords, type names and calls:
/// enough to make a file readable, not a full parser.
enum CodeHighlighter {
    private static let keywords: [String: Set<String>] = [
        "swift": ["import", "struct", "class", "enum", "protocol", "extension", "func", "var", "let", "if", "else", "guard", "return", "for", "in", "while", "switch", "case", "default", "break", "continue", "self", "Self", "init", "deinit", "throws", "throw", "try", "catch", "do", "async", "await", "private", "public", "internal", "fileprivate", "static", "final", "some", "any", "nil", "true", "false", "where", "as", "is", "super", "mutating", "lazy", "weak", "override", "typealias", "defer", "actor"],
        "ts": ["import", "export", "from", "default", "const", "let", "var", "function", "return", "if", "else", "for", "while", "of", "in", "switch", "case", "break", "continue", "class", "extends", "implements", "interface", "type", "enum", "new", "this", "super", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "null", "undefined", "true", "false", "void", "as", "readonly", "public", "private", "static", "yield", "delete"],
        "py": ["import", "from", "as", "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "None", "True", "False", "try", "except", "finally", "raise", "with", "lambda", "pass", "break", "continue", "yield", "async", "await", "self", "global"],
        "css": ["important", "media", "import", "keyframes", "supports", "from", "to"],
        "sh": ["if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "function", "export", "echo", "cd", "return", "exit", "local"],
    ]

    static func family(for language: String) -> String {
        switch language.lowercased() {
        case "swift": return "swift"
        case "ts", "tsx", "js", "jsx", "typescript", "javascript", "mjs", "cjs", "json": return "ts"
        case "py", "python": return "py"
        case "css", "scss": return "css"
        case "sh", "bash", "zsh", "shell": return "sh"
        case "html", "xml", "svg", "vue": return "html"
        case "yml", "yaml", "toml", "env": return "sh"
        default: return "ts"
        }
    }

    static func language(forPath path: String) -> String {
        (path as NSString).pathExtension.lowercased()
    }

    static func highlight(_ source: String, language: String, size: CGFloat = 13) -> AttributedString {
        // Very large files render as plain text rather than stall the main thread.
        var result = AttributedString(source)
        result.font = .code(size)
        result.foregroundColor = Sand.text
        guard source.utf16.count < 120_000 else { return result }

        let family = family(for: language)
        let words = keywords[family] ?? keywords["ts"]!
        let hashComments = family == "py" || family == "sh"
        let slashComments = family == "swift" || family == "ts" || family == "css"
        let scalars = Array(source.unicodeScalars)
        let count = scalars.count

        // Map scalar offsets to attributed-string indices in one pass.
        var indices: [AttributedString.Index] = []
        indices.reserveCapacity(count + 1)
        var cursor = result.startIndex
        let view = result.unicodeScalars
        for _ in 0..<count {
            indices.append(cursor)
            cursor = view.index(after: cursor)
        }
        indices.append(result.endIndex)

        func paint(_ start: Int, _ end: Int, _ color: Color) {
            guard start < end, end <= count else { return }
            result[indices[start]..<indices[end]].foregroundColor = color
        }
        func isWordStart(_ s: Unicode.Scalar) -> Bool { s == "_" || s == "$" || s == "@" || s.properties.isAlphabetic }
        func isWord(_ s: Unicode.Scalar) -> Bool { isWordStart(s) || ("0"..."9").contains(s) }

        var i = 0
        while i < count {
            let c = scalars[i]
            // Comments
            if slashComments, c == "/", i + 1 < count, scalars[i + 1] == "/" {
                var j = i
                while j < count, scalars[j] != "\n" { j += 1 }
                paint(i, j, Sand.subtle)
                i = j
                continue
            }
            if slashComments, c == "/", i + 1 < count, scalars[i + 1] == "*" {
                var j = i + 2
                while j + 1 < count, !(scalars[j] == "*" && scalars[j + 1] == "/") { j += 1 }
                j = min(count, j + 2)
                paint(i, j, Sand.subtle)
                i = j
                continue
            }
            if hashComments, c == "#", i == 0 || scalars[i - 1] == "\n" || scalars[i - 1] == " " {
                var j = i
                while j < count, scalars[j] != "\n" { j += 1 }
                paint(i, j, Sand.subtle)
                i = j
                continue
            }
            if family == "html", c == "<", i + 3 < count, scalars[i + 1] == "!", scalars[i + 2] == "-" {
                var j = i
                while j + 2 < count, !(scalars[j] == "-" && scalars[j + 1] == "-" && scalars[j + 2] == ">") { j += 1 }
                j = min(count, j + 3)
                paint(i, j, Sand.subtle)
                i = j
                continue
            }
            // Strings
            if c == "\"" || c == "'" || c == "`" {
                var j = i + 1
                while j < count, scalars[j] != c {
                    if scalars[j] == "\\" { j += 1 }
                    if c != "`", j < count, scalars[j] == "\n" { break }
                    j += 1
                }
                j = min(count, j + 1)
                paint(i, j, Sand.codeString)
                i = j
                continue
            }
            // Numbers
            if ("0"..."9").contains(c), i == 0 || !isWord(scalars[i - 1]) {
                var j = i
                while j < count, isWord(scalars[j]) || scalars[j] == "." { j += 1 }
                paint(i, j, Sand.codeType)
                i = j
                continue
            }
            // Tags
            if family == "html", c == "<" {
                var j = i + 1
                if j < count, scalars[j] == "/" { j += 1 }
                let start = j
                while j < count, isWord(scalars[j]) || scalars[j] == "-" { j += 1 }
                paint(start, j, Sand.codeKeyword)
                i = max(j, i + 1)
                continue
            }
            // Words
            if isWordStart(c) {
                var j = i
                while j < count, isWord(scalars[j]) { j += 1 }
                var word = String.UnicodeScalarView()
                word.append(contentsOf: scalars[i..<j])
                let text = String(word)
                if words.contains(text) {
                    paint(i, j, Sand.codeKeyword)
                } else if text.hasPrefix("@") {
                    paint(i, j, Sand.codeProperty)
                } else if j < count, scalars[j] == "(" {
                    paint(i, j, Sand.codeFunction)
                } else if let first = text.unicodeScalars.first, first.properties.isUppercase {
                    paint(i, j, Sand.codeType)
                } else if i > 0, scalars[i - 1] == "." {
                    paint(i, j, Sand.codeProperty)
                } else if family == "ts" || family == "css", j < count, scalars[j] == ":" {
                    paint(i, j, Sand.codeProperty)
                }
                i = j
                continue
            }
            i += 1
        }
        return result
    }
}
