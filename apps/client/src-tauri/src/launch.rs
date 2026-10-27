//! Command-line options and where the app keeps its data.
//!
//! - `--no-plugins`: start without any plugin (nothing is switched off for good).
//! - `--new-instance`: don't hand over to a Noctis that's already running, and use a fresh,
//!   throwaway profile, so a test run sees (and leaves) nothing of the real one.
//! - `--data-dir <path>`: keep everything there.
//! - Portable: with a `portable.txt` file or a `data` folder next to the executable, data
//!   lives in `data` beside it. The path is taken from the executable, never from the
//!   working directory. On Windows the user-profile variables are pointed there too, so
//!   nothing the webview or the OS libraries do lands in the real profile.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptions {
    pub no_plugins: bool,
    pub new_instance: bool,
    #[serde(skip)]
    pub data_dir: Option<PathBuf>,
    /// Data is next to the executable.
    pub portable: bool,
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|dir| dir.to_path_buf())
}

pub fn parse() -> LaunchOptions {
    let mut options = LaunchOptions::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--no-plugins" => options.no_plugins = true,
            "--new-instance" => options.new_instance = true,
            "--data-dir" => options.data_dir = args.next().map(PathBuf::from),
            other => {
                if let Some(path) = other.strip_prefix("--data-dir=") {
                    options.data_dir = Some(PathBuf::from(path));
                }
            }
        }
    }

    if options.data_dir.is_none() {
        if let Some(dir) = exe_dir() {
            if dir.join("portable.txt").is_file() || dir.join("data").is_dir() {
                options.data_dir = Some(dir.join("data"));
                options.portable = true;
            }
        }
    }
    if options.new_instance && options.data_dir.is_none() {
        // Unique per process; removed again when the app exits.
        options.data_dir = Some(std::env::temp_dir().join(format!("noctis-instance-{}", std::process::id())));
    }
    options
}

/// Where the webview keeps its profile, if it isn't the default place.
pub fn webview_dir(options: &LaunchOptions) -> Option<PathBuf> {
    options.data_dir.as_ref().map(|dir| dir.join("webview"))
}

/// Windows: make the profile folders live under the data directory, like a portable app
/// launcher would, before anything reads them.
pub fn redirect_profile(options: &LaunchOptions) {
    let Some(data) = &options.data_dir else { return };
    let _ = std::fs::create_dir_all(data);
    #[cfg(windows)]
    {
        let profile = data.join("profile");
        let roaming = profile.join("AppData").join("Roaming");
        let local = profile.join("AppData").join("Local");
        for dir in [&roaming, &local, &profile.join("Desktop"), &profile.join("Documents"), &profile.join("Downloads")] {
            let _ = std::fs::create_dir_all(dir);
        }
        std::env::set_var("USERPROFILE", &profile);
        std::env::set_var("APPDATA", &roaming);
        std::env::set_var("LOCALAPPDATA", &local);
        if let Some(webview) = webview_dir(options) {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", webview);
        }
    }
}

#[tauri::command]
pub fn launch_options(options: tauri::State<'_, LaunchOptions>) -> LaunchOptions {
    options.inner().clone()
}
