import XCTest

/// A notification about an agent, tapped from outside the app, opens that
/// agent's chat. The notification itself is sent from the Mac while this test
/// waits: `xcrun simctl push <device> io.botflow.app payload.json`.
/// Skipped unless TEST_RUNNER_BOTFLOW_EXPECT_PUSH is set.
final class PushUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testTappingAnAgentNotificationOpensItsChat() throws {
        guard ProcessInfo.processInfo.environment["BOTFLOW_EXPECT_PUSH"] != nil else {
            throw XCTSkip("No notification is being sent.")
        }
        let app = XCUIApplication()
        app.launchArguments += ["-BotflowDemo", "-BotflowRequestPush", "YES"]
        app.launch()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 15) { allow.tap() }
        XCTAssertTrue(app.textViews["build.prompt"].waitForExistence(timeout: 30))

        // Leave the app, as someone would after starting an agent.
        XCUIDevice.shared.press(.home)

        let banner = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] 'the agent finished'")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 150), "No notification arrived")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "notification-banner"
        shot.lifetime = .keepAlways
        add(shot)
        banner.tap()

        // The app comes back on that agent's chat.
        XCTAssertTrue(app.textFields["composer.input"].waitForExistence(timeout: 30), "The chat did not open")
        let title = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Add online ordering'")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10), "A different chat opened")
        let opened = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        opened.name = "opened-from-notification"
        opened.lifetime = .keepAlways
        add(opened)
    }
}
