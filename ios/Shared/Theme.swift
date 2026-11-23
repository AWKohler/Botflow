import SwiftUI
import UIKit

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xff) / 255,
                green: CGFloat((hex >> 8) & 0xff) / 255,
                blue: CGFloat(hex & 0xff) / 255,
                alpha: 1
            )
        })
    }
}

/// Botflow's sand palette: the same tokens as the website's `globals.css`,
/// light ("Sand") and dark ("Night Sand").
enum Sand {
    // Surfaces step up in warmth: bg → surface → elevated → soft.
    static let bg = Color(light: 0xfefefe, dark: 0x1b1815)
    static let surface = Color(light: 0xfbfaf7, dark: 0x221f1b)
    static let elevated = Color(light: 0xf6f3ec, dark: 0x2a2621)
    static let soft = Color(light: 0xebe6dc, dark: 0x36302a)
    static let border = Color(light: 0xe9e6df, dark: 0x35302a)
    static let borderStrong = Color(light: 0xcfcac0, dark: 0x4a433a)
    static let control = Color(light: 0x8f8a80, dark: 0x7a7368)

    // Text steps down in weight: text → muted → subtle.
    static let text = Color(light: 0x27272a, dark: 0xede6db)
    static let muted = Color(light: 0x5f5e5a, dark: 0xb5ab9f)
    static let subtle = Color(light: 0x737169, dark: 0x9a9186)

    static let accent = Color(light: 0x1d52f1, dark: 0x8aa6ff)
    static let accentContrast = Color(light: 0xffffff, dark: 0x101728)
    static let accentSoft = Color(light: 0xeaeffe, dark: 0x262b3c)

    static let success = Color(light: 0x17773a, dark: 0x7ad395)
    static let successSolid = Color(light: 0x1f9d4d, dark: 0x2f9e58)
    static let successSoft = Color(light: 0xe9f5ee, dark: 0x1f2b20)
    static let warning = Color(light: 0x9a5b00, dark: 0xecb866)
    static let warningSolid = Color(light: 0xd98a0b, dark: 0xd0892a)
    static let warningSoft = Color(light: 0xfbf3e4, dark: 0x33291a)
    static let danger = Color(light: 0xc0271d, dark: 0xff7a6e)
    static let dangerSolid = Color(light: 0xd93a2f, dark: 0xe0463b)
    static let dangerSoft = Color(light: 0xfbebe9, dark: 0x361f1b)

    static let codeKeyword = Color(light: 0xb84c33, dark: 0xf0957d)
    static let codeFunction = Color(light: 0x1d52f1, dark: 0x8aa6ff)
    static let codeString = Color(light: 0x47752b, dark: 0xa3d18a)
    static let codeType = Color(light: 0x96601f, dark: 0xe3b577)
    static let codeProperty = Color(light: 0x6a4ba3, dark: 0xc8b0f2)

    /// The screen behind everything: one step warmer than a card.
    static let canvas = surface
    /// A raised card on the canvas.
    static let card = Color(light: 0xfefefe, dark: 0x262320)
    /// A control raised above its track (the selected segment, a selected
    /// chip). In dark it must be lighter than the track it sits on.
    static let raised = Color(light: 0xfefefe, dark: 0x3d3730)
    /// The warm shadow colour, stronger in dark.
    static let shadow = Color(light: 0x262016, dark: 0x000000)
}

enum Radius {
    static let small: CGFloat = 8
    static let control: CGFloat = 12
    static let card: CGFloat = 18
    static let sheet: CGFloat = 26
}

enum Space {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 28
    /// Side gutter for screen content.
    static let gutter: CGFloat = 20
}

extension Font {
    /// Instrument Serif, the display face of the website's headlines.
    static func serif(_ size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
        .custom("InstrumentSerif-Regular", size: size, relativeTo: style)
    }

    static func serifItalic(_ size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
        .custom("InstrumentSerif-Italic", size: size, relativeTo: style)
    }

    /// Monospaced text that follows Dynamic Type: `size` is the size at the
    /// default text size and scales with the person's setting.
    static func code(_ size: CGFloat = 13) -> Font {
        .system(size: UIFontMetrics(forTextStyle: .footnote).scaledValue(for: size), design: .monospaced)
    }
}
