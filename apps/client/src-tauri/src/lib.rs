mod auth;
mod files;
mod launch;
mod media;
mod tray;

use std::sync::atomic::Ordering;

use tauri::{Manager, WebviewWindowBuilder, WindowEvent};

/// The desktop shell is thin on purpose: the app is the same Vue build as the browser and
/// Android ones. What the shell adds is what a webview can't do — requests without CORS
/// (plugin-http), system notifications, native dialogs, opening links externally, and
/// sign-in windows (auth.rs) — plus launch options and a portable mode (launch.rs) and the
/// system tray (tray.rs).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let options = launch::parse();
    launch::prepare(&options);

    let mut builder = tauri::Builder::default();
    // Opening Noctis again (or a .noctis file with it) focuses the running window, unless
    // this one was asked for a new window or has a profile of its own (`--data-dir`).
    if !options.new_window && !options.own_profile {
        // (Also brings it back from the tray.)
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_window(app)));
    }

    let webview_dir = launch::webview_dir(&options);

    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(options)
        .manage(tray::TrayState::default())
        // With "minimize to tray" on, closing the main window hides it; Quit in the tray menu exits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && window.state::<tray::TrayState>().minimize_on_close.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            auth::open_auth,
            auth::open_cookie_login,
            auth::capture_web_response,
            files::offline_delete,
            files::offline_dir,
            files::offline_move,
            files::offline_read,
            files::offline_write,
            launch::launch_options,
            media::set_media_controls,
            tray::set_tray,
            tray::show_main_window
        ])
        .setup(move |app| {
            // The window is made here (not from the config alone) so its profile can be elsewhere.
            let config = app.config().app.windows.first().cloned().expect("a window in tauri.conf.json");
            media::init(app.handle(), &app.state::<launch::LaunchOptions>());
            let mut window = WebviewWindowBuilder::from_config(app.handle(), &config)?;
            #[cfg(windows)]
            if let Some(args) = media::browser_args() {
                window = window.additional_browser_args(args);
            }
            if let Some(dir) = &webview_dir {
                let _ = std::fs::create_dir_all(dir);
                window = window.data_directory(dir.clone());
            }
            let window = window.build()?;
            let _ = window.set_focus();
            media::register_keys(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Noctis")
        .run(|_app, _event| {
            // Clicking the Dock icon while the window is hidden (closed to the tray) brings it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
                tray::show_window(_app);
            }
        });
}
