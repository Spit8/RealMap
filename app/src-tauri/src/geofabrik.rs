//! Extraits OpenStreetMap de Geofabrik (https://download.geofabrik.de) pour les très grandes zones :
//! téléchargement en continu vers un `.part` (reprise par `Range` après une coupure, taille contrôlée,
//! renommage à la fin), puis lecture des fichiers (`osm_pbf`) dans un fil à part.

use crate::osm_pbf::{extract_region, Bbox, ExtractProgress, Filters, Output};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use tauri::ipc::Channel;

const USER_AGENT: &str = "RealMap (Transport Fever 3 map importer; https://github.com/Spit8/RealMap)";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

/// Télécharge `url` vers `dest` (via `dest.part`). Reprend un `.part` existant. Renvoie la taille.
#[tauri::command]
pub async fn geofabrik_download(url: String, dest: String, on_progress: Channel<DownloadProgress>) -> Result<u64, String> {
    download(&url, &dest, |p| {
        let _ = on_progress.send(p);
    })
    .await
}

/// Le téléchargement lui-même (testable sans Tauri).
pub async fn download(url: &str, dest: &str, on_progress: impl Fn(DownloadProgress)) -> Result<u64, String> {
    let part = format!("{dest}.part");
    // URL datée vers laquelle « latest » a redirigé : une reprise relit le même fichier, jamais un
    // morceau d'une version plus récente publiée entre-temps.
    let src = format!("{dest}.part.url");
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    // Quelques reprises sur coupure : chaque essai repart de la taille déjà reçue.
    let mut last_err = String::new();
    for _attempt in 0..5 {
        let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let resume_url = std::fs::read_to_string(&src).ok().filter(|_| have > 0);
        if have > 0 && resume_url.is_none() {
            let _ = std::fs::remove_file(&part);
            have = 0;
        }
        let mut req = client.get(resume_url.as_deref().unwrap_or(url));
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let mut res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                tokio_sleep(5).await;
                continue;
            }
        };
        let status = res.status();
        let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !status.is_success() {
            // 416 : le .part est déjà complet ou invalide ; on repart de zéro.
            // 404 : le fichier daté a disparu du serveur ; on repart du « latest ».
            if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE || (have > 0 && status == reqwest::StatusCode::NOT_FOUND) {
                let _ = std::fs::remove_file(&part);
                let _ = std::fs::remove_file(&src);
                continue;
            }
            return Err(format!("HTTP {status}"));
        }
        let start = if resumed { have } else { 0 };
        if !resumed {
            let _ = std::fs::write(&src, res.url().as_str());
        }
        let total = start + res.content_length().unwrap_or(0);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .map_err(|e| e.to_string())?;
        let mut received = start;
        let mut last_sent = 0u64;
        let mut broken = false;
        loop {
            match res.chunk().await {
                Ok(Some(bytes)) => {
                    file.write_all(&bytes).map_err(|e| e.to_string())?;
                    received += bytes.len() as u64;
                    if received - last_sent >= 4 << 20 {
                        last_sent = received;
                        on_progress(DownloadProgress { received, total });
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    last_err = e.to_string();
                    broken = true;
                    break;
                }
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        if broken || (total > 0 && received != total) {
            if !broken {
                last_err = format!("{received} / {total} octets");
            }
            tokio_sleep(5).await;
            continue;
        }
        on_progress(DownloadProgress { received, total });
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(dest);
        std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
        return Ok(received);
    }
    Err(format!("téléchargement interrompu : {last_err}"))
}

async fn tokio_sleep(s: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_secs(s)))
        .await
        .ok();
}

/// Lit un extrait et écrit dans `out` ses cinq réponses « Overpass » (eau, lieux, routes, sites, sol)
/// pour la zone `bbox`. Une région par appel : l'app lit chaque région dès qu'elle est téléchargée,
/// pendant le téléchargement de la suivante, et garde le résultat en cache par région.
/// Renvoie le nombre d'éléments par réponse.
#[tauri::command]
pub async fn osm_extract(
    file: String,
    bbox: Bbox,
    filters: Filters,
    out: String,
    on_progress: Channel<ExtractProgress>,
) -> Result<[usize; 5], String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !Path::new(&file).exists() {
            return Err(format!("{file}: fichier absent"));
        }
        let mut acc = Output::default();
        let progress = |pass: u8| {
            let _ = on_progress.send(ExtractProgress { pass });
        };
        extract_region(&file, &bbox, &filters, &mut acc, &progress)?;
        let counts = [acc.area.len(), acc.places.len(), acc.roads.len(), acc.sites.len(), acc.land.len()];
        let text = serde_json::to_string(&acc.to_json()).map_err(|e| e.to_string())?;
        let part = format!("{out}.part");
        std::fs::write(&part, text).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&out);
        std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
        Ok(counts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod live {
    /// Téléchargement réel avec reprise (lancé à la main) :
    /// `GEOFABRIK_DIR=<dossier> cargo test --lib live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn download_and_resume() {
        let dir = std::env::var("GEOFABRIK_DIR").expect("GEOFABRIK_DIR");
        let url = "https://download.geofabrik.de/europe/liechtenstein-latest.osm.pbf";
        let dest = format!("{dir}/li-live.osm.pbf");
        let _ = std::fs::remove_file(&dest);
        let full = tauri::async_runtime::block_on(super::download(url, &dest, |_| {})).expect("premier téléchargement");
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), full);
        // Coupure simulée : un .part de la moitié, puis reprise par Range sur l'URL mémorisée.
        let bytes = std::fs::read(&dest).unwrap();
        std::fs::write(format!("{dest}.part"), &bytes[..bytes.len() / 2]).unwrap();
        std::fs::write(format!("{dest}.part.url"), url).unwrap();
        std::fs::remove_file(&dest).unwrap();
        let resumed = tauri::async_runtime::block_on(super::download(url, &dest, |_| {})).expect("reprise");
        assert_eq!(resumed, full);
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
        eprintln!("ok : {full} octets, reprise identique");
    }
}
