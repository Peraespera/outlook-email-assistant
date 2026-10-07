// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod auth;
mod mail;

use auth::AuthState;
use dotenvy::dotenv;

fn main() {
    dotenv().ok();

    tauri::Builder::default()
        // 🔥 Esto registra el state para State<'_, AuthState>
        .manage(AuthState::default())
        // ✅ Registra LOS COMMANDS (los de este archivo)
        .invoke_handler(tauri::generate_handler![
            ai_suggestions,
            mail_fetch_range,
            auth_status,
            auth_connect_start,
            auth_connect_poll,
            auth_logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn ai_suggestions(payload: serde_json::Value) -> Result<serde_json::Value, String> {
    ai::ai_suggestions(payload).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn mail_fetch_range(
    app: tauri::AppHandle,
    req: mail::MailRangeRequest,
) -> Result<serde_json::Value, String> {
    mail::mail_fetch_range(app, req)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn auth_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (has, account) = auth::auth_status(app).await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "hasSession": has,
        "email": account.map(|a| a.email)
    }))
}

#[tauri::command]
async fn auth_connect_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
) -> Result<serde_json::Value, String> {
    let info = auth::auth_connect_start(app, state)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "verificationUri": info.verification_uri,
        "userCode": info.user_code,
        "message": info.message,
        "expiresIn": info.expires_in,
        "interval": info.interval
    }))
}

#[tauri::command]
async fn auth_connect_poll(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
) -> Result<serde_json::Value, String> {
    let (status, email) = auth::auth_connect_poll(app, state)
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "status": status,
        "email": email
    }))
}

#[tauri::command]
async fn auth_logout(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
) -> Result<serde_json::Value, String> {
    auth::auth_logout(app, state)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true }))
}
