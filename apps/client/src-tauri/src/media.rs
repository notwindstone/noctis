//! "Lock screen controls" on the desktop.
//!
//! On Windows the webview itself publishes what it plays to the system media transport
//! controls (SMTC: the volume flyout, the lock screen), whatever the page does. The only way
//! to stop that is to start the webview without the feature, which can't change while it
//! runs: the setting is a flag file read at startup (`set_media_controls` writes it), and a
//! change takes effect after a restart. Without SMTC the hardware media keys are no longer
//! handled by the webview, so Noctis registers them itself as global shortcuts and reports
//! presses as `media-key` events (`play-pause`, `next`, `previous`, `stop`).
//!
//! Browser arguments must be the same for every webview that shares a profile, so the sign-in
//! windows (auth.rs) take the same ones.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::launch::LaunchOptions;

const FLAG: &str = "media-controls-off";

/// Whether this run started without the webview's media controls.
static DISABLED: AtomicBool = AtomicBool::new(false);

/// What wry passes by default (it's replaced when we pass our own), plus the media features off.
const DISABLED_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,HardwareMediaKeyHandling,MediaSessionService,GlobalMediaControls,GlobalMediaControlsForCast,GlobalMediaControlsUpdatedUI";

fn flag_path(app: &AppHandle, options: &LaunchOptions) -> Option<PathBuf> {
    let base = match &options.data_dir {
        Some(dir) => dir.clone(),
        None => app.path().app_local_data_dir().ok()?,
    };
    Some(base.join(FLAG))
}

/// Read the setting; call before any window is made.
pub fn init(app: &AppHandle, options: &LaunchOptions) {
    let off = flag_path(app, options).is_some_and(|path| path.is_file());
    DISABLED.store(off && cfg!(windows), Ordering::Relaxed);
}

/// Extra browser arguments for a window, if the media controls are off.
pub fn browser_args() -> Option<&'static str> {
    DISABLED.load(Ordering::Relaxed).then_some(DISABLED_ARGS)
}

/// Take over the media keys (when the webview doesn't handle them any more).
pub fn register_keys(app: &AppHandle) {
    if !DISABLED.load(Ordering::Relaxed) {
        return;
    }
    let keys = [
        (Code::MediaPlayPause, "play-pause"),
        (Code::MediaTrackNext, "next"),
        (Code::MediaTrackPrevious, "previous"),
        (Code::MediaStop, "stop"),
    ];
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Some((_, action)) = keys.iter().find(|(code, _)| *shortcut == Shortcut::new(None, *code)) {
                let _ = app.emit("media-key", *action);
            }
        })
        .build();
    if app.plugin(plugin).is_err() {
        return;
    }
    for code in [Code::MediaPlayPause, Code::MediaTrackNext, Code::MediaTrackPrevious, Code::MediaStop] {
        // Another app may hold a key; the others still work.
        let _ = app.global_shortcut().register(Shortcut::new(None, code));
    }
}

/// Remember the setting for the next start. Resolves to whether this run already matches it
/// (false: a restart is needed).
#[tauri::command]
pub fn set_media_controls(app: AppHandle, options: tauri::State<'_, LaunchOptions>, enabled: bool) -> Result<bool, String> {
    let path = flag_path(&app, &options).ok_or("No place to keep the setting")?;
    if enabled {
        let _ = std::fs::remove_file(&path);
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&path, b"").map_err(|error| error.to_string())?;
    }
    // Only Windows has anything to switch off.
    Ok(!cfg!(windows) || enabled != DISABLED.load(Ordering::Relaxed))
}
