import SwiftUI
import WebKit

/// State shared between a web view and the controls around it.
@MainActor
final class WebViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var progress: Double = 0
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var currentURL: URL?
    @Published var title: String?
    weak var webView: WKWebView?

    func reload() { webView?.reload() }
    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
    func load(_ url: URL) { webView?.load(URLRequest(url: url)) }
}

/// A web view that can carry the app's Botflow session, so pages of the
/// website that need a signed-in person just work.
struct WebView: UIViewRepresentable {
    var url: URL
    @ObservedObject var model: WebViewModel
    /// Copy the Botflow session cookie in before loading (only for Botflow's own pages).
    var signedIn = false
    /// Changes when the page should reload (for example after an agent's turn).
    var reloadToken = 0
    var mobileUserAgent = true

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        #if DEBUG
        webView.isInspectable = true
        #endif
        model.webView = webView
        context.coordinator.observe(webView)
        context.coordinator.lastToken = reloadToken
        context.coordinator.lastURL = url
        load(webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastURL != url {
            context.coordinator.lastURL = url
            context.coordinator.lastToken = reloadToken
            load(webView)
        } else if context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            webView.reload()
        }
    }

    private func load(_ webView: WKWebView) {
        guard url.scheme == "http" || url.scheme == "https" else { return }
        let request = URLRequest(url: url)
        guard signedIn, url.host == AppConfig.baseURL.host else {
            webView.load(request)
            return
        }
        let cookies = APIClient.shared.sessionCookies
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let group = DispatchGroup()
        for cookie in cookies {
            group.enter()
            store.setCookie(cookie) { group.leave() }
        }
        group.notify(queue: .main) { webView.load(request) }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let model: WebViewModel
        var lastToken = 0
        var lastURL: URL?
        private var observations: [NSKeyValueObservation] = []

        init(model: WebViewModel) { self.model = model }

        func observe(_ webView: WKWebView) {
            observations = [
                webView.observe(\.estimatedProgress) { [weak self] view, _ in
                    Task { @MainActor in self?.model.progress = view.estimatedProgress }
                },
                webView.observe(\.isLoading) { [weak self] view, _ in
                    Task { @MainActor in self?.model.isLoading = view.isLoading }
                },
                webView.observe(\.canGoBack) { [weak self] view, _ in
                    Task { @MainActor in self?.model.canGoBack = view.canGoBack }
                },
                webView.observe(\.canGoForward) { [weak self] view, _ in
                    Task { @MainActor in self?.model.canGoForward = view.canGoForward }
                },
                webView.observe(\.url) { [weak self] view, _ in
                    Task { @MainActor in self?.model.currentURL = view.url }
                },
                webView.observe(\.title) { [weak self] view, _ in
                    Task { @MainActor in self?.model.title = view.title }
                },
            ]
        }

        // target="_blank" links open in the same view instead of nowhere.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
            return nil
        }
    }
}

/// A page of the Botflow website (or anywhere else) in a sheet, with the
/// minimum of browser controls.
struct WebSheet: View {
    var title: String
    var url: URL
    var signedIn = true
    @StateObject private var model = WebViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WebView(url: url, model: model, signedIn: signedIn)
                .ignoresSafeArea(edges: .bottom)
                .overlay(alignment: .top) {
                    if model.isLoading {
                        ProgressView(value: model.progress)
                            .progressViewStyle(.linear)
                            .tint(Sand.accent)
                    }
                }
                .background(Sand.bg)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button { model.reload() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        ShareLink(item: model.currentURL ?? url) { Label("Share", systemImage: "square.and.arrow.up") }
                    }
                }
        }
    }
}
