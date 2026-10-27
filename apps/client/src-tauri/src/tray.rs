//! The system tray: an icon with a menu, and "minimize to tray" (closing the window hides
//! it). The web app owns the settings and the menu's contents (plugins add items); this
//! side just shows them and reports clicks back as events:
//!
//! - `tray-click`: the icon was clicked with the left button. The app decides what happens
//!   (plugins can take it over), and calls `show_main_window` if nothing did.
//! - `tray-menu`: a menu item was chosen; the payload is its id. "Show" and "Quit" are
//!   handled here, the rest (play/pause, previous, next, plugins' items) by the app.

use std::sync::{atomic::AtomicBool, atomic::Ordering, Mutex};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

const TRAY_ID: &str = "noctis";

#[derive(Default)]
pub struct TrayState {
    /// Closing the window hides it instead of quitting.
    pub minimize_on_close: AtomicBool,
    pub items: Mutex<Vec<TrayItem>>,
}

#[derive(Clone, Deserialize)]
pub struct TrayItem {
    pub id: String,
    pub label: String,
}

fn build_menu(app: &AppHandle, items: &[TrayItem], playing: bool) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "__show", "Show Noctis", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "__toggle", if playing { "Pause" } else { "Play" }, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "__previous", "Previous", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "__next", "Next", true, None::<&str>)?)?;
    if !items.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for item in items {
            menu.append(&MenuItem::with_id(app, &item.id, &item.label, true, None::<&str>)?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "__quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Show or hide the tray icon and refresh its menu. Called by the app whenever the setting
/// or the plugins' items change.
#[tauri::command]
pub fn set_tray(app: AppHandle, state: tauri::State<'_, TrayState>, enabled: bool, playing: bool, items: Vec<TrayItem>) -> Result<(), String> {
    state.minimize_on_close.store(enabled, Ordering::Relaxed);
    *state.items.lock().unwrap() = items.clone();

    if !enabled {
        app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }

    let menu = build_menu(&app, &items, playing).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Noctis")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "__show" => show_window(app),
            "__quit" => app.exit(0),
            id => {
                let _ = app.emit("tray-menu", id.to_string());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let _ = tray.app_handle().emit("tray-click", ());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(&app).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    show_window(&app);
}
