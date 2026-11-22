import Foundation

/// One chunk of the agent's UI message stream (the AI SDK "UI message stream"
/// protocol the web app's routes produce).
struct StreamChunk: Sendable {
    var type: String
    var payload: JSONValue

    init?(line: String) {
        guard let data = line.data(using: .utf8),
              let payload = try? JSONDecoder().decode(JSONValue.self, from: data),
              let type = payload["type"]?.stringValue else { return nil }
        self.type = type
        self.payload = payload
    }

    init(type: String, payload: JSONValue) {
        self.type = type
        self.payload = payload
    }
}

struct ContextUsage: Equatable, Sendable {
    var tokens: Int
    var compacting: Bool = false
}

/// Folds stream chunks into one assistant message. A reattach replays the
/// turn from its first event, so a fresh assembler rebuilds the same message.
struct MessageAssembler: Sendable {
    private(set) var message: ChatMessage
    private(set) var finished = false
    private(set) var sawEndTurn = false
    private(set) var errorText: String?
    private(set) var usage: ContextUsage?
    private var endTurnIds: Set<String> = []

    init(messageId: String) {
        message = ChatMessage(id: messageId, role: .assistant, parts: [], streaming: true)
    }

    mutating func apply(_ chunk: StreamChunk) {
        let p = chunk.payload
        switch chunk.type {
        case "start":
            if let id = p["messageId"]?.stringValue, id != message.id {
                message = ChatMessage(id: id, role: .assistant, parts: message.parts, streaming: true)
            }
        case "text-start":
            guard let id = p["id"]?.stringValue else { return }
            message.parts.append(.text(id: id, text: ""))
        case "text-delta":
            guard let id = p["id"]?.stringValue, let delta = p["delta"]?.stringValue else { return }
            if let index = message.parts.lastIndex(where: { $0.id == "t:\(id)" }),
               case .text(_, let text) = message.parts[index] {
                message.parts[index] = .text(id: id, text: text + delta)
            } else {
                message.parts.append(.text(id: id, text: delta))
            }
        case "reasoning-start":
            guard let id = p["id"]?.stringValue else { return }
            message.parts.append(.reasoning(id: uniqueReasoningId(id), text: "", streaming: true))
        case "reasoning-delta":
            guard let delta = p["delta"]?.stringValue else { return }
            if let index = message.parts.lastIndex(where: { if case .reasoning = $0 { return true } else { return false } }),
               case .reasoning(let id, let text, _) = message.parts[index] {
                message.parts[index] = .reasoning(id: id, text: text + delta, streaming: true)
            }
        case "reasoning-end":
            if let index = message.parts.lastIndex(where: { if case .reasoning = $0 { return true } else { return false } }),
               case .reasoning(let id, let text, _) = message.parts[index] {
                message.parts[index] = .reasoning(id: id, text: text, streaming: false)
            }
        case "tool-input-start":
            guard let id = p["toolCallId"]?.stringValue else { return }
            upsertTool(id) { call in
                call.name = p["toolName"]?.stringValue ?? call.name
            }
        case "tool-input-available":
            guard let id = p["toolCallId"]?.stringValue else { return }
            let name = p["toolName"]?.stringValue
            if name == "endTurn" {
                sawEndTurn = true
                endTurnIds.insert(id)
                return
            }
            upsertTool(id) { call in
                if let name { call.name = name }
                call.input = p["input"] ?? .object([:])
            }
        case "tool-output-available":
            guard let id = p["toolCallId"]?.stringValue, !endTurnIds.contains(id), !id.hasSuffix("-end-turn") else { return }
            upsertTool(id) { call in
                call.output = p["output"]
                call.state = .done
            }
        case "tool-output-error":
            guard let id = p["toolCallId"]?.stringValue else { return }
            upsertTool(id) { call in
                call.errorText = p["errorText"]?.stringValue
                call.state = .error
            }
        case "data-claude-code-subagent":
            guard let parent = p["data"]?["parentToolUseId"]?.stringValue else { return }
            let steps = Self.subagentSteps(p["data"]?["steps"])
            upsertTool(parent) { $0.subagentSteps = steps }
        case "data-claude-code-usage", "data-opencode-usage":
            if let tokens = p["data"]?["tokens"]?.intValue { usage = ContextUsage(tokens: tokens) }
        case "data-claude-code-status":
            if p["data"]?["status"]?.stringValue == "compacting" {
                usage = ContextUsage(tokens: usage?.tokens ?? 0, compacting: true)
            }
        case "data-claude-code-compact-boundary", "data-opencode-compact-boundary":
            usage = ContextUsage(tokens: 0)
        case "error":
            let text = p["errorText"]?.stringValue ?? "The agent ran into a problem."
            errorText = text
            message.parts.append(.notice(id: "err-\(message.parts.count)", text: text, isError: true))
        case "finish", "abort":
            finish()
        default:
            break
        }
    }

    mutating func finish() {
        finished = true
        message.streaming = false
        // A turn that ended leaves no tool spinning.
        for index in message.parts.indices {
            if case .tool(var call) = message.parts[index], call.state == .running {
                call.state = .done
                message.parts[index] = .tool(call)
            }
            if case .reasoning(let id, let text, true) = message.parts[index] {
                message.parts[index] = .reasoning(id: id, text: text, streaming: false)
            }
        }
    }

    private func uniqueReasoningId(_ id: String) -> String {
        "\(id)-\(message.parts.count)"
    }

    private mutating func upsertTool(_ id: String, _ update: (inout ToolCall) -> Void) {
        if let index = message.parts.firstIndex(where: { $0.id == "c:\(id)" }), case .tool(var call) = message.parts[index] {
            update(&call)
            message.parts[index] = .tool(call)
        } else {
            var call = ToolCall(id: id, name: "tool", input: .object([:]), state: .running)
            update(&call)
            message.parts.append(.tool(call))
        }
    }

    static func subagentSteps(_ value: JSONValue?) -> [SubagentStep] {
        (value?.arrayValue ?? []).enumerated().map { index, step in
            let kind = SubagentStep.Kind(rawValue: step["kind"]?.stringValue ?? "text") ?? .text
            let status = step["status"]?.stringValue
            return SubagentStep(
                id: step["toolCallId"]?.stringValue ?? "s-\(index)",
                kind: kind,
                text: step["text"]?.stringValue ?? step["output"]?.stringValue ?? "",
                toolName: step["toolName"]?.stringValue,
                input: step["input"],
                state: status == "error" ? .error : status == "running" ? .running : .done
            )
        }
    }
}

// MARK: - Stored messages

enum StoredMessage {
    /// Convert a persisted UI message (`{ id, role, parts: [...] }`) into the
    /// app's model. Unknown part types are skipped, so a newer server never
    /// breaks an older app.
    static func decode(_ raw: JSONValue) -> ChatMessage? {
        guard let id = raw["id"]?.stringValue, let role = ChatRole(rawValue: raw["role"]?.stringValue ?? "") else { return nil }
        var parts: [ChatPart] = []
        var subagents: [String: [SubagentStep]] = [:]
        let rawParts = raw["parts"]?.arrayValue ?? []
        for (index, part) in rawParts.enumerated() {
            guard let type = part["type"]?.stringValue else { continue }
            switch type {
            case "text":
                let text = part["text"]?.stringValue ?? ""
                if !text.isEmpty { parts.append(.text(id: "\(id)-\(index)", text: text)) }
            case "reasoning":
                let text = part["text"]?.stringValue ?? ""
                if !text.isEmpty { parts.append(.reasoning(id: "\(id)-\(index)", text: text, streaming: false)) }
            case "file":
                if let url = part["url"]?.stringValue {
                    parts.append(.image(ImageAttachment(url: url, mediaType: part["mediaType"]?.stringValue ?? "image/jpeg")))
                }
            case "data-claude-code-subagent":
                if let parent = part["data"]?["parentToolUseId"]?.stringValue {
                    subagents[parent] = MessageAssembler.subagentSteps(part["data"]?["steps"])
                }
            default:
                guard type.hasPrefix("tool-") || type == "dynamic-tool" else { continue }
                let name = type == "dynamic-tool" ? (part["toolName"]?.stringValue ?? "tool") : String(type.dropFirst(5))
                // The synthetic end-of-turn call, and the placeholder an older
                // build saved for it, are not steps.
                if name == "endTurn" || (name == "tool" && (part["toolCallId"]?.stringValue ?? "").hasSuffix("-end-turn")) { continue }
                let state = part["state"]?.stringValue ?? "output-available"
                parts.append(.tool(ToolCall(
                    id: part["toolCallId"]?.stringValue ?? "\(id)-\(index)",
                    name: name,
                    input: part["input"] ?? .object([:]),
                    output: part["output"],
                    errorText: part["errorText"]?.stringValue,
                    // A stored message is never still running.
                    state: state == "output-error" ? .error : .done
                )))
            }
        }
        if !subagents.isEmpty {
            parts = parts.map { part in
                if case .tool(var call) = part, let steps = subagents[call.id] {
                    call.subagentSteps = steps
                    return .tool(call)
                }
                return part
            }
        }
        return ChatMessage(
            id: id,
            role: role,
            parts: parts,
            userId: raw["userId"]?.stringValue,
            createdAt: raw["createdAt"]?.stringValue.flatMap(DateParsing.parse),
            segmentId: raw["segmentId"]?.stringValue
        )
    }

    /// An assistant message in the stored UI-message shape, for the app's own
    /// save of a finished turn (the same fallback the website performs).
    static func encodeAssistantMessage(_ message: ChatMessage) -> JSONValue {
        var parts: [JSONValue] = []
        for part in message.parts {
            switch part {
            case .text(_, let text):
                parts.append(.object(["type": .string("text"), "text": .string(text), "state": .string("done")]))
            case .reasoning(_, let text, _):
                parts.append(.object(["type": .string("reasoning"), "text": .string(text), "state": .string("done")]))
            case .tool(let call):
                var object: [String: JSONValue] = [
                    "type": .string("tool-\(call.name)"),
                    "toolCallId": .string(call.id),
                    "input": call.input,
                ]
                if call.state == .error {
                    object["state"] = .string("output-error")
                    object["errorText"] = .string(call.errorText ?? "Tool failed")
                } else {
                    object["state"] = .string("output-available")
                    object["output"] = call.output ?? .string("")
                }
                parts.append(.object(object))
                if !call.subagentSteps.isEmpty {
                    parts.append(.object([
                        "type": .string("data-claude-code-subagent"),
                        "id": .string(call.id),
                        "data": .object([
                            "parentToolUseId": .string(call.id),
                            "steps": .array(call.subagentSteps.map { step in
                                var item: [String: JSONValue] = ["kind": .string(step.kind.rawValue)]
                                if step.kind == .tool {
                                    item["toolCallId"] = .string(step.id)
                                    item["toolName"] = .string(step.toolName ?? "tool")
                                    item["input"] = step.input ?? .object([:])
                                    item["status"] = .string(step.state == .error ? "error" : "done")
                                    if !step.text.isEmpty { item["output"] = .string(step.text) }
                                } else {
                                    item["text"] = .string(step.text)
                                }
                                return .object(item)
                            }),
                        ]),
                    ]))
                }
            case .image, .notice:
                continue
            }
        }
        return .object(["id": .string(message.id), "role": .string("assistant"), "parts": .array(parts)])
    }

    /// The UI message the server expects for a new user prompt.
    static func encodeUserMessage(id: String, text: String, images: [ImageAttachment]) -> JSONValue {
        var parts: [JSONValue] = []
        if !text.isEmpty { parts.append(.object(["type": .string("text"), "text": .string(text)])) }
        for image in images {
            parts.append(.object([
                "type": .string("file"),
                "mediaType": .string(image.mediaType),
                "url": .string(image.url),
            ]))
        }
        return .object(["id": .string(id), "role": .string("user"), "parts": .array(parts)])
    }
}

enum DateParsing {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ string: String) -> Date? {
        fractional.date(from: string) ?? plain.date(from: string)
    }
}
