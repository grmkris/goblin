#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::fs;
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn bridge_url() -> String {
    if let Ok(value) = std::env::var("GOBLIN_DESKTOP_URL") {
        return value;
    }
    let connection = fs::read_to_string("../artifacts/connection.local.json").ok();
    let parsed = connection
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let origin = parsed
        .as_ref()
        .and_then(|value| value["origin"].as_str())
        .unwrap_or("http://127.0.0.1:4173");
    let token = parsed
        .as_ref()
        .and_then(|value| value["token"].as_str())
        .unwrap_or("");
    format!("{origin}/?host=tauri#token={token}")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url: tauri::Url = bridge_url().parse()?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Only the loopback companion is allowed".into());
            }
            let origin = url.origin();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .on_navigation(move |url| url.origin() == origin)
                .title("Goblin · Tauri spike")
                .inner_size(1180.0, 820.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
