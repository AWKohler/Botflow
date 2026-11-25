import SwiftUI

/// One arch of the Botflow mark: round on the top and left, square at the
/// bottom-right corner. Drawn from the brand SVG (204 × 202 units).
struct BotflowArch: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 204
        let sy = rect.height / 202
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy) }
        var path = Path()
        path.move(to: p(0, 101))
        path.addCurve(to: p(100, 0), control1: p(0, 45.77), control2: p(44.77, 0))
        path.addLine(to: p(104, 0))
        path.addCurve(to: p(204, 100), control1: p(159.23, 0), control2: p(204, 44.77))
        path.addLine(to: p(204, 202))
        path.addLine(to: p(100, 202))
        path.addCurve(to: p(0, 101), control1: p(44.77, 202), control2: p(0, 156.23))
        path.closeSubpath()
        return path
    }
}

/// The Botflow mark: two overlapping arches. The seam between them is cut out
/// in the background colour, as in the website header.
struct BotflowGlyph: View {
    var color: Color = Sand.text
    var seam: Color = Sand.canvas

    var body: some View {
        GeometryReader { proxy in
            // The full mark is 280 × 202; each arch is 204 wide, offset by 76.
            let unit = proxy.size.width / 280
            let archWidth = 204 * unit
            ZStack(alignment: .leading) {
                BotflowArch()
                    .fill(color)
                    .frame(width: archWidth)
                    .offset(x: 76 * unit)
                BotflowArch()
                    .fill(color)
                    .frame(width: archWidth)
                    .background(
                        BotflowArch()
                            .stroke(seam, lineWidth: max(1.5, 14 * unit))
                            .frame(width: archWidth)
                    )
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
            .clipped()
        }
        .aspectRatio(280 / 202, contentMode: .fit)
        .accessibilityHidden(true)
    }
}
