import SwiftUI

/// The public gallery: what other people have built and shared.
struct ExploreView: View {
    @EnvironmentObject private var session: AppSession

    @State private var projects: [PublicProject] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var sort = "top"
    @State private var platform = "all"
    @State private var opened: PublicProject?

    private let columns = [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: Space.l, alignment: .top)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                HStack(spacing: Space.m) {
                    SegmentedTabs(
                        selection: $sort,
                        items: [.init(value: "top", title: "Top"), .init(value: "recent", title: "New")],
                        compact: true
                    )
                    Spacer()
                    Menu {
                        Picker("Platform", selection: $platform) {
                            Text("All apps").tag("all")
                            Label("Web apps", systemImage: "globe").tag("web")
                            Label("iOS apps", systemImage: "swift").tag("swift")
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(platform == "all" ? "All apps" : platform == "web" ? "Web apps" : "iOS apps")
                            Image(systemName: "chevron.down").imageScale(.small)
                        }
                    }
                    .buttonStyle(RaisedButtonStyle(size: .small))
                }

                if let error, projects.isEmpty {
                    ErrorBanner(message: error) { Task { await load() } }
                } else if !loaded {
                    LazyVGrid(columns: columns, spacing: Space.l) {
                        ForEach(0..<4, id: \.self) { _ in ProjectCardSkeleton() }
                    }
                } else if projects.isEmpty {
                    EmptyState(symbol: "safari", title: "Nothing here yet", message: "Public projects show up here once people publish them.")
                        .padding(.top, 40)
                } else {
                    LazyVGrid(columns: columns, spacing: Space.l) {
                        ForEach(projects) { project in
                            Button {
                                Haptics.tap()
                                opened = project
                            } label: {
                                PublicCard(project: project) { Task { await star(project) } }
                            }
                            .buttonStyle(PressableStyle())
                        }
                    }
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .sandCanvas()
        .navigationTitle("Explore")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { AccountButton() } }
        .refreshable { await load() }
        .task(id: sort + platform) { await load() }
        .sheet(item: $opened) { project in
            if let url = project.pageURL {
                WebSheet(title: project.name, url: url)
            }
        }
    }

    private func load() async {
        do {
            let list = try await session.service.publicProjects(sort: sort, platform: platform == "all" ? nil : platform)
            withMotion(.snappy(duration: 0.3)) { projects = list }
            error = nil
        } catch let failure {
            error = failure.localizedDescription
        }
        loaded = true
    }

    private func star(_ project: PublicProject) async {
        guard let slug = project.publicSlug, let index = projects.firstIndex(where: { $0.id == project.id }) else { return }
        Haptics.tap()
        let was = projects[index].hasStarred ?? false
        withMotion(.snappy) {
            projects[index].hasStarred = !was
            projects[index].starCount = max(0, (projects[index].starCount ?? 0) + (was ? -1 : 1))
        }
        do {
            let result = try await session.service.toggleStar(slug: slug)
            if let index = projects.firstIndex(where: { $0.id == project.id }) {
                projects[index].hasStarred = result.starred
                projects[index].starCount = result.count
            }
        } catch {
            ToastCenter.shared.error(error)
        }
    }
}

struct PublicCard: View {
    var project: PublicProject
    var onStar: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ProjectCover(imageURL: project.thumbnailUrl.flatMap(URL.init(string:)), seed: project.id, platform: project.kind)
                .aspectRatio(16 / 9.5, contentMode: .fit)
                .clipped()
            Divider().overlay(Sand.border)
            HStack(alignment: .top, spacing: Space.m) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(project.name)
                        .font(.headline)
                        .foregroundStyle(Sand.text)
                        .lineLimit(1)
                    // Always two lines tall, so cards in a row are the same height.
                    Text(project.publicDescription ?? " ")
                        .font(.subheadline)
                        .foregroundStyle(Sand.muted)
                        .lineLimit(2, reservesSpace: true)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 5) {
                        Image(systemName: project.kind.symbol).imageScale(.small)
                        Text(project.kind.label)
                        Text("·")
                        Text("by \(project.author?.name ?? "Anonymous")")
                    }
                    .font(.footnote)
                    .foregroundStyle(Sand.subtle)
                    .lineLimit(1)
                    .accessibilityElement(children: .combine)
                }
                Spacer(minLength: 0)
                Button(action: onStar) {
                    HStack(spacing: 4) {
                        Image(systemName: project.hasStarred == true ? "star.fill" : "star")
                            .symbolEffect(.bounce, value: project.hasStarred)
                        Text("\(project.starCount ?? 0)")
                            .monospacedDigit()
                            .contentTransition(.numericText())
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(project.hasStarred == true ? Sand.warningSolid : Sand.muted)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 34)
                    .background(Sand.elevated, in: Capsule())
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(project.hasStarred == true ? "Remove star, \(project.starCount ?? 0) stars" : "Star, \(project.starCount ?? 0) stars")
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, 14)
        }
        .background(Sand.card)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
        .shadow(color: Sand.shadow.opacity(0.06), radius: 10, y: 4)
    }
}
