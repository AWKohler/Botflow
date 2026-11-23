import XCTest

/// The agent's Live Activity outside the app: in the Dynamic Island while
/// another app is in front, expanded, and on the Lock Screen. Each step leaves
/// a screenshot. Skipped unless TEST_RUNNER_BOTFLOW_ISLAND is set.
final class LiveActivityUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testARunningAgentShowsInTheIslandAndOnTheLockScreen() throws {
        guard ProcessInfo.processInfo.environment["BOTFLOW_ISLAND"] != nil else {
            throw XCTSkip("Live Activity screenshots were not asked for.")
        }
        let app = XCUIApplication()
        app.launchArguments += ["-BotflowDemo", "-BotflowDemoRoute", "workspace-live", "-BotflowDemoPace", "4"]
        app.launch()
        XCTAssertTrue(app.buttons["composer.stop"].waitForExistence(timeout: 30), "The agent is not running")
        sleep(3)

        // Leave for another app: the agent's steps keep arriving in the island.
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.launch()
        sleep(4)
        keep("1-island-compact")
        sleep(3)
        keep("2-island-compact-later")

        // Touch and hold the island to open it.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.035)).press(forDuration: 1.2)
        sleep(1)
        keep("3-island-expanded")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).tap()
        sleep(1)

        // Tapping the island returns to the agent's chat.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.035)).tap()
        XCTAssertTrue(app.textFields["composer.input"].waitForExistence(timeout: 15), "Tapping the island did not open the chat")
        keep("4-back-in-the-chat")

        // Lock the phone while it works: the Lock Screen carries the same activity.
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(2)
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(3)
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap(); sleep(1) }
        keep("5-lock-screen-working")

        // Stay locked until the agent is done: the activity turns into the result.
        sleep(60)
        keep("6-lock-screen-finished")
    }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
