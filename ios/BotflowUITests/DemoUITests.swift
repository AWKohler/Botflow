import XCTest

/// The main flows against fixture data: no network, same on every run.
final class DemoUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-BotflowDemo"]
    }

    private func launch(route: String? = nil) {
        if let route { app.launchArguments += ["-BotflowDemoRoute", route] }
        app.launch()
    }

    /// A tab by name, wherever this device puts it (tab bar or sidebar).
    private func openTab(_ name: String) {
        let inBar = app.tabBars.buttons[name]
        if inBar.waitForExistence(timeout: 5) {
            inBar.tap()
        } else {
            app.buttons[name].firstMatch.tap()
        }
    }

    func testSignedOutShowsBothWaysIn() {
        app.launchArguments += ["-BotflowDemoSignedOut"]
        app.launch()
        XCTAssertTrue(app.buttons["onboarding.signUp"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["onboarding.signIn"].exists)
    }

    func testTabsShowTheirContent() {
        launch()
        XCTAssertTrue(app.textViews["build.prompt"].waitForExistence(timeout: 20))
        openTab("Projects")
        XCTAssertTrue(app.staticTexts["Tidewater Coffee"].waitForExistence(timeout: 10))
        openTab("Agents")
        XCTAssertTrue(app.staticTexts["Working"].firstMatch.waitForExistence(timeout: 10))
        openTab("Explore")
        XCTAssertTrue(app.staticTexts["Pixelblast"].waitForExistence(timeout: 10))
    }

    func testSendingAPromptStreamsAReplyAndCanBeStopped() {
        launch(route: "workspace")
        let input = app.textFields["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 20))
        input.tap()
        input.typeText("Add a tip selector to checkout")
        app.buttons["composer.send"].tap()

        // The agent starts; the send button becomes Stop while it works.
        let stop = app.buttons["composer.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Add a tip selector to checkout"].waitForExistence(timeout: 5))
        stop.tap()
        XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 10))
    }

    func testAnAgentsReplyArrivesInFull() {
        launch(route: "workspace-live")
        // The scripted turn ends with this sentence.
        let closing = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Ordering works end to end'")).firstMatch
        XCTAssertTrue(closing.waitForExistence(timeout: 60))
    }

    func testThreadsCanBeListedAndCreated() {
        launch(route: "workspace")
        let threads = app.buttons["workspace.threads"]
        XCTAssertTrue(threads.waitForExistence(timeout: 20))
        threads.tap()
        XCTAssertTrue(app.staticTexts["Working now"].waitForExistence(timeout: 10))
        app.buttons["threads.new"].tap()
        XCTAssertTrue(app.staticTexts["What should we build?"].waitForExistence(timeout: 10))
    }

    func testTheSimulatorStartsFromThePlayButton() {
        launch(route: "workspace-swift")
        let play = app.buttons["simulator.play"]
        XCTAssertTrue(play.waitForExistence(timeout: 20))
        play.tap()
        XCTAssertTrue(app.buttons["simulator.fullscreen"].waitForExistence(timeout: 20), "The simulator did not go live")
    }

    func testPaywallShowsThePlansAtAppPrices() {
        launch(route: "paywall")
        XCTAssertTrue(app.staticTexts["Build more with Botflow"].waitForExistence(timeout: 20))
        // Web price plus 30%: $20 → $26, $60 → $78.
        XCTAssertTrue(app.staticTexts["$26"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["$78"].exists || app.scrollViews.firstMatch.exists)
        XCTAssertTrue(app.buttons["paywall.buy.pro"].exists)
    }

    func testSettingsOffersSignOut() {
        launch(route: "settings")
        XCTAssertTrue(app.staticTexts["Sam Rivera"].waitForExistence(timeout: 20))
        let signOut = app.buttons["settings.signOut"]
        app.swipeUp()
        app.swipeUp()
        XCTAssertTrue(signOut.waitForExistence(timeout: 10))
    }
}
