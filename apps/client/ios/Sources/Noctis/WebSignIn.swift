import Capacitor
import UIKit
import WebKit

/// Safari's user agent: Google (and "Continue with Google" elsewhere) refuses web views
/// that don't look like a browser.
private let safariUserAgent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
private let desktopUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"

/// Cookies a request to `url` would carry, httpOnly ones included (unlike document.cookie).
private func cookies(for url: URL) async -> [HTTPCookie] {
    guard let host = url.host else { return [] }
    let all = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
    return all.filter { cookie in
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        return host == domain || host.hasSuffix("." + domain)
    }
}

private func header(_ cookies: [HTTPCookie]) -> String {
    cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
}

/**
 Three kinds of sign-in in a web view, as in LoginActivity.java:

 - `.youtube`: Google sign-in for YouTube Music. Load the ServiceLogin page, wait until it
   lands on music.youtube.com, then return that origin's cookies.
 - `.oauth`: load the authorization page and return the first URL that starts with the
   redirect URI, without loading it. The redirect never has to resolve.
 - `.cookie`: load a site's own sign-in and return a cookie's value as soon as the site
   sets it. Single-page apps never navigate anywhere a redirect could catch, so the cookie
   jar is checked every second.
 */
final class SignInController: UIViewController, WKNavigationDelegate {
    enum Mode {
        case youtube
        case oauth(url: URL, redirect: String)
        case cookie(url: URL, cookieURL: URL, name: String)
    }

    private static let musicOrigin = URL(string: "https://music.youtube.com")!
    private static let loginURL = URL(
        string: "https://accounts.google.com/ServiceLogin?ytbTemplate=1&service=youtube&continue=https%3A%2F%2Fmusic.youtube.com")!

    private let mode: Mode
    private let heading: String
    private let completion: (Result<[String: Any], Error>) -> Void
    private let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    private var finished = false
    private var poll: Timer?

    struct Cancelled: Error {}

    init(mode: Mode, title: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.mode = mode
        self.heading = title
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = heading
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.finish(.failure(Cancelled())) })

        webView.customUserAgent = safariUserAgent
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        switch mode {
        case .youtube:
            webView.load(URLRequest(url: Self.loginURL))
        case .oauth(let url, _):
            webView.load(URLRequest(url: url))
        case .cookie(let url, _, _):
            webView.load(URLRequest(url: url))
            poll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { await self?.checkCookie() }
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Dismissed by the system rather than by us.
        if isBeingDismissed || navigationController?.isBeingDismissed == true { finish(.failure(Cancelled())) }
    }

    private func finish(_ result: Result<[String: Any], Error>) {
        guard !finished else { return }
        finished = true
        poll?.invalidate()
        webView.stopLoading()
        let done = completion
        (navigationController ?? self).dismiss(animated: true) { done(result) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if case .oauth(_, let redirect) = mode, let url = action.request.url, url.absoluteString.hasPrefix(redirect) {
            decisionHandler(.cancel)
            finish(.success(["url": url.absoluteString]))
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard case .youtube = mode, let url = webView.url, url.host == Self.musicOrigin.host else { return }
        Task { await finishYouTube() }
    }

    private func finishYouTube() async {
        guard !finished else { return }
        let jar = await cookies(for: Self.musicOrigin)
        guard jar.contains(where: { $0.name == "SAPISID" }) else { return }
        // visitorData keeps recommendations consistent with what the signed-in web client sees.
        let visitor = try? await webView.evaluateJavaScript(
            "(function(){try{return window.yt&&yt.config_?yt.config_.VISITOR_DATA||'':''}catch(e){return ''}})()") as? String
        finish(.success(["cookie": header(jar), "visitorData": visitor ?? ""]))
    }

    private func checkCookie() async {
        guard !finished, case .cookie(_, let cookieURL, let name) = mode else { return }
        let jar = await cookies(for: cookieURL)
        // A cookie left from before counts too.
        if let match = jar.first(where: { $0.name == name && !$0.value.isEmpty }) {
            finish(.success(["value": match.value, "cookies": header(jar)]))
        }
    }
}

/**
 Loads a page in a hidden web view and reports the body of the first network response whose
 URL contains `match` (see WebCapture.java): plugins let a site's own code do its session
 handshake instead of re-implementing it. It shares the app's cookie store, so a session
 signed in with openAuth carries over. fetch and XHR are wrapped before the page's scripts run.
 */
final class WebCapture: NSObject, WKScriptMessageHandler {
    private let webView: WKWebView
    private var done = false
    private let completion: (Result<(url: String, body: String), Error>) -> Void

    struct TimedOut: Error {}

    init(url: URL, match: String, userAgent: String?, timeout: TimeInterval, host: UIView,
         completion: @escaping (Result<(url: String, body: String), Error>) -> Void) {
        let configuration = WKWebViewConfiguration()
        let quoted = String(data: (try? JSONSerialization.data(withJSONObject: [match])) ?? Data(), encoding: .utf8)!.dropFirst().dropLast()
        let script = """
        (function(){var m=\(quoted);
        function rep(u,t){try{window.webkit.messageHandlers.NoctisCapture.postMessage({url:String(u),body:String(t)})}catch(e){}}
        var f=window.fetch;
        if(f){window.fetch=function(i,o){var p=f.apply(this,arguments);
        try{var u=i instanceof Request?i.url:String(i);
        if(u.indexOf(m)!==-1){p.then(function(r){r.clone().text().then(function(t){if(r.ok)rep(u,t)})}).catch(function(){})}}catch(e){}
        return p}}
        var O=XMLHttpRequest.prototype.open,S=XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open=function(a,u){this.__nu=u;return O.apply(this,arguments)};
        XMLHttpRequest.prototype.send=function(){var x=this;
        if(String(x.__nu||'').indexOf(m)!==-1){x.addEventListener('load',function(){if(x.status>=200&&x.status<300)rep(x.__nu,x.responseText)})}
        return S.apply(this,arguments)};
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        // A web view that isn't on screen gets its timers throttled; a 1pt invisible one doesn't.
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        self.completion = completion
        super.init()
        configuration.userContentController.add(self, name: "NoctisCapture")
        webView.customUserAgent = userAgent ?? desktopUserAgent
        webView.alpha = 0
        webView.isUserInteractionEnabled = false
        host.addSubview(webView)
        webView.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finish(.failure(TimedOut())) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: String], let url = body["url"], let text = body["body"] else { return }
        finish(.success((url, text)))
    }

    private func finish(_ result: Result<(url: String, body: String), Error>) {
        guard !done else { return }
        done = true
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "NoctisCapture")
        webView.removeFromSuperview()
        completion(result)
    }
}

extension NoctisPlugin {
    private func present(_ mode: SignInController.Mode, title: String, call: CAPPluginCall) {
        DispatchQueue.main.async {
            let controller = SignInController(mode: mode, title: title) { result in
                switch result {
                case .success(let data): call.resolve(data)
                case .failure: call.reject("Sign-in was cancelled", "CANCELLED")
                }
            }
            let navigation = UINavigationController(rootViewController: controller)
            // Closing is the Close button's job, so a half-finished sign-in isn't swiped away.
            navigation.isModalInPresentation = true
            self.bridge?.viewController?.present(navigation, animated: true)
        }
    }

    @objc func openLogin(_ call: CAPPluginCall) {
        present(.youtube, title: "Sign in to YouTube Music", call: call)
    }

    /// OAuth for plugins: opens `url`, resolves with the URL it redirected to (starting with `redirect`).
    @objc func openAuth(_ call: CAPPluginCall) {
        guard let url = call.getString("url").flatMap(URL.init(string:)), let redirect = call.getString("redirect"),
              ["http", "https"].contains(url.scheme) else {
            call.reject("url and redirect are required")
            return
        }
        present(.oauth(url: url, redirect: redirect), title: call.getString("title") ?? "Sign in", call: call)
    }

    /// A site's own sign-in for plugins: resolves with the value of the cookie `cookie` on
    /// `cookieUrl` once the site sets it, plus every cookie on `cookieUrl` as a Cookie header.
    @objc func openCookieLogin(_ call: CAPPluginCall) {
        guard let url = call.getString("url").flatMap(URL.init(string:)), url.scheme == "https",
              let cookieURL = call.getString("cookieUrl").flatMap(URL.init(string:)), cookieURL.scheme == "https",
              let name = call.getString("cookie") else {
            call.reject("https url and cookieUrl, and a cookie name, are required")
            return
        }
        present(.cookie(url: url, cookieURL: cookieURL, name: name), title: call.getString("title") ?? "Sign in", call: call)
    }

    private static var captures: [ObjectIdentifier: WebCapture] = [:]

    @objc func captureResponse(_ call: CAPPluginCall) {
        guard let url = call.getString("url").flatMap(URL.init(string:)), url.scheme == "https", let match = call.getString("match") else {
            call.reject("An https url and a match are required")
            return
        }
        let timeout = TimeInterval(call.getInt("timeoutMs") ?? 30000) / 1000
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController?.view else {
                call.reject("The app isn't ready")
                return
            }
            var capture: WebCapture?
            capture = WebCapture(url: url, match: match, userAgent: call.getString("userAgent"), timeout: timeout, host: host) { result in
                switch result {
                case .success(let response): call.resolve(["url": response.url, "body": response.body])
                case .failure: call.reject("Timed out", "TIMEOUT")
                }
                // The web view is thrown away along with its capture.
                if let capture { Self.captures[ObjectIdentifier(capture)] = nil }
            }
            Self.captures[ObjectIdentifier(capture!)] = capture
        }
    }

    /// Remove every cookie, or with `url`, only the cookies visible to that URL (one site's session).
    @objc func clearCookies(_ call: CAPPluginCall) {
        let url = call.getString("url").flatMap(URL.init(string:))
        Task { @MainActor in
            let store = WKWebsiteDataStore.default()
            if let url {
                for cookie in await cookies(for: url) { await store.httpCookieStore.deleteCookie(cookie) }
            } else {
                await store.removeData(ofTypes: [WKWebsiteDataTypeCookies], modifiedSince: .distantPast)
            }
            call.resolve()
        }
    }
}
