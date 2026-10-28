//! Command-line options and where the app keeps its data.
//!
//! - `--no-plugins`: start without any plugin (nothing is switched off for good).
//! - `--new-window`: open another window instead of handing over to a Noctis that's already
//!   running. It's the same profile; nothing else changes.
//! - `--help` (`-h`, `/?`): print this list and exit.
//! - `--data-dir <path>`: keep everything there. A different data directory is a different
//!   profile, so it is its own instance too (no hand-over to the one using the default).
//! - Portable: with a `portable.txt` file or a `data` folder next to the executable, data
//!   lives in `data` beside it. The path is taken from the executable, never from the
//!   working directory.
//!
//! Everything Noctis stores is under the data directory (the webview profile, and nothing
//! from plugins: they have no file access of their own). The Windows profile variables
//! (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`) are left alone, as the file dialogs and the
//! shell read them.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptions {
    pub no_plugins: bool,
    pub new_window: bool,
    #[serde(skip)]
    pub data_dir: Option<PathBuf>,
    /// Data is next to the executable.
    pub portable: bool,
    /// `--data-dir` was given: a profile of its own.
    #[serde(skip)]
    pub own_profile: bool,
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|dir| dir.to_path_buf())
}

const HELP: &str = "Noctis, a music client shaped by plugins

Usage: Noctis [options]

Options:
  --no-plugins        Start without any plugin (nothing is switched off for good)
  --new-window        Open another window instead of handing over to a running Noctis
                      (same profile)
  --data-dir <path>   Keep all data in <path>. A different data directory is a different
                      profile, so it never hands over to the running Noctis
  -h, --help, /?      Show this help and exit

Portable mode: put a portable.txt file or a data folder next to the executable and all
data is kept in the data folder beside it.
";

/// Print `text` where the person who started Noctis can see it. The Windows build has no
/// console of its own (it's a window app), so it borrows the one it was started from.
fn print_to_console(text: &str) {
    #[cfg(windows)]
    {
        use std::io::Write;
        #[link(name = "kernel32")]
        extern "system" {
            fn AttachConsole(process: u32) -> i32;
        }
        // ATTACH_PARENT_PROCESS
        let attached = unsafe { AttachConsole(u32::MAX) } != 0;
        if attached {
            if let Ok(mut console) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
                let _ = write!(console, "\r\n{}", text.replace('\n', "\r\n"));
                return;
            }
        }
    }
    print!("{text}");
}

pub fn parse() -> LaunchOptions {
    if std::env::args().skip(1).any(|arg| matches!(arg.as_str(), "--help" | "-h" | "/?")) {
        print_to_console(HELP);
        std::process::exit(0);
    }
    let mut options = LaunchOptions::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--no-plugins" => options.no_plugins = true,
            "--new-window" => options.new_window = true,
            "--data-dir" => options.data_dir = args.next().map(PathBuf::from),
            other => {
                if let Some(path) = other.strip_prefix("--data-dir=") {
                    options.data_dir = Some(PathBuf::from(path));
                }
            }
        }
    }

    options.own_profile = options.data_dir.is_some();
    if options.data_dir.is_none() {
        if let Some(dir) = exe_dir() {
            if dir.join("portable.txt").is_file() || dir.join("data").is_dir() {
                options.data_dir = Some(dir.join("data"));
                options.portable = true;
            }
        }
    }
    options
}

/// Where the webview keeps its profile, if it isn't the default place.
pub fn webview_dir(options: &LaunchOptions) -> Option<PathBuf> {
    options.data_dir.as_ref().map(|dir| dir.join("webview"))
}

/// Create the data directory and, on Windows, point the webview's profile into it.
pub fn prepare(options: &LaunchOptions) {
    let Some(data) = &options.data_dir else { return };
    let _ = std::fs::create_dir_all(data);
    #[cfg(windows)]
    if let Some(webview) = webview_dir(options) {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", webview);
    }
}

#[tauri::command]
pub fn launch_options(options: tauri::State<'_, LaunchOptions>) -> LaunchOptions {
    options.inner().clone()
}
