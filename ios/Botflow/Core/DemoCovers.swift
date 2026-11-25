import SwiftUI

/// Miniature app screens for the demo projects' covers, standing in for the
/// preview screenshots real projects have.
enum DemoCovers {
    static func has(_ id: String) -> Bool { kind(for: id) != nil }

    private enum Kind { case coffee, ledger, schedule, trail, dashboard, notes, studio, habits, tides, kanban, invoices }

    private static func kind(for id: String) -> Kind? {
        switch id {
        case "p-tidewater": return .coffee
        case "p-ledger": return .ledger
        case "p-harbor", "x1": return .schedule
        case "p-trail": return .trail
        case "p-flowsync": return .dashboard
        case "p-studio": return .notes
        case "x2": return .studio
        case "x3": return .habits
        case "x4": return .invoices
        case "x5": return .tides
        case "x6": return .kanban
        default: return nil
        }
    }

    /// The mock at its natural size (a phone or a desktop page), scaled to the
    /// cover's width and pinned to its top edge, as a screenshot would be.
    @ViewBuilder
    static func view(for id: String, in size: CGSize) -> some View {
        if let kind = kind(for: id) {
            let phone = [.ledger, .trail, .habits, .tides].contains(kind)
            let natural = phone ? CGSize(width: 390, height: 780) : CGSize(width: 760, height: 520)
            let scale = phone ? min(size.width * 0.46, size.height * 0.62) / natural.width : size.width / natural.width
            ZStack(alignment: phone ? .bottom : .top) {
                if phone { backdrop(kind) }
                page(kind)
                    .frame(width: natural.width, height: natural.height)
                    .clipShape(RoundedRectangle(cornerRadius: phone ? 44 : 0, style: .continuous))
                    .overlay {
                        if phone { RoundedRectangle(cornerRadius: 44, style: .continuous).strokeBorder(.black.opacity(0.85), lineWidth: 9) }
                    }
                    .scaleEffect(scale, anchor: phone ? .bottom : .top)
                    .frame(width: natural.width * scale, height: natural.height * scale, alignment: phone ? .bottom : .top)
                    .offset(y: phone ? natural.height * scale * 0.36 : 0)
                    .shadow(color: .black.opacity(phone ? 0.18 : 0), radius: 12, y: 6)
            }
            .frame(width: size.width, height: size.height, alignment: phone ? .bottom : .top)
            .clipped()
            .environment(\.colorScheme, .light)
        }
    }

    private static func backdrop(_ kind: Kind) -> some View {
        let colors: [Color]
        switch kind {
        case .ledger: colors = [Color(hex: 0xe6ecfb), Color(hex: 0xc9d6f7)]
        case .trail: colors = [Color(hex: 0xe2ecdf), Color(hex: 0xc3d8bd)]
        case .habits: colors = [Color(hex: 0xfbe9d7), Color(hex: 0xf3cfa9)]
        default: colors = [Color(hex: 0xdcecf2), Color(hex: 0xb6d6e2)]
        }
        return LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    @ViewBuilder
    private static func page(_ kind: Kind) -> some View {
        switch kind {
        case .coffee: DemoWebPage()
        case .ledger: DemoAppScreen()
        case .schedule: SchedulePage()
        case .trail: ListPhone(title: "Nearby trails", tint: Color(hex: 0x2f6b3c), rows: [("Cedar Ridge Loop", "4.2 km · Easy"), ("Falcon Point", "9.8 km · Hard"), ("Mill Creek", "6.1 km · Moderate"), ("Summit Spur", "3.4 km · Hard")], map: true)
        case .habits: ListPhone(title: "Today", tint: Color(hex: 0xd9730d), rows: [("Morning walk", "12 day streak"), ("Read 20 pages", "5 day streak"), ("No sugar", "3 day streak"), ("Stretch", "Start today")], map: false)
        case .tides: ListPhone(title: "Tide times", tint: Color(hex: 0x1f6f8b), rows: [("High", "06:42 · 3.1 m"), ("Low", "12:58 · 0.6 m"), ("High", "19:07 · 2.9 m"), ("Swell", "1.4 m · 11 s")], map: true)
        case .dashboard: DashboardPage(title: "Flowsync", accent: Color(hex: 0x1d52f1))
        case .invoices: DashboardPage(title: "Ledgerline", accent: Color(hex: 0x17773a))
        case .notes: NotesPage()
        case .studio: StudioPage()
        case .kanban: KanbanPage()
        }
    }
}

private struct SchedulePage: View {
    private let crew = ["Mina", "Leo", "Priya", "Jonas", "Ada"]
    private let blocks: [[(Int, Int, UInt32)]] = [
        [(0, 3, 0x1d52f1), (4, 2, 0xd98a0b)], [(1, 4, 0x1f9d4d)], [(0, 2, 0xd98a0b), (3, 3, 0x1d52f1)], [(2, 4, 0x6a4ba3)], [(0, 5, 0x1f9d4d)],
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Harbor").font(.system(size: 26, weight: .bold))
                Spacer()
                Text("Week 47").font(.system(size: 17)).foregroundStyle(.secondary)
                Text("Publish rota").font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 9).background(Color(hex: 0x16233a), in: Capsule())
            }
            .padding(28)
            ForEach(Array(crew.enumerated()), id: \.offset) { index, name in
                HStack(spacing: 14) {
                    Text(name).font(.system(size: 18, weight: .medium)).frame(width: 80, alignment: .leading)
                    GeometryReader { proxy in
                        let unit = proxy.size.width / 6
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0xf1f3f7))
                            ForEach(Array(blocks[index].enumerated()), id: \.offset) { _, block in
                                RoundedRectangle(cornerRadius: 8).fill(Color(hex: block.2).opacity(0.85))
                                    .frame(width: unit * CGFloat(block.1) - 6)
                                    .offset(x: unit * CGFloat(block.0) + 3)
                                    .padding(.vertical, 5)
                            }
                        }
                    }
                    .frame(height: 46)
                }
                .padding(.horizontal, 28).padding(.vertical, 7)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color(hex: 0x16233a))
        .background(.white)
    }
}

private struct ListPhone: View {
    var title: String
    var tint: Color
    var rows: [(String, String)]
    var map: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.system(size: 34, weight: .bold)).padding(.top, 64)
            if map {
                RoundedRectangle(cornerRadius: 22).fill(tint.opacity(0.18))
                    .frame(height: 190)
                    .overlay {
                        Path { path in
                            path.move(to: CGPoint(x: 20, y: 150))
                            path.addCurve(to: CGPoint(x: 330, y: 50), control1: CGPoint(x: 120, y: 20), control2: CGPoint(x: 220, y: 190))
                        }
                        .stroke(tint, style: StrokeStyle(lineWidth: 5, lineCap: .round, dash: [2, 12]))
                    }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 14) {
                    Circle().fill(tint.opacity(0.9)).frame(width: 38, height: 38)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(row.0).font(.system(size: 19, weight: .semibold))
                        Text(row.1).font(.system(size: 15)).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(14)
                .background(Color(hex: 0xf5f5f7), in: RoundedRectangle(cornerRadius: 18))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .foregroundStyle(.black)
        .background(.white)
    }
}

private struct DashboardPage: View {
    var title: String
    var accent: Color
    private let bars: [CGFloat] = [0.4, 0.62, 0.5, 0.78, 0.66, 0.9, 0.72, 0.84]

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 18) {
                Text(title).font(.system(size: 22, weight: .bold))
                ForEach(["Overview", "Invoices", "Clients", "Reports"], id: \.self) { item in
                    Text(item).font(.system(size: 16, weight: item == "Overview" ? .semibold : .regular))
                        .foregroundStyle(item == "Overview" ? accent : Color.secondary)
                }
                Spacer()
            }
            .padding(26)
            .frame(width: 190, alignment: .leading)
            .background(Color(hex: 0xf6f7f9))
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 16) {
                    ForEach([("$18,240", "Paid"), ("$4,310", "Outstanding"), ("3", "Overdue")], id: \.1) { stat in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(stat.0).font(.system(size: 26, weight: .bold))
                            Text(stat.1).font(.system(size: 14)).foregroundStyle(.secondary)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white, in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.black.opacity(0.07)))
                    }
                }
                HStack(alignment: .bottom, spacing: 14) {
                    ForEach(Array(bars.enumerated()), id: \.offset) { _, bar in
                        RoundedRectangle(cornerRadius: 6).fill(accent.opacity(0.85)).frame(height: 210 * bar)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(18)
                .background(.white, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.black.opacity(0.07)))
            }
            .padding(26)
        }
        .foregroundStyle(Color(hex: 0x111827))
        .background(Color(hex: 0xfbfbfc))
    }
}

private struct NotesPage: View {
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text("# Studio notes").font(.system(size: 20, weight: .bold, design: .monospaced))
                ForEach(["- Ship the **editor**", "- Live preview pane", "- Export to PDF", "", "> Keep it calm."], id: \.self) { line in
                    Text(line).font(.system(size: 16, design: .monospaced)).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(hex: 0xf7f5f0))
            VStack(alignment: .leading, spacing: 14) {
                Text("Studio notes").font(.system(size: 30, weight: .bold, design: .serif))
                ForEach(["Ship the editor", "Live preview pane", "Export to PDF"], id: \.self) { line in
                    HStack(spacing: 10) { Circle().fill(.black).frame(width: 6, height: 6); Text(line).font(.system(size: 18)) }
                }
                Text("Keep it calm.").font(.system(size: 18, design: .serif)).italic().foregroundStyle(.secondary).padding(.leading, 14)
                Spacer()
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(.black)
        .background(.white)
    }
}

private struct StudioPage: View {
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                Text("PIXELBLAST").font(.system(size: 22, weight: .black, design: .monospaced))
                Text("PROMPT").font(.system(size: 13, weight: .bold, design: .monospaced)).padding(6).background(Color(hex: 0xff7a00))
                Rectangle().strokeBorder(.black, lineWidth: 3).frame(height: 110)
                    .overlay(alignment: .topLeading) { Text("a neon city at dusk, film grain").font(.system(size: 15, design: .monospaced)).padding(10) }
                HStack(spacing: 8) {
                    ForEach(["1:1", "4:3", "16:9"], id: \.self) { ratio in
                        Text(ratio).font(.system(size: 14, weight: .bold, design: .monospaced)).frame(maxWidth: .infinity).padding(.vertical, 9)
                            .background(ratio == "1:1" ? Color.black : Color.white).foregroundStyle(ratio == "1:1" ? .white : .black)
                            .overlay(Rectangle().strokeBorder(.black, lineWidth: 3))
                    }
                }
                Spacer()
            }
            .padding(26)
            .frame(width: 330)
            Rectangle().fill(LinearGradient(colors: [Color(hex: 0x2b1055), Color(hex: 0xff5e62), Color(hex: 0xffc371)], startPoint: .top, endPoint: .bottom))
                .overlay(Rectangle().strokeBorder(.black, lineWidth: 3))
                .padding(26)
        }
        .foregroundStyle(.black)
        .background(Color(hex: 0xfdf6e3))
    }
}

private struct KanbanPage: View {
    private let columns: [(String, [String], UInt32)] = [
        ("To do", ["Invite flow", "Empty states", "Billing page"], 0xfde68a),
        ("Doing", ["Realtime sync", "Drag and drop"], 0xbfdbfe),
        ("Done", ["Auth", "Boards", "Labels"], 0xbbf7d0),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Kanbanana").font(.system(size: 26, weight: .heavy, design: .rounded))
            HStack(alignment: .top, spacing: 18) {
                ForEach(columns, id: \.0) { column in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(column.0).font(.system(size: 16, weight: .bold, design: .rounded))
                        ForEach(column.1, id: \.self) { card in
                            Text(card).font(.system(size: 16, design: .rounded))
                                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(hex: column.2), in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .background(Color(hex: 0xf4f4f5), in: RoundedRectangle(cornerRadius: 18))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(28)
        .foregroundStyle(Color(hex: 0x27272a))
        .background(.white)
    }
}
