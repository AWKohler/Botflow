import XCTest

/// The main flows against fixture data: no network, same on every run.
final class DemoUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-BotflowDemo"]
        // A system alert left up by something else (an Apple Account prompt,
        // say) would sit on top of every screen: clear it first.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let notNow = springboard.buttons["Not Now"]
        if notNow.exists { notNow.tap() }
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
        // Send lights up once the text has landed; on a busy machine that lags the typing.
        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        let ready = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: send)
        wait(for: [ready], timeout: 20)
        send.tap()

        // A first send on a fresh install asks for notification permission.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }

        // The agent starts; the send button becomes Stop while it works.
        let stop = app.buttons["composer.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 30))
        // The prompt shows as the person's own bubble ("You: …" to VoiceOver).
        let bubble = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Add a tip selector to checkout'")).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 5))
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
        let heading = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] 'Working now'")).firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 15))
        app.buttons["threads.new"].tap()
        XCTAssertTrue(app.staticTexts["What should we build?"].waitForExistence(timeout: 10))
    }

    func testTheSimulatorStartsFromThePlayButton() {
        launch(route: "workspace-swift")
        let play = app.buttons["simulator.play"]
        XCTAssertTrue(play.waitForExistence(timeout: 20))
        play.tap()
        let fullScreen = app.buttons["simulator.fullscreen"]
        XCTAssertTrue(fullScreen.waitForExistence(timeout: 20), "The simulator did not go live")

        // Full screen takes over the whole window, and its control brings you back.
        fullScreen.tap()
        let exit = app.buttons["simulator.exitFullscreen"]
        XCTAssertTrue(exit.waitForExistence(timeout: 10), "Full screen did not open")
        exit.tap()
        XCTAssertTrue(fullScreen.waitForExistence(timeout: 10), "Full screen did not close")
    }

    /// On one-pane layouts the workspace switches between chat, the app and the code.
    func testAOnePaneWorkspaceSwitchesBetweenChatAppAndCode() throws {
        launch(route: "workspace")
        XCTAssertTrue(app.textFields["composer.input"].waitForExistence(timeout: 20))
        let code = app.buttons["Code"].firstMatch
        try XCTSkipUnless(app.buttons["Chat"].firstMatch.exists && code.exists, "This device shows chat and the app side by side.")
        app.buttons["Preview"].firstMatch.tap()
        XCTAssertTrue(app.buttons["workspace.publish"].firstMatch.waitForExistence(timeout: 10))
        code.tap()
        XCTAssertTrue(app.staticTexts["src"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["Chat"].firstMatch.tap()
        XCTAssertTrue(app.textFields["composer.input"].waitForExistence(timeout: 10))
    }

    /// A question from the agent takes over the composer until it is answered.
    func testAQuestionReplacesTheComposer() {
        launch(route: "workspace-question")
        let question = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Which menu layout'")).firstMatch
        XCTAssertTrue(question.waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["composer.send"].exists, "The composer competes with the question")
    }

    func testPaywallShowsThePlansAtAppPrices() {
        launch(route: "paywall")
        XCTAssertTrue(app.staticTexts["Build more with Botflow"].waitForExistence(timeout: 20))
        // Web price plus 30%: $20 → $26, $60 → $78.
        // "$26" from the built-in price, "$26.00" when the App Store supplies it.
        let pro = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '$26'")).firstMatch
        XCTAssertTrue(pro.waitForExistence(timeout: 10))
        // The demo account is already on Pro, so the offer is the step up.
        XCTAssertTrue(app.buttons["paywall.buy.max"].exists)
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
