use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth;


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailRangeRequest {
  pub start_iso: String,
  pub end_iso: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailItem {
  pub id: String,
  pub subject: Option<String>,
  pub from: Option<String>,
  pub to: Vec<String>,
  pub received_date_time: Option<String>,
  pub sent_date_time: Option<String>,
   pub body_preview: Option<String>,
}

#[derive(Deserialize)]
struct GraphListResponse<T> {
  value: Vec<T>,
  #[serde(rename="@odata.nextLink")]
  next_link: Option<String>,
}

#[derive(Deserialize)]
struct GraphMessage {
    id: String,
    subject: Option<String>,
    from: Option<GraphRecipientWrap>,
    #[serde(default)]
    toRecipients: Vec<GraphRecipientWrap>,
    receivedDateTime: Option<String>,
    sentDateTime: Option<String>,
    bodyPreview: Option<String>,
}

#[derive(Deserialize)]
struct GraphRecipientWrap {
  emailAddress: GraphEmailAddress,
}

#[derive(Deserialize)]
struct GraphEmailAddress {
  address: Option<String>,
}

fn map_msg(m: GraphMessage) -> MailItem {
  let from = m.from.and_then(|x| x.emailAddress.address).map(|s| s.to_lowercase());
  let to = m
    .toRecipients
    .into_iter()
    .filter_map(|r| r.emailAddress.address)
    .map(|s| s.to_lowercase())
    .collect();

  MailItem {
    id: m.id,
    subject: m.subject,
    from,
    to,
    received_date_time: m.receivedDateTime,
    sent_date_time: m.sentDateTime,
    body_preview: m.bodyPreview,
  }
}

async fn fetch_messages(
  http: &Client,
  access_token: &str,
  url: String,
  max_pages: usize,
) -> Result<Vec<MailItem>> {
  let mut out: Vec<MailItem> = Vec::new();
  let mut next = Some(url);
  let mut pages = 0;

  while let Some(u) = next {
    pages += 1;
    if pages > max_pages { break; }

    let res = http
      .get(&u)
      .bearer_auth(access_token)
      .send().await?
      .error_for_status()?;

    let data: GraphListResponse<GraphMessage> = res.json().await?;
    out.extend(data.value.into_iter().map(map_msg));
    next = data.next_link;
  }

  Ok(out)
}

pub async fn mail_fetch_range(app: AppHandle, req: MailRangeRequest) -> Result<serde_json::Value> {
  let token = auth::get_access_token(&app)?;
  let http = Client::new();

  // Inbox (recibidos)
  // SentItems (enviados)
  // Filtramos por receivedDateTime y sentDateTime.
  // NOTA: Para MVP usamos UTC; luego lo adaptamos a America/Mexico_City desde el frontend.
  let inbox_url = format!(
    "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=50\
&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview\
&$orderby=receivedDateTime desc\
&$filter=receivedDateTime ge {} and receivedDateTime lt {}",
    req.start_iso, req.end_iso
  );

  let sent_url = format!(
    "https://graph.microsoft.com/v1.0/me/mailFolders/SentItems/messages?$top=50\
&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview\
&$orderby=sentDateTime desc\
&$filter=sentDateTime ge {} and sentDateTime lt {}",
    req.start_iso, req.end_iso
  );

  let inbox = fetch_messages(&http, &token, inbox_url, 5).await?;
  let sent = fetch_messages(&http, &token, sent_url, 5).await?;

  Ok(serde_json::json!({
    "ok": true,
    "range": { "start": req.start_iso, "end": req.end_iso },
    "inboxCount": inbox.len(),
    "sentCount": sent.len(),
    "inbox": inbox,
    "sent": sent
  }))
}
