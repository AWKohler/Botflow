import SwiftUI

/// A provider's mark: its icon where Botflow ships one, a monogram tile otherwise.
struct ProviderMark: View {
    var provider: ModelProvider
    var modelId: String?
    var size: CGFloat = 18

    private var asset: String? {
        if let modelId {
            if modelId.contains("kimi") { return "provider-kimi" }
            if modelId.contains("minimax") { return "provider-minimax" }
        }
        switch provider {
        case .anthropic: return "provider-anthropic"
        case .openai: return "provider-openai"
        default: return nil
        }
    }

    var body: some View {
        Group {
            if let asset {
                // The artwork has a transparent margin; scale it to fill the tile.
                Image(asset).resizable().scaledToFit().scaleEffect(1.22)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                        .fill(provider == .google ? Color(hex: 0x3b6fe0) : Color(hex: 0x1c1c1e))
                    Text(provider == .google ? "G" : provider == .xai ? "x" : "F")
                        .font(.system(size: size * 0.6, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Choose a model. Each row says what it costs and whether this account can
/// run it; locked rows lead to the fix instead of failing later.
struct ModelPickerSheet: View {
    @Binding var selection: String
    var onSelect: ((String) -> Void)?
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(ModelCatalog.all) { model in
                        row(model)
                    }
                }
                .padding(.horizontal, Space.m)
                .padding(.bottom, Space.xl)
            }
            .background(Sand.bg)
            .navigationTitle("Choose a model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Sand.bg)
    }

    private func row(_ model: AIModel) -> some View {
        let access = session.access(for: model)
        let selected = model.id == selection
        return Button {
            guard access.runnable else {
                Haptics.warning()
                dismiss()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    router.sheet = model.provider == .anthropic && session.tier == .free ? .settings : .paywall(reason: access.title)
                }
                return
            }
            Haptics.select()
            selection = model.id
            onSelect?(model.id)
            dismiss()
        } label: {
            HStack(alignment: .center, spacing: Space.m) {
                ProviderMark(provider: model.provider, modelId: model.id, size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(model.name)
                            .font(.body.weight(.medium))
                            .foregroundStyle(Sand.text)
                        Text(model.hostLabel)
                            .font(.footnote)
                            .foregroundStyle(Sand.subtle)
                        if model.requiredTier != .free, access.source == .planCredits || !access.runnable {
                            Badge(text: model.requiredTier.label, tone: .accent)
                        }
                    }
                    Text("\(model.contextLabel) context · \(access.runnable && access.source != .planCredits ? access.title : model.costLabel)")
                        .font(.footnote)
                        .foregroundStyle(Sand.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: Space.s)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Sand.text)
                } else if !access.runnable {
                    Image(systemName: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(Sand.subtle)
                }
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, 11)
            .background(selected ? Sand.elevated : .clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .opacity(access.runnable ? 1 : 0.72)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(model.name), \(model.hostLabel), \(access.runnable ? access.title : "locked: " + access.title)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
