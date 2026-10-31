//! Sign-in windows, the desktop counterpart of the Android app's login WebViews.
//!
//! Each opens a throwaway (incognito) webview on a site's own sign-in page, so nothing
//! is left behind: what the plugin needs is handed back, and signing out needs no cleanup.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(0);

fn parse(url: &str) -> Result<Url, String> {
    let url = Url::parse(url).map_err(|e| format!("{url}: {e}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!("Only http(s) pages can be opened here, not {other}:")),
    }
}

fn open_window(app: &AppHandle, url: Url, title: Option<String>) -> Result<tauri::WebviewWindowBuilder<'_, tauri::Wry, AppHandle>, String> {
    let label = format!("auth-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title.unwrap_or_else(|| "Sign in".into()))
        .inner_size(520.0, 760.0)
        .incognito(true);
    // A webview sharing the profile must start with the same browser arguments as the main one.
    #[cfg(windows)]
    let builder = match crate::media::browser_args() {
        Some(args) => builder.additional_browser_args(args),
        None => builder,
    };
    Ok(builder)
}

/// Opens `url` and resolves with the first address starting with `redirect`, which is
/// caught before it loads, so any redirect URI works without ever having to resolve.
#[tauri::command]
pub async fn open_auth(app: AppHandle, url: String, redirect: String, title: Option<String>) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));

    let navigation_sender = sender.clone();
    let window = open_window(&app, parse(&url)?, title)?
        .on_navigation(move |next| {
            if next.as_str().starts_with(&redirect) {
                if let Some(sender) = navigation_sender.lock().unwrap().take() {
                    let _ = sender.send(Ok(next.to_string()));
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    watch_closed(&window, sender);
    settle(&window, receiver, Duration::from_secs(10 * 60)).await
}

/// Reports a closed window as a failure (once something else hasn't already resolved).
fn watch_closed<T: Send + 'static>(window: &WebviewWindow, sender: Arc<Mutex<Option<oneshot::Sender<Result<T, String>>>>>) {
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(sender) = sender.lock().unwrap().take() {
                let _ = sender.send(Err("The sign-in window was closed".into()));
            }
        }
    });
}

/// Waits for what a window resolves with, then always closes it.
async fn settle<T>(window: &WebviewWindow, mut receiver: oneshot::Receiver<Result<T, String>>, limit: Duration) -> Result<T, String> {
    let result = receive(&mut receiver, limit).await;
    let _ = window.destroy();
    result
}

async fn receive<T>(receiver: &mut oneshot::Receiver<Result<T, String>>, limit: Duration) -> Result<T, String> {
    match tokio::time::timeout(limit, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The sign-in window was closed".into()),
        Err(_) => Err("Sign-in timed out".into()),
    }
}

#[derive(Serialize)]
pub struct CookieLogin {
    value: String,
    /// Every cookie on `cookie_url`, as a Cookie header (httpOnly ones included).
    cookies: String,
}

/// Opens a site's sign-in page and resolves once it sets the cookie named `cookie`
/// (SoundCloud's `oauth_token`), with its value and the site's other cookies.
#[tauri::command]
pub async fn open_cookie_login(
    app: AppHandle,
    url: String,
    cookie_url: String,
    cookie: String,
    title: Option<String>,
) -> Result<CookieLogin, String> {
    let cookie_url = parse(&cookie_url)?;
    let window = open_window(&app, parse(&url)?, title)?.build().map_err(|e| e.to_string())?;
    let result = wait_for_cookie(&app, &window, cookie_url, &cookie).await;
    let _ = window.destroy();
    result
}

/// Polls the window's cookie jar until `cookie` is set (10 minutes at most).
async fn wait_for_cookie(app: &AppHandle, window: &WebviewWindow, cookie_url: Url, cookie: &str) -> Result<CookieLogin, String> {
    let label = window.label().to_string();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10 * 60);
    loop {
        if app.get_webview_window(&label).is_none() {
            return Err("The sign-in window was closed".to_string());
        }
        if tokio::time::Instant::now() > deadline {
            return Err("Sign-in timed out".to_string());
        }
        if let Ok(cookies) = window.cookies_for_url(cookie_url.clone()) {
            if let Some(found) = cookies.iter().find(|c| c.name() == cookie && !c.value().is_empty()) {
                return Ok(CookieLogin {
                    value: found.value().to_string(),
                    cookies: cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; "),
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
}

#[derive(Serialize)]
pub struct WebResponse {
    url: String,
    body: String,
    /// With a login: every cookie on its `login_cookie_url`, as a Cookie header (plugins
    /// replay them to renew the session later).
    cookies: Option<String>,
}

/// Pages can't call into the app, so a captured response leaves as a navigation to this
/// never-resolving host (`/<nonce>?u=<url>&b=<body>`), cancelled in `on_navigation`.
const CAPTURE_HOST: &str = "noctis-capture.invalid";

/// Spotify's own code does the handshake: see `capture_hook.js`.
const CAPTURE_HOOK: &str = include_str!("capture_hook.js");

/// Per-call secret in the marker, so a stray navigation isn't mistaken for the result.
/// (Page scripts could read it from the wrapped fetch; the result only goes back to the
/// plugin that asked, which validates it.)
fn nonce() -> String {
    let random = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", random(), random())
}

/// Opens `url` and resolves with the first response its own scripts fetch whose URL
/// contains `pattern`, however the page handles it (the desktop half of
/// `Noctis.libs.auth.captureWebResponse`). With a `login_*` trio, the same window first
/// shows the site's sign-in until `login_cookie` appears, then loads `url` signed in.
/// `fallback_url`, if the hook caught nothing in two thirds of `timeout_ms`, is loaded
/// directly and its page text is the result. The window stays visible throughout.
#[tauri::command]
pub async fn capture_web_response(
    app: AppHandle,
    url: String,
    pattern: String,
    title: Option<String>,
    timeout_ms: Option<u64>,
    fallback_url: Option<String>,
    login_url: Option<String>,
    login_cookie_url: Option<String>,
    login_cookie: Option<String>,
) -> Result<WebResponse, String> {
    let start = parse(&url)?;
    let fallback = fallback_url.as_deref().map(parse).transpose()?;
    let login = match (login_url, login_cookie_url, login_cookie) {
        (Some(url), Some(cookie_url), Some(cookie)) => Some((parse(&url)?, parse(&cookie_url)?, cookie)),
        _ => None,
    };
    let limit = Duration::from_millis(timeout_ms.unwrap_or(30_000));

    let nonce = nonce();
    let script = CAPTURE_HOOK
        .replace("__MATCH__", &serde_json::to_string(&pattern).map_err(|e| e.to_string())?)
        .replace("__MARKER__", &serde_json::to_string(&format!("https://{CAPTURE_HOST}/{nonce}")).map_err(|e| e.to_string())?);

    let (sender, receiver) = oneshot::channel::<Result<WebResponse, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    // Results are ignored until the page that is meant to produce one is loading: before
    // that, the sign-in pages' own token requests would be anonymous ones.
    let armed = Arc::new(AtomicBool::new(login.is_none()));
    let reading_page = Arc::new(AtomicBool::new(false));

    let navigation_sender = sender.clone();
    let navigation_armed = armed.clone();
    let path = format!("/{nonce}");
    let marker = format!("https://{CAPTURE_HOST}/{nonce}");
    let page_flag = reading_page.clone();
    let page_host = fallback.as_ref().and_then(|u| u.host_str()).map(str::to_string);
    let first = login.as_ref().map(|(url, _, _)| url.clone()).unwrap_or_else(|| start.clone());
    let window = open_window(&app, first, title.or(Some("Talking to the service…".into())))?
        .initialization_script(script)
        .on_navigation(move |next| {
            if next.host_str() != Some(CAPTURE_HOST) {
                return true;
            }
            if next.path() == path && navigation_armed.load(Ordering::Relaxed) {
                let (mut found, mut body) = (None, None);
                for (key, value) in next.query_pairs() {
                    match key.as_ref() {
                        "u" => found = Some(value.into_owned()),
                        "b" => body = Some(value.into_owned()),
                        _ => {}
                    }
                }
                if let (Some(url), Some(body)) = (found, body) {
                    if let Some(sender) = navigation_sender.lock().unwrap().take() {
                        let _ = sender.send(Ok(WebResponse { url, body, cookies: None }));
                    }
                }
            }
            false
        })
        .on_page_load(move |window, payload| {
            // The fallback page is plain JSON: hand its text out the same way.
            if payload.event() == PageLoadEvent::Finished
                && page_flag.load(Ordering::Relaxed)
                && payload.url().host_str().map(str::to_string) == page_host
            {
                let _ = window.eval(format!(
                    "if (!window.__noctisRead && document.body) {{ window.__noctisRead = 1; \
                     location.href = {marker:?} + '?u=' + encodeURIComponent(location.href) + '&b=' + encodeURIComponent(document.body.innerText) }}"
                ));
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    watch_closed(&window, sender);

    let mut jar = None;
    if let Some((_, cookie_url, cookie)) = login {
        jar = Some(cookie_url.clone());
        if let Err(error) = wait_for_cookie(&app, &window, cookie_url, &cookie).await {
            let _ = window.destroy();
            return Err(error);
        }
        // Load the page signed in (it may already have started, with its answer discarded).
        armed.store(true, Ordering::Relaxed);
        if let Err(error) = window.navigate(start) {
            let _ = window.destroy();
            return Err(error.to_string());
        }
    }

    let mut receiver = receiver;
    let mut outcome = match fallback {
        None => receive(&mut receiver, limit).await,
        Some(fallback) => match tokio::time::timeout(limit * 2 / 3, &mut receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The sign-in window was closed".into()),
            Err(_) => {
                reading_page.store(true, Ordering::Relaxed);
                match window.navigate(fallback) {
                    Ok(()) => receive(&mut receiver, limit / 3).await,
                    Err(error) => Err(error.to_string()),
                }
            }
        },
    };
    if let (Ok(response), Some(jar)) = (&mut outcome, jar) {
        if let Ok(cookies) = window.cookies_for_url(jar) {
            response.cookies = Some(cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; "));
        }
    }
    let _ = window.destroy();
    outcome
}
