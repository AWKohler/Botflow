import XCTest
@testable import Botflow

final class H264Tests: XCTestCase {
    func testSplitsOnShortAndLongStartCodes() {
        let data = Data([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 6])
        let units = H264Decoder.nalUnits(in: data)
        XCTAssertEqual(units.count, 3)
        XCTAssertEqual(Array(units[0]), [0x67, 1, 2])
        XCTAssertEqual(Array(units[1]), [0x68, 3])
        XCTAssertEqual(Array(units[2]), [0x65, 4, 5, 6])
    }

    func testNoStartCodeMeansNoUnits() {
        XCTAssertTrue(H264Decoder.nalUnits(in: Data([1, 2, 3, 4])).isEmpty)
    }

    func testNothingIsShownBeforeParameterSets() {
        let decoder = H264Decoder()
        XCTAssertNil(decoder.sampleBuffer(from: Data([0, 0, 0, 1, 0x41, 9, 9]), keyframe: false))
    }
}

final class MarkdownTests: XCTestCase {
    func testBlocks() {
        let blocks = MarkdownParser.parse("""
        # Title

        A paragraph with **bold**.

        - one
          - nested
        - two

        1. first
        2. second

        ```swift
        let x = 1
        ```

        > quoted

        ---

        | A | B |
        |---|---|
        | 1 | 2 |
        """)
        XCTAssertEqual(blocks.count, 8)
        XCTAssertEqual(blocks[0], .heading(level: 1, text: "Title"))
        XCTAssertEqual(blocks[1], .paragraph("A paragraph with **bold**."))
        if case .list(let items) = blocks[2] {
            XCTAssertEqual(items.map(\.text), ["one", "nested", "two"])
            XCTAssertEqual(items.map(\.level), [0, 1, 0])
        } else { XCTFail("expected a list") }
        if case .list(let items) = blocks[3] { XCTAssertEqual(items.map(\.marker), ["1.", "2."]) } else { XCTFail("expected a numbered list") }
        XCTAssertEqual(blocks[4], .code(language: "swift", text: "let x = 1"))
        XCTAssertEqual(blocks[5], .quote("quoted"))
        XCTAssertEqual(blocks[6], .rule)
        XCTAssertEqual(blocks[7], .table(header: ["A", "B"], rows: [["1", "2"]]))
    }

    func testAnUnclosedFenceStillRenders() {
        // Mid-stream, a code block has no closing fence yet.
        XCTAssertEqual(MarkdownParser.parse("```ts\nconst a = 1"), [.code(language: "ts", text: "const a = 1")])
    }
}

final class ModelAccessTests: XCTestCase {
    private func access(_ id: String, _ connections: Connections = Connections(), _ tier: Tier = .free) -> ModelAccess {
        ModelAccess.evaluate(ModelCatalog.model(id), connections: connections, tier: tier)
    }

    func testFreeModelsRunOnCredits() {
        XCTAssertEqual(access("gpt-6-luna").source, .planCredits)
    }

    func testClaudeNeedsACredentialOnFree() {
        XCTAssertFalse(access("claude-sonnet-5-5").runnable)
        XCTAssertEqual(access("claude-sonnet-5-5", Connections(hasClaudeOAuth: true)).source, .claudeSubscription)
        XCTAssertEqual(access("claude-sonnet-5-5", Connections(hasAnthropicKey: true)).source, .claudeKey)
        XCTAssertEqual(access("claude-sonnet-5-5", Connections(), .pro).source, .planCredits)
    }

    func testMaxOnlyModelsAreLockedOnPro() {
        XCTAssertFalse(access("claude-fable-5-1", Connections(), .pro).runnable)
        XCTAssertTrue(access("claude-fable-5-1", Connections(), .max).runnable)
        // A personal credential unlocks it on any plan.
        XCTAssertTrue(access("gpt-6-astra", Connections(hasCodexOAuth: true), .free).runnable)
    }

    func testOwnKeysBeatTheTierGate() {
        XCTAssertEqual(access("gemini-3.1-pro-preview", Connections(hasGoogleKey: true)).source, .ownKey)
        XCTAssertFalse(access("gemini-3.1-pro-preview").runnable)
    }

    func testUnknownAndRenamedModelsResolve() {
        XCTAssertEqual(ModelCatalog.model("no-such-model").id, ModelCatalog.defaultId)
        XCTAssertEqual(ModelCatalog.model("claude-opus-5").id, "claude-opus-5-5")
    }
}

final class PlanTests: XCTestCase {
    func testAppPricesAreTheWebPricesPlusThirtyPercent() {
        let pro = PlanOffer.offer(for: .pro), max = PlanOffer.offer(for: .max)
        XCTAssertEqual(pro.price(.monthly), Decimal(string: "26"))
        XCTAssertEqual(pro.price(.yearly), Decimal(string: "265.2"))
        XCTAssertEqual(max.price(.monthly), Decimal(string: "78"))
        XCTAssertEqual(max.price(.yearly), Decimal(string: "780"))
    }

    func testProductIds() {
        XCTAssertEqual(PlanOffer.offer(for: .pro).productId(.yearly), "io.botflow.pro.yearly")
        XCTAssertNil(PlanOffer.offer(for: .free).productId(.monthly))
        XCTAssertEqual(Set(StoreManager.productIds).count, 4)
    }

    /// The same value `appAccountTokenFor("user_abc")` gives on the server.
    func testAccountTokenMatchesTheServer() {
        XCTAssertEqual(StoreManager.appAccountToken(userId: "user_abc")?.uuidString.lowercased(), "4815155e-12b5-5da2-9210-f893594485dd")
    }
}

final class PresentationTests: XCTestCase {
    func testToolNamesReadAsSentences() {
        XCTAssertEqual(ToolPresentation.info(for: "Read").verb, "Reading")
        XCTAssertEqual(ToolPresentation.info(for: "mcp__botflow__refreshDeployStatus").verb, "Refresh deploy status")
    }

    func testToolDetailPrefersThePath() {
        let call = ToolCall(id: "c", name: "edit", input: .object(["file_path": .string("/vercel/sandbox/src/components/ui/Cart.tsx")]), state: .done)
        XCTAssertEqual(ToolSummary.detail(for: call), "…/ui/Cart.tsx")
    }

    func testQuestionsParse() {
        let input: JSONValue = .object(["questions": .array([.object([
            "question": .string("Which layout?"),
            "options": .array([.object(["label": .string("Cards")]), .object(["label": .string("List"), "description": .string("Dense")])]),
        ])])])
        let questions = AgentQuestion.parse(input)
        XCTAssertEqual(questions.first?.id, "q-0")
        XCTAssertEqual(questions.first?.options.map(\.id), ["opt-0-0", "opt-0-1"])
    }

    func testDatesWithAndWithoutFractions() {
        XCTAssertNotNil(DateParsing.parse("2026-11-22T12:00:00.123Z"))
        XCTAssertNotNil(DateParsing.parse("2026-11-22T12:00:00Z"))
    }
}

final class ToolDetailTests: XCTestCase {
    func testAPatchIsDescribedByItsFile() {
        let call = ToolCall(id: "c", name: "apply_patch", input: .object(["patchText": .string("*** Begin Patch\n*** Update File: /vercel/sandbox/src/App.tsx\n@@\n-a\n+b\n*** End Patch")]), state: .done)
        XCTAssertEqual(ToolSummary.detail(for: call), "src/App.tsx")
        XCTAssertEqual(ToolPresentation.info(for: call.name).verb, "Editing")
    }
}

final class WorkspaceLayoutTests: XCTestCase {
    func testPhonesShowOnePane() {
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 402, height: 874), hinge: nil), .single)
        // The Duo's cover screen, folded shut.
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 466, height: 678), hinge: .closed), .single)
    }

    func testAPhoneOnItsSideStillShowsOnePane() {
        // Wide enough for two panes, far too short for them once the keyboard is up.
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 874, height: 402), hinge: nil), .single)
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 956, height: 440), hinge: nil), .single)
        // An iPad on its side has the height.
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 1210, height: 834), hinge: nil), .sideBySide)
    }

    func testAnOpenDuoAndAnIPadShowTwoPanes() {
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 669, height: 951), hinge: .fullyOpen), .sideBySide)
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 834, height: 1210), hinge: nil), .sideBySide)
    }

    func testAHalfOpenDuoPutsAPaneEachSideOfTheFold() {
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 669, height: 951), hinge: .partiallyOpen), .halves)
        XCTAssertEqual(WorkspaceLayout.choose(size: CGSize(width: 951, height: 669), hinge: .partiallyOpen), .stacked)
    }
}
