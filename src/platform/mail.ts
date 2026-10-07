
const API_BASE = import.meta.env.VITE_API_BASE;

export type MailFetchParams = {
  days?: number;
  startIso?: string;
  endIso?: string;
  top?: number;
};

export async function mailFetchRange(params: MailFetchParams) {
  const isTauri =
    typeof window !== "undefined" && Boolean((window as any).__TAURI__?.core);

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("mail_fetch_range", params);
  }

  // WEB (por ahora puede fallar si no hay backend)
  const res = await fetch(`${API_BASE}/api/mail/fetch-range`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(params),
  });


  if (!res.ok) {
    throw new Error("mailFetchRange web failed");
  }

  return res.json();
}
