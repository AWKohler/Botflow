import ActivityKit
import SwiftUI
import WidgetKit

@main
struct BotflowWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentLiveActivity()
    }
}

/// A running agent on the Lock Screen and in the Dynamic Island: what it is
/// doing right now, how long it has been at it, and how it ended.
struct AgentLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(Color(hex: 0x1b1815).opacity(0.92))
                .activitySystemActionForegroundColor(Color(hex: 0xede6db))
                .widgetURL(context.attributes.deepLink)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 7) {
                        BotflowGlyph(color: Island.text, seam: .black).frame(width: 20)
                        Text(context.attributes.projectName)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Island.text)
                            .lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Elapsed(state: context.state)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Island.muted)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    EmptyView()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(context.attributes.threadTitle)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Island.text)
                            .lineLimit(1)
                        CurrentStep(state: context.state)
                        if !context.state.isFinished, context.state.recent.count > 1 {
                            VStack(alignment: .leading, spacing: 3) {
                                ForEach(context.state.recent.dropLast().suffix(2), id: \.self) { line in
                                    Text(line)
                                        .font(.caption2)
                                        .foregroundStyle(Island.subtle)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 4)
                }
            } compactLeading: {
                StepSymbol(state: context.state)
                    .font(.footnote.weight(.semibold))
            } compactTrailing: {
                if context.state.isFinished {
                    Image(systemName: context.state.phase == .done ? "checkmark" : "exclamationmark")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(context.state.phase == .done ? Island.success : Island.danger)
                } else if context.state.phase == .needsInput {
                    Text("Reply")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Island.warning)
                } else {
                    Text("\(context.state.steps)")
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Island.text)
                        .contentTransition(.numericText())
                }
            } minimal: {
                StepSymbol(state: context.state)
                    .font(.caption.weight(.semibold))
            }
            .widgetURL(context.attributes.deepLink)
            .keylineTint(Island.accent)
        }
    }
}

/// Colours for the island and Lock Screen, which are always dark.
enum Island {
    static let text = Color(hex: 0xede6db)
    static let muted = Color(hex: 0xb5ab9f)
    static let subtle = Color(hex: 0x9a9186)
    static let accent = Color(hex: 0x8aa6ff)
    static let success = Color(hex: 0x7ad395)
    static let warning = Color(hex: 0xecb866)
    static let danger = Color(hex: 0xff7a6e)

    static func tint(for phase: AgentActivityAttributes.ContentState.Phase) -> Color {
        switch phase {
        case .starting, .working: return accent
        case .needsInput: return warning
        case .done: return success
        case .failed: return danger
        }
    }
}

struct StepSymbol: View {
    var state: AgentActivityAttributes.ContentState

    var body: some View {
        Image(systemName: state.symbol)
            .foregroundStyle(Island.tint(for: state.phase))
            .contentTransition(.symbolEffect(.replace))
            .symbolEffect(.pulse, isActive: state.phase == .working || state.phase == .starting)
    }
}

struct Elapsed: View {
    var state: AgentActivityAttributes.ContentState

    var body: some View {
        if let ended = state.endedAt {
            Text(Duration.seconds(ended.timeIntervalSince(state.startedAt)).formatted(.units(allowed: [.minutes, .seconds], width: .narrow)))
                .monospacedDigit()
        } else {
            Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 52, alignment: .trailing)
        }
    }
}

struct CurrentStep: View {
    var state: AgentActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 7) {
            StepSymbol(state: state)
                .font(.footnote.weight(.semibold))
                .frame(width: 18)
            Text(state.action)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Island.text)
                .layoutPriority(1)
            if !state.detail.isEmpty {
                Text(state.detail)
                    .font(.system(.caption, design: state.isFinished ? .default : .monospaced))
                    .foregroundStyle(Island.muted)
                    .lineLimit(state.isFinished ? 2 : 1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if !state.isFinished, state.steps > 0 {
                Text(state.steps == 1 ? "1 step" : "\(state.steps) steps")
                    .font(.caption2)
                    .foregroundStyle(Island.subtle)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

struct LockScreenView: View {
    var context: ActivityViewContext<AgentActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                BotflowGlyph(color: Island.text, seam: Color(hex: 0x1b1815)).frame(width: 22)
                Text(context.attributes.projectName)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Island.text)
                    .lineLimit(1)
                Text(context.attributes.modelName)
                    .font(.caption)
                    .foregroundStyle(Island.subtle)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Elapsed(state: context.state)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Island.muted)
            }
            Text(context.attributes.threadTitle)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Island.text)
                .lineLimit(1)
            CurrentStep(state: context.state)
        }
        .padding(16)
    }
}
