import SwiftUI

/// A project's cover: its latest preview screenshot when there is one,
/// otherwise a quiet drawn placeholder in a colour that stays with the project.
struct ProjectCover: View {
    var imageURL: URL?
    var seed: String
    var platform: ProjectPlatform

    init(project: Project) {
        imageURL = project.previewImageURL
        seed = project.id
        platform = project.kind
    }

    init(imageURL: URL?, seed: String, platform: ProjectPlatform) {
        self.imageURL = imageURL
        self.seed = seed
        self.platform = platform
    }

    private static let palettes: [(Color, Color)] = [
        (Color(light: 0xe9e2d3, dark: 0x3a332a), Color(light: 0xd9cdb6, dark: 0x4a4034)),   // sand
        (Color(light: 0xdfe6dc, dark: 0x2b352c), Color(light: 0xc6d4c2, dark: 0x3a4a3c)),   // sage
        (Color(light: 0xe1e6f7, dark: 0x262c42), Color(light: 0xc5d0f3, dark: 0x343f66)),   // cobalt
        (Color(light: 0xf0dfd6, dark: 0x3d2c26), Color(light: 0xe3c4b4, dark: 0x543a30)),   // clay
        (Color(light: 0xe8e0ee, dark: 0x332b3b), Color(light: 0xd4c5e0, dark: 0x463a52)),   // plum
    ]

    private var palette: (Color, Color) {
        let hash = seed.unicodeScalars.reduce(5381) { ($0 &* 33) &+ Int($1.value) }
        return Self.palettes[abs(hash) % Self.palettes.count]
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(colors: [palette.0, palette.1], startPoint: .topLeading, endPoint: .bottomTrailing)
                if AppConfig.isDemo, DemoCovers.has(seed) {
                    DemoCovers.view(for: seed, in: proxy.size)
                } else if let imageURL {
                    AsyncImage(url: imageURL, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                                .clipped()
                        } else {
                            placeholder(in: proxy.size)
                        }
                    }
                } else {
                    placeholder(in: proxy.size)
                }
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func placeholder(in size: CGSize) -> some View {
        if platform == .swift {
            // A phone, cropped by the bottom edge.
            let width = min(size.width * 0.34, size.height * 0.62)
            VStack(spacing: width * 0.07) {
                Capsule().fill(Sand.text.opacity(0.75)).frame(width: width * 0.3, height: width * 0.07).padding(.top, width * 0.08)
                RoundedRectangle(cornerRadius: width * 0.06).fill(palette.1.opacity(0.9)).frame(height: width * 0.5)
                skeleton(width: width * 0.78, lines: 3, unit: width * 0.065)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, width * 0.1)
            .frame(width: width, height: size.height * 0.92)
            .background(Sand.card, in: UnevenRoundedRectangle(topLeadingRadius: width * 0.16, topTrailingRadius: width * 0.16))
            .overlay(UnevenRoundedRectangle(topLeadingRadius: width * 0.16, topTrailingRadius: width * 0.16).strokeBorder(Sand.text.opacity(0.12), lineWidth: 1))
            .shadow(color: Sand.shadow.opacity(0.12), radius: 10, y: 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        } else {
            // A browser window, cropped by the bottom-right corner.
            let width = size.width * 0.78
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { _ in Circle().fill(Sand.text.opacity(0.18)).frame(width: 5, height: 5) }
                }
                .padding(.horizontal, 8)
                .frame(height: 16)
                Divider().overlay(Sand.text.opacity(0.08))
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 3).fill(Sand.text.opacity(0.7)).frame(width: width * 0.36, height: 7)
                        skeleton(width: width * 0.42, lines: 2, unit: 4.5)
                        Capsule().fill(Sand.text.opacity(0.8)).frame(width: width * 0.2, height: 9).padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                    RoundedRectangle(cornerRadius: 5).fill(palette.1).frame(width: width * 0.3, height: width * 0.24)
                }
                .padding(10)
                Spacer(minLength: 0)
            }
            .frame(width: width, height: size.height * 0.86)
            .background(Sand.card, in: UnevenRoundedRectangle(topLeadingRadius: 9))
            .overlay(UnevenRoundedRectangle(topLeadingRadius: 9).strokeBorder(Sand.text.opacity(0.1), lineWidth: 1))
            .shadow(color: Sand.shadow.opacity(0.1), radius: 10, y: 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        }
    }

    private func skeleton(width: CGFloat, lines: Int, unit: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: unit * 0.9) {
            ForEach(0..<lines, id: \.self) { index in
                Capsule()
                    .fill(Sand.text.opacity(0.16))
                    .frame(width: width * (index == lines - 1 ? 0.6 : 1), height: unit)
            }
        }
    }
}
