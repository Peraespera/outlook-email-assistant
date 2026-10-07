use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenCache {
    access_token: String,
    expires_at_unix: i64,
    refresh_token: Option<String>,
    id_token: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeInfo {
    pub verification_uri: String,
    pub user_code: String,
    pub message: Option<String>,
    pub expires_in: i64,
    pub interval: i64,
    pub device_code: String,
}

#[derive(Default)]
pub struct AuthState {
    // Se guarda cuando el usuario inicia connect_start
    pub pending: Mutex<Option<PendingAuth>>,
}

#[derive(Clone)]
pub struct PendingAuth {
  pub started_at: Instant,
  pub device: DeviceCodeInfo,
}


fn cache_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!("app_data_dir error: {e}"))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("ms_token_cache.json"))
}

fn read_cache(app: &AppHandle) -> Result<Option<TokenCache>> {
    let p = cache_path(app)?;
    if !p.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(p)?;
    let cache: TokenCache = serde_json::from_str(&raw)?;
    Ok(Some(cache))
}

fn write_cache(app: &AppHandle, cache: &TokenCache) -> Result<()> {
    let p = cache_path(app)?;
    fs::write(p, serde_json::to_string_pretty(cache)?)?;
    Ok(())
}

fn clear_cache(app: &AppHandle) -> Result<()> {
    let p = cache_path(app)?;
    if p.exists() {
        fs::remove_file(p)?;
    }
    Ok(())
}

fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn ms_client_id() -> Result<String> {
    std::env::var("MS_CLIENT_ID").map_err(|_| anyhow!("Falta MS_CLIENT_ID en env"))
}

fn ms_tenant() -> String {
    // "common" sirve para Hotmail/Outlook y cuentas MSA/AAD en general
    std::env::var("MS_TENANT").unwrap_or_else(|_| "common".to_string())
}

fn ms_scope() -> String {
    // Lo mínimo para leer correo + perfil (ajusta luego)
    // Offline_access ayuda para refresh token (no siempre lo da en device code, pero conviene pedirlo)
    "offline_access Mail.Read User.Read".to_string()
}

async fn graph_me_email(client: &Client, access_token: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Me {
        #[serde(rename = "userPrincipalName")]
        upn: Option<String>,
        mail: Option<String>,
    }

    let me: Me = client
        .get("https://graph.microsoft.com/v1.0/me")
        .bearer_auth(access_token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    Ok(me.mail.or(me.upn).unwrap_or_else(|| "".to_string()))
}

pub async fn auth_status(app: AppHandle) -> Result<(bool, Option<AccountInfo>)> {
    let cache = match read_cache(&app)? {
        Some(c) => c,
        None => return Ok((false, None)),
    };

    // Si el token aún vive, ok. (Para MVP no refrescamos todavía)
    if cache.expires_at_unix > now_unix() + 30 {
        let email = cache.email.clone().unwrap_or_default();

        if !email.is_empty() {
            return Ok((true, Some(AccountInfo { email })));
        }
        // Si no traíamos email guardado, intentamos leerlo una vez
        let client = Client::new();
        let email2 = graph_me_email(&client, &cache.access_token)
            .await
            .unwrap_or_default();
        if !email2.is_empty() {
            let mut c2 = cache;
            c2.email = Some(email2.clone());
            write_cache(&app, &c2)?;
            return Ok((true, Some(AccountInfo { email: email2 })));
        }
        return Ok((true, None));
    }

    // Expiró → lo tratamos como no-auth (luego metemos refresh)
    Ok((false, None))
}

pub async fn auth_connect_start(
    _app: AppHandle,
    state: tauri::State<'_, AuthState>,
) -> Result<DeviceCodeInfo> {
    let client_id = ms_client_id()?;
    let tenant = ms_tenant();
    let scope = ms_scope();

    #[derive(Deserialize)]
    struct DeviceResp {
        device_code: String,
        user_code: String,
        verification_uri: String,
        verification_uri_complete: Option<String>,
        expires_in: i64,
        interval: Option<i64>,
        message: Option<String>,
    }

    let http = Client::new();
    let url = format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode");

    let resp: DeviceResp = http
        .post(url)
        .form(&[("client_id", client_id.as_str()), ("scope", scope.as_str())])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let info = DeviceCodeInfo {
        verification_uri: resp
            .verification_uri_complete
            .unwrap_or(resp.verification_uri),
        user_code: resp.user_code,
        message: resp.message,
        expires_in: resp.expires_in,
        interval: resp.interval.unwrap_or(5),
        device_code: resp.device_code,
    };

    // Guardar pending en memoria
    let mut lock = state.pending.lock().await;
    *lock = Some(PendingAuth {
        started_at: Instant::now(),
        device: info.clone(),
    });

    Ok(info)
}

pub async fn auth_connect_poll(
    _app: AppHandle,
    state: tauri::State<'_, AuthState>,
) -> Result<(String, Option<String>)> {
    // retorna ("pending"|"authenticated"|"failed", email?)
    let client_id = ms_client_id()?;
    let tenant = ms_tenant();

    let pending = {
        let lock = state.pending.lock().await;
        lock.clone()
    }
    .ok_or_else(|| anyhow!("No hay autenticación pendiente. Inicia con Conectar."))?;

    // Timeout local por seguridad (device code también expira)
    if pending.started_at.elapsed() > Duration::from_secs(pending.device.expires_in as u64 + 5) {
        let mut lock = state.pending.lock().await;
        *lock = None;
        return Ok(("failed".to_string(), None));
    }

    #[derive(Deserialize)]
    struct TokenOk {
        access_token: String,
        expires_in: i64,
        refresh_token: Option<String>,
        id_token: Option<String>,
        token_type: Option<String>,
        scope: Option<String>,
    }

    #[derive(Deserialize)]
    struct TokenErr {
        error: String,
        error_description: Option<String>,
    }

    let http = Client::new();
    let url = format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token");

    let res = http
        .post(url)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id.as_str()),
            ("device_code", pending.device.device_code.as_str()),
        ])
        .send()
        .await?;

    if res.status().is_success() {
        let tok: TokenOk = res.json().await?;
        let expires_at = now_unix() + tok.expires_in;

        // Obtener email con Graph
        let email = graph_me_email(&http, &tok.access_token)
            .await
            .unwrap_or_default();

        let cache = TokenCache {
            access_token: tok.access_token,
            expires_at_unix: expires_at,
            refresh_token: tok.refresh_token,
            id_token: tok.id_token,
            email: if email.is_empty() {
                None
            } else {
                Some(email.clone())
            },
        };
        write_cache(&_app, &cache)?;

        // Limpiar pending
        let mut lock = state.pending.lock().await;
        *lock = None;

        return Ok((
            "authenticated".to_string(),
            if email.is_empty() { None } else { Some(email) },
        ));
    }

    // Error esperado mientras aún no autoriza: authorization_pending / slow_down
    let e: TokenErr = res.json().await.unwrap_or(TokenErr {
        error: "unknown".into(),
        error_description: None,
    });
    match e.error.as_str() {
        "authorization_pending" => Ok(("pending".to_string(), None)),
        "slow_down" => Ok(("pending".to_string(), None)),
        _ => {
            // Falló de verdad
            let mut lock = state.pending.lock().await;
            *lock = None;
            Ok(("failed".to_string(), None))
        }
    }
}

pub async fn auth_logout(app: AppHandle, state: tauri::State<'_, AuthState>) -> Result<()> {
    clear_cache(&app)?;
    let mut lock = state.pending.lock().await;
    *lock = None;
    Ok(())
}


pub fn get_access_token(app: &AppHandle) -> Result<String> {
  let cache = read_cache(app)?.ok_or_else(|| anyhow!("No hay sesión"))?;
  if cache.expires_at_unix <= now_unix() + 30 {
    return Err(anyhow!("Token expirado (aún no implementamos refresh)"));
  }
  Ok(cache.access_token)
}
