import XCTest
@testable import Botflow

final class MessageStreamTests: XCTestCase {
    private func chunk(_ type: String, _ fields: [String: JSONValue] = [:]) -> StreamChunk {
        var payload = fields
        payload["type"] = .string(type)
        return StreamChunk(type: type, payload: .object(payload))
    }

    func testParsesAServerSentLine() {
        let parsed = StreamChunk(line: #"{"type":"text-delta","id":"t1","delta":"Hello"}"#)
        XCTAssertEqual(parsed?.type, "text-delta")
        XCTAssertEqual(parsed?.payload["delta"]?.stringValue, "Hello")
        XCTAssertNil(StreamChunk(line: "not json"))
    }

    func testAssemblesTextToolsAndFinish() {
        var assembler = MessageAssembler(messageId: "turn-live")
        assembler.apply(chunk("start", ["messageId": .string("turn-abc")]))
        assembler.apply(chunk("text-start", ["id": .string("t1")]))
        assembler.apply(chunk("text-delta", ["id": .string("t1"), "delta": .string("I'll add ")]))
        assembler.apply(chunk("text-delta", ["id": .string("t1"), "delta": .string("the cart.")]))
        assembler.apply(chunk("text-end", ["id": .string("t1")]))
        assembler.apply(chunk("tool-input-start", ["toolCallId": .string("c1"), "toolName": .string("read")]))
        assembler.apply(chunk("tool-input-available", ["toolCallId": .string("c1"), "toolName": .string("read"), "input": .object(["file_path": .string("src/App.tsx")])]))

        XCTAssertEqual(assembler.message.id, "turn-abc")
        XCTAssertTrue(assembler.message.streaming)
        XCTAssertEqual(assembler.message.plainText, "I'll add the cart.")
        XCTAssertEqual(assembler.message.toolCalls.first?.state, .running)

        assembler.apply(chunk("tool-output-available", ["toolCallId": .string("c1"), "output": .string("112 lines")]))
        XCTAssertEqual(assembler.message.toolCalls.first?.state, .done)
        XCTAssertEqual(assembler.message.toolCalls.first?.output?.displayText, "112 lines")

        assembler.apply(chunk("tool-input-available", ["toolCallId": .string("claude-code-end-turn"), "toolName": .string("endTurn"), "input": .object([:])]))
        assembler.apply(chunk("finish", ["finishReason": .string("stop")]))
        XCTAssertTrue(assembler.finished)
        XCTAssertTrue(assembler.sawEndTurn)
        XCTAssertFalse(assembler.message.streaming)
        // The synthetic end-of-turn call is never shown as a step.
        XCTAssertEqual(assembler.message.toolCalls.count, 1)
    }

    func testAFailedToolAndAStreamErrorAreKept() {
        var assembler = MessageAssembler(messageId: "m")
        assembler.apply(chunk("tool-input-available", ["toolCallId": .string("c1"), "toolName": .string("bash"), "input": .object(["command": .string("pnpm build")])]))
        assembler.apply(chunk("tool-output-error", ["toolCallId": .string("c1"), "errorText": .string("exit 1")]))
        assembler.apply(chunk("error", ["errorText": .string("Rate limit reached")]))
        XCTAssertEqual(assembler.message.toolCalls.first?.state, .error)
        XCTAssertEqual(assembler.errorText, "Rate limit reached")
    }

    func testFinishingLeavesNoStepSpinning() {
        var assembler = MessageAssembler(messageId: "m")
        assembler.apply(chunk("tool-input-available", ["toolCallId": .string("c1"), "toolName": .string("write"), "input": .object([:])]))
        assembler.apply(chunk("reasoning-start", ["id": .string("r1")]))
        assembler.finish()
        XCTAssertEqual(assembler.message.toolCalls.first?.state, .done)
        if case .reasoning(_, _, let streaming)? = assembler.message.parts.last { XCTAssertFalse(streaming) } else { XCTFail("expected reasoning") }
    }

    func testSubagentStepsAttachToTheirTask() {
        var assembler = MessageAssembler(messageId: "m")
        assembler.apply(chunk("tool-input-available", ["toolCallId": .string("task1"), "toolName": .string("task"), "input": .object(["description": .string("Audit the routes")])]))
        assembler.apply(chunk("data-claude-code-subagent", ["id": .string("task1"), "data": .object([
            "parentToolUseId": .string("task1"),
            "steps": .array([.object(["kind": .string("tool"), "toolCallId": .string("s1"), "toolName": .string("grep"), "status": .string("running")])]),
        ])]))
        XCTAssertEqual(assembler.message.toolCalls.first?.subagentSteps.first?.toolName, "grep")
    }

    func testUsageAndCompaction() {
        var assembler = MessageAssembler(messageId: "m")
        assembler.apply(chunk("data-claude-code-usage", ["data": .object(["tokens": .number(7700)])]))
        XCTAssertEqual(assembler.usage?.tokens, 7700)
        assembler.apply(chunk("data-claude-code-status", ["data": .object(["status": .string("compacting")])]))
        XCTAssertEqual(assembler.usage?.compacting, true)
    }

    func testDecodesAStoredMessage() throws {
        let json = #"""
        {"id":"turn-1","role":"assistant","createdAt":"2026-11-22T12:00:00.123Z","parts":[
          {"type":"step-start"},
          {"type":"reasoning","text":"Plan it."},
          {"type":"text","text":"Done."},
          {"type":"tool-edit","toolCallId":"c1","state":"output-available","input":{"file_path":"a.ts"},"output":"ok"},
          {"type":"tool-bash","toolCallId":"c2","state":"output-error","input":{"command":"x"},"errorText":"boom"},
          {"type":"tool-endTurn","toolCallId":"claude-code-end-turn","state":"output-available","input":{}},
          {"type":"file","mediaType":"image/png","url":"https://example.com/a.png"},
          {"type":"something-new","value":1}
        ]}
        """#
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let message = try XCTUnwrap(StoredMessage.decode(raw))
        XCTAssertEqual(message.role, .assistant)
        XCTAssertEqual(message.plainText, "Done.")
        XCTAssertEqual(message.toolCalls.map(\.name), ["edit", "bash"])
        XCTAssertEqual(message.toolCalls.last?.state, .error)
        XCTAssertNotNil(message.createdAt)
        XCTAssertEqual(message.parts.count, 5)
    }

    func testEncodesAUserMessageTheServerAccepts() {
        let message = StoredMessage.encodeUserMessage(id: "m1", text: "Hi", images: [ImageAttachment(url: "https://x/y.jpg", mediaType: "image/jpeg")])
        XCTAssertEqual(message["role"]?.stringValue, "user")
        XCTAssertEqual(message["parts"]?[0]?["type"]?.stringValue, "text")
        XCTAssertEqual(message["parts"]?[1]?["mediaType"]?.stringValue, "image/jpeg")
    }

    func testTurnSummaryIsPlainAndShort() {
        let message = ChatMessage(id: "m", role: .assistant, parts: [
            .text(id: "a", text: "First."),
            .text(id: "b", text: "The **cart** is in `src/Cart.tsx`.\n\nOpen the App tab."),
        ])
        XCTAssertEqual(ThreadSession.summary(of: message), "The cart is in src/Cart.tsx. Open the App tab.")
    }
}
