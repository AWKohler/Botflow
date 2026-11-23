import SwiftUI

struct ProjectsView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var agents: AgentsHub
    @Namespace private var zoom
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows

    @State private var projects: [Project] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var search = ""
    @State private var filter: Filter = .all
    @State private var pendingDelete: Project?

    enum Filter: String, CaseIterable {
        case all = "All", web = "Web", ios = "iOS", shared = "Shared"
    }

    private var visible: [Project] {
        projects.filter { project in
            let matchesFilter: Bool
            switch filter {
            case .all: matchesFilter = true
            case .web: matchesFilter = !project.isSwift
            case .ios: matchesFilter = project.isSwift
            case .shared: matchesFilter = project.shared == true
            }
            return matchesFilter && (search.isEmpty || project.name.localizedCaseInsensitiveContains(search))
        }
    }

    private let columns = [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: Space.l, alignment: .top)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                if let error, projects.isEmpty {
                    ErrorBanner(message: error) { Task { await load() } }
                }
                if loaded, projects.isEmpty, error == nil {
                    EmptyState(
                        symbol: "square.grid.2x2",
                        title: "No projects yet",
                        message: "Describe an app on the Build tab and your first project appears here.",
                        actionTitle: "Start building",
                        action: { router.tab = .build }
                    )
                    .padding(.top, 60)
                } else {
                    filters
                    if !loaded {
                        LazyVGrid(columns: columns, spacing: Space.l) {
                            ForEach(0..<4, id: \.self) { _ in ProjectCardSkeleton() }
                        }
                    } else if visible.isEmpty {
                        EmptyState(symbol: "magnifyingglass", title: "Nothing matches", message: "Try a different name or filter.")
                            .padding(.top, 40)
                    } else {
                        LazyVGrid(columns: columns, spacing: Space.l) {
                            ForEach(visible) { project in
                                card(project)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .sandCanvas()
        .navigationTitle("Projects")
        .searchable(text: $search, prompt: "Search projects")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    router.tab = .build
                } label: {
                    Label("New project", systemImage: "plus")
                }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) { AccountButton() }
        }
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(
            "Delete “\(pendingDelete?.name ?? "")”?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete project", role: .destructive) {
                if let project = pendingDelete { Task { await delete(project) } }
            }
        } message: {
            Text("Its code, chats and sandbox are removed for good. A published site is taken down.")
        }
    }

    private var filters: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Space.s) {
                ForEach(Filter.allCases, id: \.self) { item in
                    let selected = filter == item
                    Button {
                        Haptics.select()
                        withMotion(.snappy) { filter = item }
                    } label: {
                        Text(item.rawValue)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(selected ? Sand.bg : Sand.muted)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 34)
                            .background(selected ? Sand.text : Sand.card, in: Capsule())
                            .overlay(Capsule().strokeBorder(selected ? .clear : Sand.border, lineWidth: 1))
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
                Spacer()
                if loaded {
                    Text(visible.count == 1 ? "1 project" : "\(visible.count) projects")
                        .font(.footnote)
                        .foregroundStyle(Sand.subtle)
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func card(_ project: Project) -> some View {
        let active = agents.agents.filter { $0.projectId == project.id }
        return Button {
            Haptics.tap()
            router.open(WorkspaceRoute(project: project))
        } label: {
            ProjectCard(project: project, activity: active)
        }
        .buttonStyle(PressableStyle())
        .matchedTransitionSource(id: project.id, in: zoom)
        .contextMenu {
            Button { router.open(WorkspaceRoute(project: project)) } label: { Label("Open", systemImage: "arrow.up.forward.app") }
            if supportsMultipleWindows {
                Button { openWindow(id: "project", value: project.id) } label: { Label("Open in New Window", systemImage: "macwindow.badge.plus") }
            }
            if let url = project.liveURL {
                Link(destination: url) { Label("Visit live site", systemImage: "safari") }
                ShareLink(item: url) { Label("Share live site", systemImage: "square.and.arrow.up") }
            }
            if project.isPublic == true, let slug = project.publicSlug {
                ShareLink(item: AppConfig.baseURL.appendingPathComponent("p/\(slug)")) { Label("Share public page", systemImage: "link") }
            }
            if project.isOwner {
                Divider()
                Button(role: .destructive) { pendingDelete = project } label: { Label("Delete", systemImage: "trash") }
            }
        }
    }

    private func load() async {
        do {
            let list = try await session.service.projects()
            withMotion(.snappy(duration: 0.3)) {
                projects = list.sorted { ($0.lastOpened ?? .distantPast) > ($1.lastOpened ?? .distantPast) }
            }
            error = nil
        } catch let failure {
            error = failure.localizedDescription
        }
        loaded = true
    }

    private func delete(_ project: Project) async {
        withMotion(.snappy) { projects.removeAll { $0.id == project.id } }
        do {
            try await session.service.deleteProject(project.id)
            ToastCenter.shared.show("Deleted “\(project.name)”", symbol: "trash.fill", tone: .neutral)
        } catch {
            ToastCenter.shared.error(error)
            await load()
        }
    }
}

struct ProjectCard: View {
    var project: Project
    var activity: [AgentActivity] = []

    private var status: ThreadStatus? {
        if activity.contains(where: { $0.thread.status == .needsInput }) { return .needsInput }
        if activity.contains(where: { $0.thread.status == .running }) { return .running }
        if activity.contains(where: { $0.thread.status == .error }) { return .error }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ProjectCover(project: project)
                .aspectRatio(16 / 9.5, contentMode: .fit)
                .clipped()
            Divider().overlay(Sand.border)
            HStack(alignment: .center, spacing: Space.m) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(project.name)
                            .font(.headline)
                            .foregroundStyle(Sand.text)
                            .lineLimit(1)
                        if project.isPublic == true {
                            Badge(text: (project.starCount ?? 0) > 0 ? "Public · \(project.starCount ?? 0)" : "Public", symbol: "globe", tone: .accent)
                                .fixedSize()
                        }
                        if project.shared == true {
                            Badge(text: "Shared", symbol: "person.2").fixedSize()
                        }
                    }
                    // The model is the first thing to go when the card is narrow: a cut-off name says nothing.
                    ViewThatFits(in: .horizontal) {
                        meta(model: true)
                        meta(model: false)
                    }
                    .font(.footnote)
                    .foregroundStyle(Sand.subtle)
                    .lineLimit(1)
                    .accessibilityElement(children: .combine)
                }
                Spacer(minLength: 0)
                if let status {
                    HStack(spacing: 2) {
                        StatusDot(status: status, size: 8)
                        Text(status == .running ? "Working" : status == .needsInput ? "Needs you" : "Error")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(status.tone.foreground)
                    }
                    .padding(.trailing, 4)
                }
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, 14)
        }
        .background(Sand.card)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
        .shadow(color: Sand.shadow.opacity(0.06), radius: 10, y: 4)
        .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

extension ProjectCard {
    fileprivate func meta(model: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: project.kind.symbol).imageScale(.small)
            Text(project.kind.label)
            if let opened = project.lastOpened {
                Text("·")
                Text(opened.formatted(.dateTime.month(.abbreviated).day()))
            }
            if model {
                Text("·")
                Text(ModelCatalog.model(project.model).shortName)
            }
        }
        .lineLimit(1)
        .fixedSize()
    }
}

struct ProjectCardSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Sand.elevated).aspectRatio(16 / 9.5, contentMode: .fit)
            VStack(alignment: .leading, spacing: 8) {
                Capsule().fill(Sand.soft).frame(width: 150, height: 12)
                Capsule().fill(Sand.elevated).frame(width: 100, height: 10)
            }
            .padding(Space.l)
        }
        .background(Sand.card)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Sand.border, lineWidth: 1))
        .shimmer()
        .accessibilityHidden(true)
    }
}
