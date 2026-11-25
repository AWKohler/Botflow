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
        /// The steps already finished, newest last, in the past tense
        /// ("Edited src/App.tsx"), for the expanded island.
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
        /// While it is happening: "Editing".
        var verb: String
        /// Once it is done: "Edited".
        var past: String
        var symbol: String
    }

    static func info(for name: String) -> Info {
        switch name.lowercased() {
        case "read", "readfile", "read_file": return Info(verb: "Reading", past: "Read", symbol: "doc.text")
        case "write", "writefile", "write_file": return Info(verb: "Writing", past: "Wrote", symbol: "square.and.pencil")
        case "edit", "multiedit", "applydiff", "apply_patch", "patch": return Info(verb: "Editing", past: "Edited", symbol: "pencil.line")
        case "bash", "shell", "bashoutput", "exec": return Info(verb: "Running", past: "Ran", symbol: "terminal")
        case "grep", "search", "glob", "list", "ls": return Info(verb: "Searching", past: "Searched", symbol: "magnifyingglass")
        case "task": return Info(verb: "Delegating", past: "Delegated", symbol: "person.2")
        case "webfetch", "websearch": return Info(verb: "Browsing", past: "Browsed", symbol: "globe")
        case "todowrite", "todoread": return Info(verb: "Planning", past: "Planned", symbol: "checklist")
        case "ask_question", "askuserquestion": return Info(verb: "Asking you", past: "Asked you", symbol: "questionmark.bubble")
        case "startsimulator", "getsimulatorstatus", "stopsimulator": return Info(verb: "Building for iPhone", past: "Built for iPhone", symbol: "iphone")
        case "startdevserver", "refreshpreview", "getdevserverlog": return Info(verb: "Starting the preview", past: "Started the preview", symbol: "play.rectangle")
        case "getbrowserlog": return Info(verb: "Checking the preview", past: "Checked the preview", symbol: "ladybug")
        case "convexdeploy": return Info(verb: "Deploying the backend", past: "Deployed the backend", symbol: "cylinder.split.1x2")
        case "generateimage", "image_gen": return Info(verb: "Drawing an image", past: "Drew an image", symbol: "photo")
        case "requestenvvar", "request_env_var": return Info(verb: "Asking for a key", past: "Asked for a key", symbol: "key")
        default: return Info(verb: prettify(name), past: prettify(name), symbol: "wrench.and.screwdriver")
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
