//! Downloaded and cached songs as ordinary files (desktop).
//!
//! They live under `<data directory>/music` (the portable / `--data-dir` folder, else the
//! app's local data folder), in `downloads` and `cache`, named after the song. The webview
//! only ever names a path relative to that folder: nothing outside it can be touched, so a
//! plugin gets no more file access than it has through these calls.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

use crate::launch::LaunchOptions;

fn root(app: &AppHandle, options: &LaunchOptions) -> Result<PathBuf, String> {
    let base = match &options.data_dir {
        Some(dir) => dir.clone(),
        None => app.path().app_local_data_dir().map_err(|error| error.to_string())?,
    };
    Ok(base.join("music"))
}

/// A path inside the music folder: plain names only, no `..`, no drive or root.
fn inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty() || path.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("That path isn't allowed".into());
    }
    Ok(root.join(path))
}

/// The music folder, created if it isn't there yet.
#[tauri::command]
pub fn offline_dir(app: AppHandle, options: State<'_, LaunchOptions>) -> Result<String, String> {
    let dir = root(&app, &options)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Write a chunk (base64) to a file: it starts the file, or with `append` continues it.
#[tauri::command]
pub fn offline_write(app: AppHandle, options: State<'_, LaunchOptions>, path: String, data: String, append: bool) -> Result<(), String> {
    let file = inside(&root(&app, &options)?, &path)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|error| error.to_string())?;
    let mut out = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(file)
        .map_err(|error| error.to_string())?;
    out.write_all(&bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn offline_read(app: AppHandle, options: State<'_, LaunchOptions>, path: String) -> Result<Response, String> {
    let file = inside(&root(&app, &options)?, &path)?;
    fs::read(file).map(Response::new).map_err(|error| error.to_string())
}

/// Delete a file; one that's already gone is fine.
#[tauri::command]
pub fn offline_delete(app: AppHandle, options: State<'_, LaunchOptions>, path: String) -> Result<(), String> {
    let file = inside(&root(&app, &options)?, &path)?;
    match fs::remove_file(file) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

/// Move a file within the music folder (a cached song kept as a download).
#[tauri::command]
pub fn offline_move(app: AppHandle, options: State<'_, LaunchOptions>, from: String, to: String) -> Result<(), String> {
    let root = root(&app, &options)?;
    let (from, to) = (inside(&root, &from)?, inside(&root, &to)?);
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::rename(from, to).map_err(|error| error.to_string())
}
