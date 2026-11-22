import XCTest

final class PlaceholderUITests: XCTestCase {
    func testLaunches() {
        let app = XCUIApplication()
        app.launchArguments += ["-BotflowDemo"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
    }
}
