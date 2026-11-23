import XCTest

/// Signs in through the real browser sheet against a running Botflow server.
/// Skipped unless the runner is given an account:
///
///   TEST_RUNNER_BOTFLOW_BASE_URL=http://localhost:3003 \
///   TEST_RUNNER_BOTFLOW_LIVE_EMAIL=… TEST_RUNNER_BOTFLOW_LIVE_PASSWORD=… \
///   xcodebuild test -only-testing:BotflowUITests/LiveSignInUITests …
final class LiveSignInUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSignInThroughTheBrowserSheet() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let email = environment["BOTFLOW_LIVE_EMAIL"], let password = environment["BOTFLOW_LIVE_PASSWORD"],
              let baseURL = environment["BOTFLOW_BASE_URL"] else {
            throw XCTSkip("No live account was provided.")
        }

        let app = XCUIApplication()
        app.launchArguments += ["-BotflowBaseURL", baseURL]
        app.launch()

        // Already signed in from an earlier run: nothing to do.
        if app.textViews["build.prompt"].waitForExistence(timeout: 8) { return }

        let signIn = app.buttons["onboarding.signIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20))
        signIn.tap()

        // iOS asks before an app opens a sign-in page.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Continue"]
        if allow.waitForExistence(timeout: 10) { allow.tap() }

        // The sheet's web content belongs to the system's Safari service.
        let browser = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        func web(_ query: (XCUIApplication) -> XCUIElement) -> XCUIElement {
            let inService = query(browser)
            if inService.waitForExistence(timeout: 25) { return inService }
            return query(app)
        }

        let emailField = web { $0.webViews.textFields.firstMatch }
        XCTAssertTrue(emailField.waitForExistence(timeout: 40), "The sign-in page did not load")
        emailField.tap()
        // Return submits the step; the keyboard covers the page's own button.
        emailField.typeText(email + "\n")

        let passwordField = web { $0.webViews.secureTextFields.firstMatch }
        XCTAssertTrue(passwordField.waitForExistence(timeout: 30), "The password step did not appear")
        passwordField.tap()
        passwordField.typeText(password + "\n")

        // The consent page: "Continue as <name>".
        let approve = web { $0.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue as'")).firstMatch }
        XCTAssertTrue(approve.waitForExistence(timeout: 60), "The app consent page did not appear")
        approve.tap()

        XCTAssertTrue(app.textViews["build.prompt"].waitForExistence(timeout: 40), "The app did not finish signing in")
    }
}
