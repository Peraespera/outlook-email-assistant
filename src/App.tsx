import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import "./App.css";
import m1 from "./assets/m1.png";
import m2 from "./assets/m2.png";

import {authStatus, authConnectStart, authConnectPoll, authLogout,} from "./platform/auth";
import { mailFetchRange, type MailFetchParams } from "./platform/mail";
import { aiSuggestions } from "./platform/ai";


type SessionStatus =
  | "checking"
  | "no-auth"
  | "auth-pending"
  | "authenticated"
  | "expired";
type RangePreset = "today" | "yesterday" | "last7" | "custom";
type MailItem = {
  id: string;
  subject?: string | null;
  from?: string | null;
  to?: string[];
  received_date_time?: string | null;
  sent_date_time?: string | null;
  body_preview?: string | null;
};

type AnalyzeResult = {
  inboxCount: number;
  sentCount: number;
  inbox: MailItem[];
  sent: MailItem[];
};

type PriorityItem = {
  id: string;
  title: string;
  reason: string;
  action: "Responder" | "Preparar reunión" | "Dar seguimiento" | "Leer";
  from?: string;
  date?: string;
};
const ANALYSIS_TTL_MS = 2 * 60 * 1000; // 2 minutos

export default function App() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("checking");
  const [accountEmail, setAccountEmail] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [priorities, setPriorities] = useState<PriorityItem[]>([]);

  const [lastRange, setLastRange] = useState<{
    preset: RangePreset;
    startIso: string;
    endIso: string;
  } | null>(null);

  const [aiBusy, setAiBusy] = useState(false);
  const [aiOut, setAiOut] = useState<any | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const [rangePreset, setRangePreset] = useState<RangePreset>("today");
  const [customStart, setCustomStart] = useState<string>(""); // YYYY-MM-DD
  const [customEnd, setCustomEnd] = useState<string>(""); // YYYY-MM-DD

  const [device, setDevice] = useState<{
    verificationUri: string;
    userCode: string;
    message?: string;
    interval: number;
  } | null>(null);

  // ✅ Estos deben ir dentro del componente
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [inbox, setInbox] = useState<any[]>([]);


  useEffect(() => {
    (async () => {
      try {
        setSessionStatus("checking");
        const res: any = await authStatus();
        if (res?.hasSession) {
          setAccountEmail(res.email ?? "");
          setSessionStatus("authenticated");
        } else {
          setSessionStatus("no-auth");
        }
      } catch {
        setSessionStatus("no-auth");
      }
    })();
  }, []);

  function analysisCacheKey(preset: string, startIso: string, endIso: string) {
    return `analysis_${preset}_${startIso}_${endIso}`;
  }

  function aiCacheKey(preset: string, startIso: string, endIso: string) {
    return `ai_${preset}_${startIso}_${endIso}`;
  }

  function fmtMX(iso?: string | null) {
    if (!iso) return "";
    return DateTime.fromISO(iso, { zone: "utc" })
      .setZone("America/Mexico_City")
      .toFormat("dd/LL/yyyy HH:mm");
  }
  async function onConnect() {
    try {
      setAuthBusy(true);
      setAuthError(null);

      const res: any = await authConnectStart();
      const verificationUri =
      res.verificationUri ??
      res.verification_uri ??
      res.verificationUriComplete ??
      res.verification_uri_complete ??
      "";

    const userCode = res.userCode ?? res.user_code ?? "";
      console.log("AUTH START RES:", res);

    setDevice({
    verificationUri: res.verificationUri ?? "",
    userCode: res.userCode ?? "",
    message: res.message ?? "",
    interval: res.interval ?? 5,
    });
      setSessionStatus("auth-pending");

      const intervalMs = (res.interval ?? 5) * 1000;
      const timer = setInterval(async () => {
        try {
          const p: any = await authConnectPoll();
          if (p.status === "authenticated") {
            clearInterval(timer);
            setAccountEmail(p.email ?? "");
            setDevice(null);
            setSessionStatus("authenticated");
            setAuthBusy(false);
          } else if (p.status === "failed") {
            clearInterval(timer);
            setDevice(null);
            setSessionStatus("no-auth");
            setAuthBusy(false);
            setAuthError(
              "No se pudo completar la autenticación. Intenta de nuevo.",
            );
          }
        } catch (e: any) {
          console.error("auth_connect_poll failed:", e);

          clearInterval(timer);
          setDevice(null);
          setSessionStatus("no-auth");
          setAuthBusy(false);

          const msg =
            e?.message ||
            e?.toString?.() ||
            (typeof e === "string" ? e : "") ||
            "Error durante la autenticación. Intenta de nuevo.";

          setAuthError(msg);
        }
      }, intervalMs);
    } catch (e: any) {
      console.error("auth_connect_start failed:", e);

      setAuthBusy(false);
      setSessionStatus("no-auth");

      // Intenta mostrar un mensaje útil
      const msg =
        e?.message ||
        e?.toString?.() ||
        (typeof e === "string" ? e : "") ||
        "No se pudo iniciar el login con Microsoft.";

      setAuthError(msg);
    }
  }

  async function onLogout() {
    try {
      setAuthBusy(true);
      setAuthError(null);
      await authLogout();
      setAccountEmail("");
      setDevice(null);
      setResult(null);
      setSessionStatus("no-auth");
    } finally {
      setAuthBusy(false);
    }
  }

  function getRangeIsoMX(preset: RangePreset) {
    const Z = "America/Mexico_City";

    if (preset === "today") {
      const start = DateTime.now().setZone(Z).startOf("day");
      const end = start.plus({ days: 1 });
      return { startIso: start.toUTC().toISO()!, endIso: end.toUTC().toISO()! };
    }

    if (preset === "yesterday") {
      const start = DateTime.now().setZone(Z).minus({ days: 1 }).startOf("day");
      const end = start.plus({ days: 1 });
      return { startIso: start.toUTC().toISO()!, endIso: end.toUTC().toISO()! };
    }

    if (preset === "last7") {
      const end = DateTime.now().setZone(Z);
      const start = end.minus({ days: 7 });
      return { startIso: start.toUTC().toISO()!, endIso: end.toUTC().toISO()! };
    }

    // custom
    if (!customStart || !customEnd) {
      throw new Error("Selecciona fecha inicio y fin.");
    }

    const start = DateTime.fromISO(customStart, { zone: Z }).startOf("day");
    const end = DateTime.fromISO(customEnd, { zone: Z })
      .plus({ days: 1 })
      .startOf("day"); // incluye día final
    if (end <= start) throw new Error("El rango personalizado es inválido.");

    return { startIso: start.toUTC().toISO()!, endIso: end.toUTC().toISO()! };
  }

  function isImportant(m: MailItem) {
    const from = (m.from ?? "").toLowerCase();
    const subj = (m.subject ?? "").toLowerCase();
    const prev = (m.body_preview ?? "").toLowerCase();
    const text = `${from} ${subj} ${prev}`;

    const negative = [
      "no-reply",
      "noreply",
      "newsletter",
      "promocion",
      "promociones",
      "unsubscribe",
      "oferta",
      "sale",
      "marketing",
      "substack",
      "coursera",
      "ef",
      "oferta", 
      "discount", 
      "% off", 
      "use the code", 
      "promo code",
      "getsmarter",
    ];
    if (negative.some((k) => text.includes(k))) return false;

    const positive = [
      "reunión",
      "reunion",
      "cita",
      "reunion",
      "meeting",
      "teams",
      "zoom",
      "meet.google",
      "factura",
      "invoice",
      "pago",
      "payment",
      "documento",
      "adjunto",
      "firma",
      "contrato",
      "urgente",
      "hoy",
      "mañana",
      "final",
      "register",
      "getsmarter",
      
    ];
    if (positive.some((k) => text.includes(k))) return true;

    // fallback: humano > robot
    if (!from.includes("no-reply") && !from.includes("noreply")) return true;

    return false;
  }

  async function onAskAI() {
    if (!result || !lastRange) return;

    setAiBusy(true);
    setAiError(null);

    try {
      // 1️⃣ key de cache IA
      const key = aiCacheKey(
        lastRange.preset,
        lastRange.startIso,
        lastRange.endIso,
      );

      // 2️⃣ revisar cache
      const cached = localStorage.getItem(key);
      if (cached) {
        setAiOut(JSON.parse(cached));
        setAiBusy(false);
        return;
      }

      // 3️⃣ filtrar correos importantes
      const importantInbox = result.inbox.filter(isImportant).slice(0, 20);

      // 4️⃣ construir payload
      const payload = {
        range: { preset: rangePreset },

        stats: {
          inbox: result.inboxCount,
          sent: result.sentCount,
        },

        topContacts: computeTopContacts(result.inbox, result.sent),

        reminders: detectReminders(importantInbox),
        meetings: detectMeetings(importantInbox),

        recentInbox: importantInbox.map((m) => ({
          from: m.from,
          subject: m.subject,
          date: m.received_date_time,
          preview: m.body_preview,
        })),
      };

      // 5️⃣ llamar backend IA
      const res: any = await aiSuggestions(payload);

      // 6️⃣ guardar resultado
      setAiOut(res.suggestions);
      setPriorities(res.priorities ?? []);
      localStorage.setItem(key, JSON.stringify(res.suggestions));
    } catch (e: any) {
      setAiError(typeof e === "string" ? e : "No se pudo generar sugerencias.");
    } finally {
      setAiBusy(false);
    }
  }

  async function onAnalyze(forceRefresh = false) {
    setAnalysisBusy(true);
    setAnalysisError(null);

    try {
      // 1️⃣ calcular rango
      const { startIso, endIso } = getRangeIsoMX(rangePreset);

      // 2️⃣ key de cache
      const key = analysisCacheKey(rangePreset, startIso, endIso);

      // 3️⃣ revisar cache (si NO es force refresh)
      if (!forceRefresh) {
        const cachedRaw = localStorage.getItem(key);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as {
            savedAt: number;
            data: AnalyzeResult;
          };

          const isFresh =
            cached.savedAt && Date.now() - cached.savedAt < ANALYSIS_TTL_MS;

          if (isFresh) {
            setResult(cached.data);
            setLastRange({ preset: rangePreset, startIso, endIso });
            setAnalysisBusy(false);
            return;
          }
        }
      }

      // 4️⃣ llamar backend (Graph)
      const params: MailFetchParams = {
        days: 1,
        top: 50,
      };

      const data: any = await mailFetchRange(params);
          const raw = data?.messages ?? data?.value ?? data ?? [];

    const items: MailItem[] = (Array.isArray(raw) ? raw : []).map((m: any) => {
      const from =
        typeof m?.from === "string"
          ? m.from
          : (m?.from?.emailAddress?.address ??
            m?.sender?.emailAddress?.address ??
            "");

      const toRaw = m?.to ?? m?.toRecipients ?? [];
      const to =
        Array.isArray(toRaw)
          ? toRaw
              .map((t: any) =>
                typeof t === "string"
                  ? t
                  : (t?.emailAddress?.address ?? t?.address ?? ""),
              )
              .filter(Boolean)
          : [];

      return {
        id: String(m?.id ?? ""),
        subject: m?.subject ?? null,
        from: from || null,
        to,
        received_date_time: m?.receivedDateTime ?? m?.received_date_time ?? null,
        sent_date_time: m?.sentDateTime ?? m?.sent_date_time ?? null,
        body_preview: m?.bodyPreview ?? m?.body_preview ?? null,
      };
    });
      setInbox(items);



      const next: AnalyzeResult = {
        inboxCount: items.length,
        sentCount: 0,   // todavía no estás trayendo "sent" en web
        inbox: items,
        sent: [],       // todavía no estás trayendo "sent" en web
      };


      // 5️⃣ guardar resultado + timestamp
      setResult(next);
      setLastRange({ preset: rangePreset, startIso, endIso });

      localStorage.setItem(
        key,
        JSON.stringify({
          savedAt: Date.now(),
          data: next,
        }),
      );
    } catch (e: any) {
      setAnalysisError(
        typeof e === "string" ? e : (e?.message ?? "No se pudo analizar."),
      );
    } finally {
      setAnalysisBusy(false);
    }
  }

function getEmailFromMessage(m: any): string {
  const v =
    m?.from?.emailAddress?.address ??
    m?.sender?.emailAddress?.address ??
    m?.from?.address ??
    m?.email ??
    m?.from ??
    "";
  return typeof v === "string" ? v : "";
}

  

  const showConnect =
    sessionStatus === "no-auth" || sessionStatus === "expired";
  const isAuthed = sessionStatus === "authenticated";
  function computeTopContacts(inbox: MailItem[], sent: MailItem[]) {
  const counts = new Map<string, number>();

  const bump = (email?: string | null) => {
    const e = (email ?? "").trim().toLowerCase();
    if (!e) return;
    counts.set(e, (counts.get(e) ?? 0) + 1);
  };

  for (const m of inbox ?? []) bump(m.from);

  for (const m of sent ?? []) {
    for (const t of m.to ?? []) bump(t);
  }

  return Array.from(counts.entries())
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

  function detectMeetings(messages: MailItem[]) {
  const linkRegex =
    /\bhttps?:\/\/(?:www\.)?(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com)\/[^\s]*/i;

  const keywordRegex =
    /\b(reuni[oó]n|meeting|cita |meet|videollamada)\b/i;

  const stripUrls = (s: string) => s.replace(/\bhttps?:\/\/\S+/gi, " ");

  const out: {
    from?: string | null;
    subject?: string | null;
    link?: string | null;
    preview?: string | null;
  }[] = [];

  for (const m of messages) {
    const text = `${m.subject ?? ""}\n${m.body_preview ?? ""}`;

    const linkMatch = text.match(linkRegex);
    const link = linkMatch?.[0] ?? null;

    const textNoUrls = stripUrls(text);
    const hasKeyword = keywordRegex.test(textNoUrls); 

    if (link || hasKeyword) {
      out.push({
        from: m.from ?? null,
        subject: m.subject ?? null,
        link,
        preview: (m.body_preview ?? "").slice(0, 160) || null,
      });
    }
  }

  return out.slice(0, 15);
}


  function detectReminders(messages: MailItem[]) {
    const reminderRegex =
      /\b(recordatorio|no\s+olvides|recuerda|mañana|hoy|esta\s+tarde|esta\s+noche|urgente|pendiente)\b/i;

    const out: {
      from?: string | null;
      subject?: string | null;
      preview?: string | null;
      date?: string | null;
    }[] = [];

    for (const m of messages) {
      const text = `${m.subject ?? ""}\n${m.body_preview ?? ""}`;
      if (reminderRegex.test(text)) {
        out.push({
          from: m.from ?? null,
          subject: m.subject ?? null,
          preview: (m.body_preview ?? "").slice(0, 180) || null,
          date: m.received_date_time ?? null,
        });
      }
    }

    return out.slice(0, 15);
  }

  return (
    <div
      style={{
        padding: 12,
        fontFamily: "Gill Sans Extrabold, sans-seri",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <h1>Asistente de Correo</h1>

      {isAuthed && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <label className="range-label">
              <strong>Rango:</strong>{" "}
              <select
                className="range-select"
                value={rangePreset}
                onChange={(e) => setRangePreset(e.target.value as RangePreset)}
              >
                <option value="today">Hoy</option>
                <option value="yesterday">Ayer</option>
                <option value="last7">Últimos 7 días</option>
                <option value="custom">Personalizado</option>
              </select>
            </label>

            {rangePreset === "custom" && (
              <>
                <label>
                  Inicio{" "}
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                </label>
                <label>
                  Fin{" "}
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>

          <div>
            Conectado como:{" "}
            <span style={{ fontSize: 20 }}>
              {accountEmail || "(email no disponible)"}
            </span>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <button
              className="btn-cuenta"
              onClick={onLogout}
              disabled={authBusy}
            >
              Cambiar cuenta
            </button>

            <button
              className="btn-cuenta"
              onClick={() => onAnalyze(false)}
              disabled={analysisBusy}
            >
              {analysisBusy ? "Analizando..." : "Analizar"}
            </button>

            <button
              className="btn-cuenta"
              onClick={() => onAnalyze(true)}
              disabled={analysisBusy}
            >
              Re-analizar
            </button>
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 18, width: "100%" }}>
          {(() => {
            const top = computeTopContacts(result.inbox, result.sent);
            const total = result.inboxCount + result.sentCount;
            const inboxPct =
              total === 0 ? 0 : Math.round((result.inboxCount / total) * 100);
            const sentPct = 100 - inboxPct;
            const meetings = detectMeetings(result.inbox);
            const reminders = detectReminders(result.inbox);

            const card: React.CSSProperties = {
              fontFamily: "Gill Sans Extrabold, sans-seri",
              padding: 14,
              borderRadius: 10,
              background: "#C1E0F6",
              color: "#16283A",
              border: "2px dotted #69A317",
            };
            {
              Array.isArray(priorities) && priorities.length > 0 && (
                <div className="card">
                  <h3>Prioridades del día</h3>

                  <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {priorities.map((p, i) => (
                      <li key={`${p.title}-${i}`} style={{ marginBottom: 12 }}>
                        <div>
                          <strong>{p.action}:</strong> {p.title}
                        </div>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          {p.reason}
                        </div>

                        <div style={{ fontSize: 12, opacity: 0.6 }}>
                          {p.from ?? ""}
                          {p.date ? ` · ${fmtMX(p.date)}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }

            return (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  {/* A. Resumen General */}
                  <div style={card}>
                    <h3 style={{ marginTop: 0 }}>Resumen general</h3>
                    <div style={{ fontSize: 18 }}>
                      <strong>Recibidos:</strong> {result.inboxCount}
                    </div>
                    <div style={{ fontSize: 18, marginTop: 6 }}>
                      <strong>Enviados:</strong> {result.sentCount}
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <div
                        style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}
                      >
                        Distribución (Recibidos/Enviados)
                      </div>

                      {/* mini barra */}
                      <div
                        style={{
                          height: 12,
                          width: "100%",
                          border: "3px solid #69A317",
                          borderRadius: 999,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${inboxPct}%`,
                            background: "#69A317",
                          }}
                        />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                        Inbox {inboxPct}% · Sent {sentPct}%
                      </div>
                    </div>
                  </div>

                  {/* B. Top contactos */}
                  <div style={card}>
                    <h3 style={{ marginTop: 0 }}>
                      Top 10 contactos más activos
                    </h3>
                    {top.length === 0 ? (
                      <div style={{ opacity: 0.7 }}>Sin datos suficientes.</div>
                    ) : (
                      <ol style={{ margin: 0, paddingLeft: 18 }}>
                        {top.map((c) => (
                          <li key={c.email} style={{ marginBottom: 6 }}>
                            <strong>{c.email}</strong> — {c.count}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                    gap: 16,
                    width: "100%",
                    marginTop: 16,
                  }}
                >
                  <div style={card}>
                    <h3 style={{ marginTop: 0 }}>
                      Citas y reuniones detectadas
                    </h3>
                    {meetings.length === 0 ? (
                      <div style={{ opacity: 0.7 }}>
                        No se detectaron reuniones en este rango.
                      </div>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {meetings.map((x, idx) => (
                          <li key={idx} style={{ marginBottom: 10 }}>
                            <div>
                              <strong>{x.subject ?? "(sin asunto)"}</strong>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.8 }}>
                              {x.from}
                            </div>
                            {x.link && (
                              <div style={{ fontSize: 12 }}>🔗 {x.link}</div>
                            )}
                            {x.preview && (
                              <div style={{ fontSize: 12, opacity: 0.85 }}>
                                {x.preview}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div style={card}>
                    <h3 style={{ marginTop: 0 }}>Recordatorios importantes</h3>
                    {reminders.length === 0 ? (
                      <div style={{ opacity: 0.7 }}>
                        No se detectaron recordatorios en este rango.
                      </div>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {reminders.map((x, idx) => (
                          <li key={idx} style={{ marginBottom: 12 }}>
                            <div
                              style={{
                                display: "flex",
                                gap: 10,
                                alignItems: "baseline",
                              }}
                            >
                              <span
                                style={{
                                  minWidth: 140,
                                  fontSize: 12,
                                  opacity: 0.75,
                                }}
                              >
                                {fmtMX(x.date)}
                              </span>

                              <div>
                                <div>
                                  <strong>{x.subject ?? "(sin asunto)"}</strong>
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.8 }}>
                                  {x.from}
                                </div>
                                {x.preview && (
                                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                                    {x.preview}
                                  </div>
                                )}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Lista de últimos correos */}
                <div style={{ ...card, marginTop: 12 }}>
                  <h3 style={{ marginTop: 0 }}>Últimos correos</h3>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {result.inbox.slice(0, 20).map((m) => (
                      <li key={m.id} style={{ marginBottom: 8 }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            alignItems: "baseline",
                          }}
                        >
                          <span
                            style={{
                              minWidth: 140,
                              fontSize: 12,
                              opacity: 0.75,
                            }}
                          >
                            {fmtMX(m.received_date_time)}
                          </span>

                          <span>
                            <strong>{m.from ?? "(sin remitente)"}</strong> —{" "}
                            {m.subject ?? "(sin asunto)"}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* === SUGERENCIAS INTELIGENTES (IA) === */}
                <div style={{ ...card, marginTop: 16 }}>
                  <h3 style={{ marginTop: 0 }}>Sugerencias Inteligentes</h3>

                  <button
                    className="btn-cuenta"
                    onClick={onAskAI}
                    disabled={aiBusy}
                    style={{ marginBottom: 12 }}
                  >
                    {aiBusy
                      ? "Generando sugerencias..."
                      : "Generar sugerencias"}
                  </button>

                  {aiError && (
                    <div style={{ color: "crimson", marginBottom: 8 }}>
                      {aiError}
                    </div>
                  )}

                  {aiOut && (
                    <div style={{ display: "grid", gap: 12 }}>
                      <div>
                        <strong>Resumen ejecutivo</strong>
                        <div>{aiOut.executive_summary}</div>
                      </div>

                      <div>
                        <strong>Prioridades</strong>
                        <ul>
                          <div>
                            <ul>
                              {aiOut.priorities.map((p: any, i: number) => (
                                <li
                                  key={`${p.title}-${i}`}
                                  style={{ marginBottom: 10 }}
                                >
                                  <div>
                                    <strong>{p.action}:</strong> {p.title}
                                  </div>

                                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                                    {p.reason}
                                  </div>

                                  <div style={{ fontSize: 12, opacity: 0.6 }}>
                                    {p.from ?? ""}
                                    {p.date ? ` · ${fmtMX(p.date)}` : ""}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </ul>
                      </div>

                      <div>
                        <strong>Acciones sugeridas</strong>
                        <ul>
                          {aiOut.actions.map((a: string, i: number) => (
                            <li key={i}>{a}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <strong>Seguimientos</strong>
                        <ul>
                          {aiOut.follow_ups.map((f: string, i: number) => (
                            <li key={i}>{f}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {analysisError && (
        <div style={{ marginTop: 12, color: "crimson" }}>{analysisError}</div>
      )}

      {showConnect && (
        <div style={{ marginTop: 12 }}>
          <button className="btn-start" onClick={onConnect} disabled={authBusy}>
            Conectar con Microsoft
          </button>
        </div>
      )}

      {sessionStatus === "auth-pending" && device && (
        <div
          style={{
            marginTop: 18,
            padding: 12,
            borderRadius: 8,
            justifyContent: "center",
          }}
        >
          <div style={{ marginBottom: 8 }}>
            <strong>1)</strong> Abre:{" "}
            <span style={{ fontSize: 18 }}>{device.verificationUri}</span>
          </div>

          <div style={{ marginBottom: 8 }}>
            <strong>2)</strong> Ingresa el código:{" "}
            <span style={{ fontSize: 18 }}>{device.userCode}</span>
          </div>

          <div style={{ marginTop: 10, opacity: 1 }}>
            <br></br>
            Copia y pega la liga que se indica en el navegador de tu
            preferencia, al ingresar verás un cuadrado como el de la imagen, ahí
            es donde colocarás el código único que se proporciona.
            <br></br>
            <br></br>
            Despues concede los permisos para leer los correos y poder
            analizarlos.
            <br></br>
            <br></br>
            No tienes que guardar el código, cada inicio de sesión se genera uno
            nuevo.
          </div>
          <br></br>
          <img
            src={m1}
            alt="m1"
            style={{
              width: "100%",
              height: "auto",
              display: "block",
              marginBottom: 12,
              borderRadius: 8,
              opacity: 1,
            }}
          />
          <img
            src={m2}
            alt="m2"
            style={{
              width: "50%",
              height: "auto",
              display: "block",
              marginBottom: 12,
              borderRadius: 8,
              opacity: 1,
            }}
          />
        </div>
      )}

      {authError && (
        <div style={{ marginTop: 12, color: "crimson" }}>{authError}</div>
      )}
    </div>
  );
}
