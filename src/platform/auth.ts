// authClient.ts

function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ✅ Cambia esta IP por la IP local de tu PC (ipconfig)
// Ejemplo: "http://192.168.1.50:3001"
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://192.168.100.7:3001";
async function tauriInvoke<T>(cmd: string, payload?: any): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd as any, payload);
}

// ---------------- AUTH ----------------

export async function authStatus() {
  if (isTauri()) return tauriInvoke("auth_status");

  const r = await fetch(`${API_BASE}/api/auth/status`);
  if (!r.ok) throw new Error("authStatus web failed");
  return r.json();
}

export async function authConnectStart() {
  if (isTauri()) {
    return tauriInvoke<any>("auth_connect_start");
  }

  // ✅ WEB/CEL
  const r = await fetch(`${API_BASE}/api/auth/start`, { method: "POST" });
  if (!r.ok) throw new Error("authConnectStart web failed");
  return r.json();
}

export async function authConnectPoll() {
  if (isTauri()) {
    return tauriInvoke<any>("auth_connect_poll");
  }

  // ✅ WEB/CEL
  const r = await fetch(`${API_BASE}/api/auth/poll`, { method: "POST" });
  if (!r.ok) throw new Error("authConnectPoll web failed");
  return r.json();
}

export async function authLogout() {
  if (isTauri()) return tauriInvoke("auth_logout");

  const r = await fetch(`${API_BASE}/api/auth/logout`, { method: "POST" });
  if (!r.ok) throw new Error("authLogout web failed");
  return r.json();
}
