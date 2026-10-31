use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri_plugin_fs::FsExt;

/// Steam app id of Transport Fever 3 (userdata: `<...>/<SteamID>/3493540/local`).
const TF3_APP_ID: &str = "3493540";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectedPaths {
    /// TF3 userdata folder (`heightmaps/`, `towns_industries/`, `staging_area/` live there), if found.
    userdata: Option<String>,
    /// Every candidate that was checked, in order (for the settings screen).
    candidates: Vec<String>,
}

#[cfg(not(windows))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Steam install folder from the registry (HKCU\Software\Valve\Steam, SteamPath).
#[cfg(windows)]
fn steam_path_from_registry() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.trim_start().starts_with("SteamPath"))?;
    let value = line.split("REG_SZ").nth(1)?.trim();
    (!value.is_empty()).then(|| PathBuf::from(value))
}

/// Folders whose children are per-account folders holding `3493540/local`.
fn account_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        if let Some(steam) = steam_path_from_registry() {
            roots.push(steam.join("userdata"));
        }
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(dir) = std::env::var_os(var) {
                roots.push(PathBuf::from(dir).join("Steam").join("userdata"));
            }
        }
        let public = std::env::var_os("PUBLIC").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"));
        roots.push(public.join("Documents").join("Steam"));
    }
    #[cfg(not(windows))]
    if let Some(home) = home_dir() {
        roots.push(home.join(".local/share/Steam/userdata"));
        roots.push(home.join(".steam/steam/userdata"));
        roots.push(home.join("Library/Application Support/Steam/userdata"));
    }
    roots
}

/// GOG / Epic Games Store userdata folder.
fn store_userdata_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("Transport Fever 3"));
    }
    #[cfg(not(windows))]
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/share/Transport Fever 3"));
    }
    dirs
}

/// TF3 userdata folders found (most recently used first), and the expected locations otherwise.
fn userdata_candidates() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut expected = Vec::new();
    for root in account_roots() {
        expected.push(root.join("<account>").join(TF3_APP_ID).join("local"));
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for e in entries.flatten() {
            let local = e.path().join(TF3_APP_ID).join("local");
            if local.is_dir() {
                let mtime = std::fs::metadata(&local).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                found.push((mtime, local));
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let mut found: Vec<PathBuf> = found.into_iter().map(|(_, p)| p).collect();
    for dir in store_userdata_dirs() {
        if dir.is_dir() {
            found.push(dir);
        } else {
            expected.push(dir);
        }
    }
    (found, expected)
}

#[tauri::command]
fn detect_paths() -> DetectedPaths {
    let (found, expected) = userdata_candidates();
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let shown = if found.is_empty() { &expected } else { &found };
    DetectedPaths {
        userdata: found.first().map(|p| s(p)),
        candidates: shown.iter().map(|p| s(p)).collect(),
    }
}

/// Grant the fs plugin access to folders outside the static scope (a userdata folder chosen by hand).
#[tauri::command]
fn allow_dirs(app: tauri::AppHandle, dirs: Vec<String>) {
    let scope = app.fs_scope();
    for dir in dirs {
        let path = PathBuf::from(&dir);
        if path.is_dir() {
            let _ = scope.allow_directory(path, true);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![detect_paths, allow_dirs])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
