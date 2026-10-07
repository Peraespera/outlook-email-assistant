import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

// En dev, permite tu Vite (1420). Ajusta si usas otro puerto.
app.use(cors({
  origin: true,         // permite el origin que llegue (dev)
  credentials: true
}));


// ⚠️ Guardado en memoria para demo (luego lo hacemos persistente)
const sessions = new Map(); // key: sessionId -> { device_code, interval, expires_in, ... }

function getSessionId(req) {
  // demo simple: 1 usuario
  return "demo";
}

// 1) START: pide device code a Microsoft
app.post("/api/auth/start", async (req, res) => {
  const tenant = process.env.MS_TENANT_ID ?? "common";
  const clientId = process.env.MS_CLIENT_ID;
  const scope = process.env.MS_SCOPE ?? "offline_access Mail.Read User.Read";

  if (!clientId) return res.status(500).json({ ok:false, message:"Falta MS_CLIENT_ID" });

  const body = new URLSearchParams({
    client_id: clientId,
    scope
  });

  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await r.json();
  if (!r.ok) return res.status(500).json({ ok:false, message:"devicecode failed", details:data });

  sessions.set(getSessionId(req), data);

  // Normalizamos a tu formato UI (camelCase)
  return res.json({
    ok: true,
    expiresIn: data.expires_in,
    interval: data.interval,
    message: data.message,
    userCode: data.user_code,
    verificationUri: data.verification_uri
  });
});

// 2) POLL: intercambia device_code por token
app.post("/api/auth/poll", async (req, res) => {
  const tenant = process.env.MS_TENANT_ID ?? "common";
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId) return res.status(500).json({ ok:false, message:"Falta MS_CLIENT_ID" });

  const s = sessions.get(getSessionId(req));
  if (!s?.device_code) return res.json({ status:"no_session" });

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clientId,
    device_code: s.device_code
  });

  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await r.json();

  // Aún pendiente (normal)
  if (data?.error === "authorization_pending") {
    return res.json({ status: "pending" });
  }

  // Usuario tardó mucho
  if (data?.error === "expired_token") {
    sessions.delete(getSessionId(req));
    return res.json({ status: "failed", message: "Código expiró" });
  }

  // Error real
  if (!r.ok) {
    return res.json({ status: "failed", message: data?.error_description ?? "token failed", details: data });
  }

  // Guardar tokens (demo en memoria)
  sessions.set(getSessionId(req), { ...s, token: data });

  // Opcional: pedir email
  let email = "";
  try {
    const me = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${data.access_token}` }
    });
    const meJson = await me.json();
    email = meJson?.mail || meJson?.userPrincipalName || "";
  } catch {}

  return res.json({ status: "authenticated", email });
});

// 3) Logout demo
app.post("/api/auth/logout", (req, res) => {
  sessions.delete(getSessionId(req));
  res.json({ ok:true });
});

// 4) Ejemplo: leer últimos correos (inbox)
app.get("/api/mail/latest", async (req, res) => {
  const s = sessions.get(getSessionId(req));
  const token = s?.token?.access_token;
  if (!token) return res.status(401).json({ ok:false, message:"No auth" });

  const r = await fetch("https://graph.microsoft.com/v1.0/me/messages?$top=10&$orderby=receivedDateTime desc", {
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await r.json();
  if (!r.ok) return res.status(500).json({ ok:false, message:"graph failed", details:data });

  res.json({ ok:true, value: data.value ?? [] });
});

app.get("/health", (req, res) => res.send("ok"));
app.get("/api/auth/status", async (req, res) => {
  const s = sessions.get(getSessionId(req));
  const token = s?.token?.access_token;
  if (!token) return res.json({ ok: true, status: "no-auth" });

  // opcional: devolver email guardado si lo tienes
  return res.json({ ok: true, status: "authenticated" });
});


const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API on http://0.0.0.0:${PORT}`);
});

// 5) Mail fetch range: lo que espera tu UI (POST /api/mail/fetch-range)
app.post("/api/mail/fetch-range", async (req, res) => {
  try {
    const s = sessions.get(getSessionId(req));
    const token = s?.token?.access_token;
    if (!token) return res.status(401).json({ ok: false, message: "No auth" });

    // params que mandas desde UI:
    // { days?: number; startIso?: string; endIso?: string; top?: number }
    const top = Number(req.body?.top ?? 25);

    // Determinar rango (prioridad: start/end > days > sin filtro)
    let filter = "";
    const startIso = req.body?.startIso;
    const endIso = req.body?.endIso;
    const days = req.body?.days;

    if (startIso && endIso) {
      filter = `&$filter=receivedDateTime ge ${new Date(startIso).toISOString()} and receivedDateTime le ${new Date(endIso).toISOString()}`;
    } else if (days) {
      const from = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
      filter = `&$filter=receivedDateTime ge ${from}`;
    }

    const url =
      "https://graph.microsoft.com/v1.0/me/messages" +
      `?$top=${top}` +
      `&$orderby=receivedDateTime desc` +
      `&$select=id,subject,from,receivedDateTime,bodyPreview,hasAttachments` +
      filter;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json({ ok: false, message: "graph failed", details: data });

    // Normalizamos para que tu UI lo use fácil
    return res.json({ ok: true, messages: data.value ?? [] });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e) });
  }
});
