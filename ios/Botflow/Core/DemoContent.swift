import Foundation

enum DemoContent {
    struct Step {
        var delay: Double
        var chunk: StreamChunk
    }

    static let webFiles = [
        "convex", "convex/menu.ts", "convex/orders.ts", "convex/schema.ts",
        "index.html", "package.json",
        "src", "src/App.tsx", "src/index.css", "src/main.tsx",
        "src/components", "src/components/Cart.tsx", "src/components/Hero.tsx", "src/components/Menu.tsx",
        "vite.config.ts",
    ]

    static let swiftFiles = [
        "PocketLedger", "PocketLedger/PocketLedgerApp.swift", "PocketLedger/ContentView.swift",
        "PocketLedger/Models", "PocketLedger/Models/Transaction.swift",
        "PocketLedger/Views", "PocketLedger/Views/SpendingChart.swift", "PocketLedger/Views/TransactionRow.swift",
        "project.yml",
    ]

    static func source(for path: String) -> String {
        if path.hasSuffix(".swift") {
            return """
            import SwiftUI
            import Charts

            /// Monthly spending, one bar per category.
            struct SpendingChart: View {
                let totals: [CategoryTotal]
                @State private var selected: CategoryTotal?

                var body: some View {
                    Chart(totals) { total in
                        BarMark(
                            x: .value("Category", total.name),
                            y: .value("Spent", total.amount)
                        )
                        .foregroundStyle(by: .value("Category", total.name))
                        .cornerRadius(6)
                    }
                    .chartLegend(.hidden)
                    .frame(height: 220)
                    .padding()
                }
            }
            """
        }
        if path.hasSuffix(".json") {
            return """
            {
              "name": "tidewater-coffee",
              "private": true,
              "scripts": {
                "dev": "vite",
                "build": "tsc -b && vite build"
              },
              "dependencies": {
                "convex": "^1.31.0",
                "react": "^19.1.0"
              }
            }
            """
        }
        if path.hasSuffix(".css") {
            return """
            :root {
              --cream: #f7f1e3;
              --pine: #1f3d2b;
            }

            body {
              margin: 0;
              font-family: "Inter", system-ui, sans-serif;
              background: var(--cream);
              color: var(--pine);
            }
            """
        }
        return """
        import { useState } from "react";
        import { useQuery, useMutation } from "convex/react";
        import { api } from "../../convex/_generated/api";

        type Line = { id: string; name: string; price: number; qty: number };

        // The cart drawer: lines, totals and the checkout button.
        export function Cart({ open, onClose }: { open: boolean; onClose: () => void }) {
          const lines = useQuery(api.orders.cart) ?? [];
          const checkout = useMutation(api.orders.checkout);
          const [busy, setBusy] = useState(false);
          const total = lines.reduce((sum: number, l: Line) => sum + l.price * l.qty, 0);

          async function pay() {
            setBusy(true);
            await checkout({ tip: 0 });
            setBusy(false);
            onClose();
          }

          return (
            <aside className={open ? "cart cart--open" : "cart"}>
              <h2>Your order</h2>
              {lines.map((line: Line) => (
                <CartLine key={line.id} line={line} />
              ))}
              <button disabled={busy || total === 0} onClick={pay}>
                Pay ${total.toFixed(2)}
              </button>
            </aside>
          );
        }
        """
    }

    // MARK: Stored conversations

    private static func tool(_ id: String, _ name: String, _ input: [String: JSONValue], output: String = "ok", state: ToolState = .done) -> ChatPart {
        .tool(ToolCall(id: id, name: name, input: .object(input), output: .string(output), state: state))
    }

    static func history(for threadId: String) -> [ChatMessage] {
        switch threadId {
        case "t-order":
            return [
                ChatMessage(id: "u1", role: .user, parts: [.text(id: "u1", text: "Add online ordering: a cart drawer, quantity steppers on each menu item, and a checkout that saves the order to Convex.")], userId: "u-demo", createdAt: Date().addingTimeInterval(-90)),
            ]
        case "t-menu":
            return [
                ChatMessage(id: "u1", role: .user, parts: [.text(id: "u1", text: "Rework the homepage menu so it's easier to scan on a phone.")], userId: "u-demo"),
                ChatMessage(id: "a1", role: .assistant, parts: [
                    .text(id: "a1t", text: "I looked at the current menu section. Before I rebuild it, one choice changes the layout quite a bit."),
                    tool("c1", "read", ["file_path": .string("src/components/Menu.tsx")]),
                    .tool(ToolCall(id: "q-menu", name: "ask_question", input: .object([
                        "questions": .array([.object([
                            "id": .string("q-0"),
                            "header": .string("Menu layout"),
                            "question": .string("Which menu layout should the homepage use?"),
                            "multiSelect": .bool(false),
                            "options": .array([
                                .object(["id": .string("opt-0-0"), "label": .string("Photo cards"), "description": .string("Two columns of cards, each with a photo, name and price.")]),
                                .object(["id": .string("opt-0-1"), "label": .string("Compact list"), "description": .string("One dense list grouped by drink type. Fastest to scan.")]),
                                .object(["id": .string("opt-0-2"), "label": .string("Tabs by category"), "description": .string("Espresso, filter and seasonal as swipeable tabs.")]),
                            ]),
                        ])]),
                    ]), state: .running)),
                ]),
            ]
        case "t-onboard":
            return [
                ChatMessage(id: "u1", role: .user, parts: [.text(id: "u1", text: "Design a three-step onboarding flow: welcome, pick a currency, then set a monthly budget.")], userId: "u-demo", createdAt: Date().addingTimeInterval(-18_400)),
                ChatMessage(id: "a1", role: .assistant, parts: [
                    .text(id: "a1t", text: "I'll add the flow as three pages in a paged tab view and show it once, on first launch."),
                    tool("c1", "read", ["file_path": .string("PocketLedger/PocketLedgerApp.swift")]),
                    tool("c2", "write", ["file_path": .string("PocketLedger/Views/OnboardingFlow.swift")], output: "Wrote 142 lines"),
                    tool("c3", "edit", ["file_path": .string("PocketLedger/PocketLedgerApp.swift")], output: "Applied 2 edits"),
                    tool("c4", "startSimulator", [:], output: "Build succeeded. The app is running on iPhone."),
                    .text(id: "a1t2", text: """
                    Onboarding is in and running in the simulator:

                    1. **Welcome:** the app icon, a one-line pitch and a **Get started** button.
                    2. **Currency:** a searchable list, with your region's currency preselected.
                    3. **Budget:** a large amount field with a slider underneath for quick changes.

                    It shows only on first launch; the choice is saved with `@AppStorage`. Press play in the App tab to walk through it.
                    """),
                ], createdAt: Date().addingTimeInterval(-18_000)),
            ]
        case "t-charts":
            return [
                ChatMessage(id: "u1", role: .user, parts: [.text(id: "u1", text: "Add a monthly spending chart to the summary screen using Swift Charts, one bar per category.")], userId: "u-demo"),
            ]
        case "t-map":
            return [
                ChatMessage(id: "u1", role: .user, parts: [.text(id: "u1", text: "Show nearby trails on a map with difficulty filters.")], userId: "u-demo"),
                ChatMessage(id: "a1", role: .assistant, parts: [
                    .text(id: "a1t", text: "I added the map screen and the filter chips, but the build fails."),
                    tool("c1", "write", ["file_path": .string("Trailhead/Views/TrailMap.swift")]),
                    .tool(ToolCall(id: "c2", name: "startSimulator", input: .object([:]), errorText: "TrailMap.swift:42:17: error: value of type 'Trail' has no member 'coordinate'", state: .error)),
                    .notice(id: "n1", text: "The build failed with 1 error in TrailMap.swift. Ask me to fix it and I'll pick up from here.", isError: true),
                ]),
            ]
        case "t-hero", "t-seo", "t-shift", "t-fs", "t-sn":
            return [
                ChatMessage(id: "u1", role: .user, parts: [.text(id: "u1", text: "Build the single-page Tidewater Coffee landing site now: a hero with a pour-over photo, a short menu, opening hours and a footer.")], userId: "u-demo", createdAt: Date().addingTimeInterval(-7400)),
                ChatMessage(id: "a1", role: .assistant, parts: [
                    .reasoning(id: "r1", text: "The project is a fresh Vite starter. I'll replace App.tsx with the sections in order, set the palette as CSS variables, then check the preview for console errors.", streaming: false),
                    .text(id: "a1t", text: "I'll build the page in one pass, then check it in the preview."),
                    tool("c1", "read", ["file_path": .string("src/App.tsx")]),
                    tool("c2", "write", ["file_path": .string("src/App.tsx")], output: "Wrote 148 lines"),
                    tool("c3", "edit", ["file_path": .string("src/index.css")], output: "Applied 3 edits"),
                    tool("c4", "bash", ["command": .string("pnpm build")], output: "✓ built in 1.84s"),
                    tool("c5", "getBrowserLog", [:], output: "No errors"),
                    .text(id: "a1t2", text: """
                    The landing page is built and running in the preview. Here's what's on it:

                    - **Hero:** a full-width pour-over photo with the headline *Slow coffee by the water* and an **Order ahead** button.
                    - **Menu:** three drinks and their prices:
                      - Harbour Flat White, $4.50
                      - Slow Pour Filter, $5.00
                      - Salted Honey Latte, $5.50
                    - **Opening hours:** a cream card with hours for weekdays, Saturday and Sunday.
                    - **Footer:** a simple one with an address, an email and the copyright year.
                    - **Palette and fonts:** cream and deep green, set up as colours in `src/index.css`. Headings use Fraunces and body text uses Inter.

                    The address, email, menu items and opening hours are placeholders I made up, so swap in the real details.

                    I changed three files: `src/App.tsx`, `src/index.css`, and the title and font links in `index.html`.
                    """),
                ], createdAt: Date().addingTimeInterval(-7200)),
            ]
        default:
            // A chat created during the demo starts empty.
            return []
        }
    }

    // MARK: A scripted live turn

    static func turnScript(threadId: String, turnId: String) -> [Step] {
        var steps: [Step] = []
        func add(_ delay: Double, _ type: String, _ fields: [String: JSONValue] = [:]) {
            var payload = fields
            payload["type"] = .string(type)
            steps.append(Step(delay: delay, chunk: StreamChunk(type: type, payload: .object(payload))))
        }
        func text(_ id: String, _ content: String, pace: Double = 0.035) {
            add(0.25, "text-start", ["id": .string(id)])
            var buffer = ""
            for word in content.split(separator: " ", omittingEmptySubsequences: false) {
                buffer = String(word) + " "
                add(pace, "text-delta", ["id": .string(id), "delta": .string(buffer)])
            }
            add(0.05, "text-end", ["id": .string(id)])
        }
        func call(_ id: String, _ name: String, _ input: [String: JSONValue], output: String, work: Double) {
            add(0.3, "tool-input-start", ["toolCallId": .string(id), "toolName": .string(name)])
            add(0.1, "tool-input-available", ["toolCallId": .string(id), "toolName": .string(name), "input": .object(input)])
            add(work, "tool-output-available", ["toolCallId": .string(id), "output": .string(output)])
        }

        let swift = threadId == "t-charts"
        add(0.2, "start", ["messageId": .string(turnId.hasPrefix("turn-") ? turnId : "turn-\(turnId)")])
        add(0.0, "start-step")
        add(0.2, "reasoning-start", ["id": .string("r1")])
        add(0.4, "reasoning-delta", ["id": .string("r1"), "delta": .string(swift
            ? "The summary screen already loads transactions. I need category totals for the current month, a Chart with one BarMark per category, and a selection overlay."
            : "The menu items live in Menu.tsx and the data comes from Convex. I need a cart table, add/remove mutations, a drawer component and a checkout mutation.")])
        add(0.3, "reasoning-end", ["id": .string("r1")])
        if swift {
            text("t1", "I'll add the chart to the summary screen and build it in the simulator to check it.")
            call("c1", "read", ["file_path": .string("PocketLedger/ContentView.swift")], output: "86 lines", work: 0.9)
            call("c2", "grep", ["pattern": .string("struct Transaction")], output: "PocketLedger/Models/Transaction.swift:4", work: 0.8)
            call("c3", "write", ["file_path": .string("PocketLedger/Views/SpendingChart.swift")], output: "Wrote 64 lines", work: 1.6)
            call("c4", "edit", ["file_path": .string("PocketLedger/ContentView.swift")], output: "Applied 2 edits", work: 1.1)
            call("c5", "startSimulator", [:], output: "Build succeeded. The app is running on iPhone.", work: 3.2)
            text("t2", "The chart is in. **Summary** now opens with a bar for each category this month; tap a bar to see its total. It built cleanly and is running in the simulator, so open the App tab to try it.")
        } else {
            text("t1", "I'll add the cart in three steps: the data model, the drawer, then checkout.")
            call("c1", "read", ["file_path": .string("src/components/Menu.tsx")], output: "112 lines", work: 0.9)
            call("c2", "read", ["file_path": .string("convex/schema.ts")], output: "24 lines", work: 0.7)
            call("c3", "edit", ["file_path": .string("convex/schema.ts")], output: "Applied 1 edit", work: 1.2)
            call("c4", "write", ["file_path": .string("convex/orders.ts")], output: "Wrote 58 lines", work: 1.5)
            call("c5", "write", ["file_path": .string("src/components/Cart.tsx")], output: "Wrote 96 lines", work: 1.7)
            call("c6", "edit", ["file_path": .string("src/components/Menu.tsx")], output: "Applied 4 edits", work: 1.2)
            call("c7", "convexDeploy", [:], output: "Deployed 3 functions", work: 2.4)
            call("c8", "bash", ["command": .string("pnpm build")], output: "✓ built in 2.1s", work: 2.0)
            text("t2", "Ordering works end to end. Each menu item has a quantity stepper, the **cart drawer** slides in from the right with a running total, and **Pay** saves the order to a new `orders` table in Convex. Open the App tab to try it.")
        }
        add(0.2, "tool-input-available", ["toolCallId": .string("claude-code-end-turn"), "toolName": .string("endTurn"), "input": .object(["summary": .string("Done.")])])
        add(0.0, "finish-step")
        add(0.0, "finish", ["finishReason": .string("stop")])
        return steps
    }
}
