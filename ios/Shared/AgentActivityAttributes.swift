import ActivityKit
import Foundation

/// One running agent, shown on the Lock Screen and in the Dynamic Island.
struct AgentActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable {
            case starting, working, needsInput, done, failed
        }

        var phase: Phase
        /// What the agent is doing right now, e.g. "Editing".
        var action: String
        /// What it is doing it to, e.g. "src/App.tsx".
        var detail: String
        /// A symbol for the current tool.
        var symbol: String
        /// Tool calls so far this turn.
        var steps: Int
        /// The last few actions, newest last, for the expanded island.
        var recent: [String]
        var startedAt: Date
        var endedAt: Date?

        var isFinished: Bool { phase == .done || phase == .failed }
    }

    var projectId: String
    var threadId: String
    var projectName: String
    var threadTitle: String
    var modelName: String

    /// Opens the thread this activity belongs to.
    var deepLink: URL {
        URL(string: "botflow://project/\(projectId)/thread/\(threadId)")!
    }
}

/// How a tool call reads in a sentence and which symbol stands for it.
enum ToolPresentation {
    struct Info {
        var verb: String
        var symbol: String
    }

    static func info(for name: String) -> Info {
        switch name.lowercased() {
        case "read", "readfile", "read_file": return Info(verb: "Reading", symbol: "doc.text")
        case "write", "writefile", "write_file": return Info(verb: "Writing", symbol: "square.and.pencil")
        case "edit", "multiedit", "applydiff", "apply_patch", "patch": return Info(verb: "Editing", symbol: "pencil.line")
        case "bash", "shell", "bashoutput", "exec": return Info(verb: "Running", symbol: "terminal")
        case "grep", "search", "glob", "list", "ls": return Info(verb: "Searching", symbol: "magnifyingglass")
        case "task": return Info(verb: "Delegating", symbol: "person.2")
        case "webfetch", "websearch": return Info(verb: "Browsing", symbol: "globe")
        case "todowrite", "todoread": return Info(verb: "Planning", symbol: "checklist")
        case "ask_question", "askuserquestion": return Info(verb: "Asking you", symbol: "questionmark.bubble")
        case "startsimulator", "getsimulatorstatus", "stopsimulator": return Info(verb: "Building for iPhone", symbol: "iphone")
        case "startdevserver", "refreshpreview", "getdevserverlog": return Info(verb: "Starting the preview", symbol: "play.rectangle")
        case "getbrowserlog": return Info(verb: "Checking the preview", symbol: "ladybug")
        case "convexdeploy": return Info(verb: "Deploying the backend", symbol: "cylinder.split.1x2")
        case "generateimage", "image_gen": return Info(verb: "Drawing an image", symbol: "photo")
        case "requestenvvar", "request_env_var": return Info(verb: "Asking for a key", symbol: "key")
        default: return Info(verb: prettify(name), symbol: "wrench.and.screwdriver")
        }
    }

    /// "mcp__botflow__startDevServer" → "Start dev server".
    static func prettify(_ name: String) -> String {
        let base = name.components(separatedBy: "__").last ?? name
        var words: [String] = []
        var current = ""
        for character in base {
            if character == "_" || character == "-" {
                if !current.isEmpty { words.append(current); current = "" }
            } else if character.isUppercase, !current.isEmpty, current.last?.isLowercase == true {
                words.append(current)
                current = String(character)
            } else {
                current.append(character)
            }
        }
        if !current.isEmpty { words.append(current) }
        let sentence = words.map { $0.lowercased() }.joined(separator: " ")
        return sentence.prefix(1).uppercased() + sentence.dropFirst()
    }
}
