use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};

pub async fn ai_suggestions(payload: Value) -> Result<Value> {
    // Lee la key desde env (o desde .env de Tauri si lo tienes cargado)
    let key = std::env::var("OPENAI_API_KEY").map_err(|_| anyhow!("Falta OPENAI_API_KEY"))?;

    let http = Client::new();

    let system = "Eres un asistente de correo. Devuelve SOLO JSON válido, sin texto extra.";
    let user = format!(
        "Con base en este resumen de correos, genera sugerencias claras y accionables.

    Devuelve:
    - Un resumen ejecutivo breve.
    - Acciones sugeridas.
    - Tareas pendientes.
    - Seguimientos necesarios.
    - PRIORIDADES DEL DÍA (máximo 5), donde cada prioridad incluya:
    - title (título corto del correo o tema)
    - reason (por qué es prioritario hoy)
    - action (Responder | Preparar reunión | Dar seguimiento | Leer)
    - from (quién lo envió)
    - date (fecha/hora del correo)

    Resumen de correos:
    {}",
        payload.to_string()
    );

    // Endpoint Responses API (recomendado)
    let body = json!({
      "model": "gpt-4.1-mini",
      "input": [
        { "role": "system", "content": system },
        { "role": "user", "content": user }
      ],
      "text": {
        "format": {
          "type": "json_schema",
          "name": "email_suggestions",
          "schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "executive_summary": { "type": "string" },

              "priorities": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "title": { "type": "string" },
                    "reason": { "type": "string" },
                    "action": {
                      "type": "string",
                      "enum": [
                        "Responder",
                        "Preparar reunión",
                        "Dar seguimiento",
                        "Leer"
                      ]
                    },
                    "from": { "type": "string" },
                    "date": { "type": "string" }
                  },
                  "required": ["title", "reason", "action", "from", "date"]
                }
              },

              "actions": {
                "type": "array",
                "items": { "type": "string" }
              },


              "follow_ups": {
                "type": "array",
                "items": { "type": "string" }
              }
            },
            "required": [
              "executive_summary",
              "priorities",
              "actions",
              "follow_ups"
            ]
          }
        }
      }
    });

    let resp = http
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    let txt = resp.text().await?; // <-- lee el body SIEMPRE (ok o error)

    if !status.is_success() {
        // txt trae el JSON con el motivo del 400
        return Err(anyhow!("OpenAI error {}: {}", status, txt));
    }

    // si fue success, txt contiene la respuesta JSON completa:
    let v: Value = serde_json::from_str(&txt)?;

    // Extrae el texto JSON devuelto (depende del formato de la API)
    // Normalmente viene en v["output"][...]["content"][...]["text"]
    let mut extracted: Option<String> = None;
    if let Some(arr) = v.get("output").and_then(|x| x.as_array()) {
        for item in arr {
            if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                for c in content {
                    if c.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                        extracted = c
                            .get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string());
                        break;
                    }
                }
            }
        }
    }

    let text = extracted.ok_or_else(|| anyhow!("No pude extraer respuesta del modelo"))?;
    let json_out: Value =
        serde_json::from_str(&text).map_err(|_| anyhow!("La IA no devolvió JSON válido"))?;

    Ok(json!({ "ok": true, "suggestions": json_out }))
}
