// Renders the app icon variants from the brand mark. Run: swift scripts/make-icon.swift <outdir>
import AppKit
import CoreGraphics

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let size: CGFloat = 1024

func arch(x: CGFloat, y: CGFloat, scale: CGFloat) -> CGPath {
    // The mark's arch in SVG space (204 × 202, y down), flipped for CoreGraphics.
    func p(_ px: CGFloat, _ py: CGFloat) -> CGPoint { CGPoint(x: x + px * scale, y: y + (202 - py) * scale) }
    let path = CGMutablePath()
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

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

func render(name: String, top: UInt32, bottom: UInt32, glyph: UInt32, glow: UInt32?, transparent: Bool = false) {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    if !transparent {
        let gradient = CGGradient(colorsSpace: space, colors: [color(top), color(bottom)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: 0, y: 0), options: [])
        if let glow {
            let radial = CGGradient(colorsSpace: space, colors: [color(glow, 0.30), color(glow, 0)] as CFArray, locations: [0, 1])!
            ctx.drawRadialGradient(radial, startCenter: CGPoint(x: size * 0.86, y: size * 0.9), startRadius: 0, endCenter: CGPoint(x: size * 0.86, y: size * 0.9), endRadius: size * 0.75, options: [])
        }
    }
    // The mark is 280 × 202 units; make it 58% of the icon's width.
    let scale = size * 0.58 / 280
    let originX = (size - 280 * scale) / 2
    let originY = (size - 202 * scale) / 2
    let back = arch(x: originX + 76 * scale, y: originY, scale: scale)
    let front = arch(x: originX, y: originY, scale: scale)
    // The back arch lives on its own layer so the seam cut touches nothing else.
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.setFillColor(color(glyph))
    ctx.addPath(back)
    ctx.fillPath()
    ctx.setBlendMode(.clear)
    ctx.setLineWidth(15 * scale)
    ctx.addPath(front)
    ctx.strokePath()
    ctx.setBlendMode(.normal)
    ctx.endTransparencyLayer()

    ctx.setFillColor(color(glyph))
    ctx.addPath(front)
    ctx.fillPath()

    let image = ctx.makeImage()!
    let rep = NSBitmapImageRep(cgImage: image)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
}

render(name: "icon-light", top: 0xfbfaf7, bottom: 0xebe6dc, glyph: 0x27272a, glow: 0x1d52f1)
render(name: "icon-dark", top: 0x2a2621, bottom: 0x1b1815, glyph: 0xede6db, glow: 0x5f82f7)
render(name: "icon-tinted", top: 0x000000, bottom: 0x000000, glyph: 0xffffff, glow: nil)
