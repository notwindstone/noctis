//! Sign-in windows, the desktop counterpart of the Android app's login WebViews.
//!
//! Each opens a throwaway (incognito) webview on a site's own sign-in page, so nothing
//! is left behind: what the plugin needs is handed back, and signing out needs no cleanup.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
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
    Ok(WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title.unwrap_or_else(|| "Sign in".into()))
        .inner_size(520.0, 760.0)
        .incognito(true))
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

    let closed_sender = sender.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(sender) = closed_sender.lock().unwrap().take() {
                let _ = sender.send(Err("The sign-in window was closed".into()));
            }
        }
    });

    let result = tokio::time::timeout(Duration::from_secs(10 * 60), receiver).await;
    let _ = window.destroy();
    match result {
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
    let label = window.label().to_string();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10 * 60);
    let result = loop {
        if app.get_webview_window(&label).is_none() {
            break Err("The sign-in window was closed".to_string());
        }
        if tokio::time::Instant::now() > deadline {
            break Err("Sign-in timed out".to_string());
        }
        if let Ok(cookies) = window.cookies_for_url(cookie_url.clone()) {
            if let Some(found) = cookies.iter().find(|c| c.name() == cookie && !c.value().is_empty()) {
                break Ok(CookieLogin {
                    value: found.value().to_string(),
                    cookies: cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; "),
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    };
    let _ = window.destroy();
    result
}
