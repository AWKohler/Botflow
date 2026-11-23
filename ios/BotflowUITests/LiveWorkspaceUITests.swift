import XCTest

/// A real agent turn through the app, against a running Botflow server with a
/// signed-in session already in the app (run LiveSignInUITests first).
/// Skipped unless TEST_RUNNER_BOTFLOW_BASE_URL and TEST_RUNNER_BOTFLOW_LIVE_PROMPT are set.
final class LiveWorkspaceUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testAPromptBuildsAndPreviews() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let baseURL = environment["BOTFLOW_BASE_URL"], let prompt = environment["BOTFLOW_LIVE_PROMPT"] else {
            throw XCTSkip("No live server was provided.")
        }
        let app = XCUIApplication()
        app.launchArguments += ["-BotflowBaseURL", baseURL]
        app.launch()

        let field = app.textViews["build.prompt"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "Not signed in")
        field.tap()
        field.typeText(prompt)
        app.buttons["build.send"].tap()

        // The first prompt asks for notification permission.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 20) { allow.tap() }

        // The workspace opens and the agent starts: Stop is offered while it works.
        XCTAssertTrue(app.buttons["composer.stop"].waitForExistence(timeout: 180), "The agent did not start")
        // ...and Send returns when the turn is over.
        XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 420), "The turn did not finish")

        // The Preview pane shows the running app (already beside the chat on an iPad).
        let preview = app.buttons["Preview"].firstMatch
        if preview.exists { preview.tap() }
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 240), "The preview did not load")
        sleep(6)
    }

    /// A follow-up in an existing project (TEST_RUNNER_BOTFLOW_LIVE_PROJECT): the
    /// reply streams in and is still there once the turn is over.
    func testAFollowUpStreamsAndStays() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let baseURL = environment["BOTFLOW_BASE_URL"], let project = environment["BOTFLOW_LIVE_PROJECT"],
              let prompt = environment["BOTFLOW_LIVE_PROMPT"] else {
            throw XCTSkip("No live project was provided.")
        }
        let app = XCUIApplication()
        app.launchArguments += ["-BotflowBaseURL", baseURL, "-BotflowOpenProject", project]
        app.launch()

        let input = app.textFields["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 60), "The workspace did not open")
        input.tap()
        input.typeText(prompt)
        app.buttons["composer.send"].tap()

        XCTAssertTrue(app.buttons["composer.stop"].waitForExistence(timeout: 180), "The agent did not start")
        XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 420), "The turn did not finish")
        // The agent's steps are still on screen after the turn ends.
        sleep(8)
        let steps = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Read' OR label BEGINSWITH 'Edited' OR label BEGINSWITH 'Wrote' OR label BEGINSWITH 'Ran' OR label CONTAINS 'steps'"))
        XCTAssertGreaterThan(steps.count, 0, "The reply disappeared after the turn ended")
    }

    /// The cloud simulator for a Swift project (TEST_RUNNER_BOTFLOW_LIVE_SWIFT_PROJECT):
    /// press play, wait for live video, then touch it.
    func testTheSimulatorStreamsAndTakesTouches() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let baseURL = environment["BOTFLOW_BASE_URL"], let project = environment["BOTFLOW_LIVE_SWIFT_PROJECT"] else {
            throw XCTSkip("No live Swift project was provided.")
        }
        let app = XCUIApplication()
        app.launchArguments += ["-BotflowBaseURL", baseURL, "-BotflowOpenProject", project, "-BotflowOpenApp", "YES"]
        app.launch()

        let play = app.buttons["simulator.play"]
        XCTAssertTrue(play.waitForExistence(timeout: 90), "The simulator view did not appear")
        play.tap()

        let fullScreen = app.buttons["simulator.fullscreen"]
        XCTAssertTrue(fullScreen.waitForExistence(timeout: 360), "The simulator did not go live")
        sleep(6)

        // Touch the middle of the screen, then swipe up, as a person would.
        let surface = app.windows.firstMatch
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)).tap()
        sleep(3)
        let from = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        let to = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
        from.press(forDuration: 0.05, thenDragTo: to)
        sleep(4)

        // Full screen and back.
        fullScreen.tap()
        sleep(5)
        app.buttons["simulator.exitFullscreen"].tap()
        XCTAssertTrue(fullScreen.waitForExistence(timeout: 10))
        sleep(2)
    }
}
