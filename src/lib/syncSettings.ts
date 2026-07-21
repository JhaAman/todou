export interface SyncSettings {
  url: string;
  publishableKey: string;
}

export const emptySyncSettings: SyncSettings = { url: "", publishableKey: "" };

export function normalizeSyncSettings(settings: SyncSettings): SyncSettings {
  const url = settings.url.trim().replace(/\/+$/, "");
  const publishableKey = settings.publishableKey.trim();
  if (!url && !publishableKey) return emptySyncSettings;
  if (!url || !publishableKey) throw new Error("Supabase URL and publishable key are both required.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a valid Supabase URL.");
  }
  if (!(["http:", "https:"] as const).some((protocol) => protocol === parsed.protocol)) {
    throw new Error("Supabase URL must use http or https.");
  }
  return { url, publishableKey };
}

export function environmentSyncSettings(): SyncSettings {
  return {
    url: import.meta.env.VITE_SUPABASE_URL ?? "",
    publishableKey:
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
      ?? import.meta.env.VITE_SUPABASE_ANON_KEY
      ?? "",
  };
}

export function toNativeShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => ({ Ctrl: "Control", Meta: "Command" })[part] ?? part)
    .join("+");
}
