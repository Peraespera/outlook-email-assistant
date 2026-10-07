const isTauri =
  typeof window !== "undefined" && Boolean((window as any).__TAURI__?.core);

async function tauriInvoke<T>(cmd: string, payload?: any): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd as any, payload);
}

export async function aiSuggestions(payload: any) {
  if (isTauri) return tauriInvoke("ai_suggestions", payload);

  const r = await fetch("/api/ai/suggestions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("aiSuggestions web failed");
  return r.json();
}
