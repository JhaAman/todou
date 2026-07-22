export interface SyncSettings {
  url: string;
  publishableKey: string;
}

export interface SyncConnectionCheck {
  target: "local" | "hosted";
  protocolVersion: number;
  epoch: string;
  watermark: number;
  taskCount: number;
}

export interface NativeSyncDiagnostics {
  runtime: "tauri";
  syncAvailable: true;
  pendingOutbox: number;
  quarantinedOutbox: number;
  cursor: { epoch: string | null; sequence: number };
  lastSuccessfulSync: string | null;
  lastError: string | null;
}

export interface BrowserSyncDiagnostics {
  runtime: "browser";
  syncAvailable: false;
}

export type SyncDiagnostics = NativeSyncDiagnostics | BrowserSyncDiagnostics;

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

export async function checkSupabaseConnection(
  settings: SyncSettings,
  request: typeof fetch = fetch,
): Promise<SyncConnectionCheck> {
  const normalized = normalizeSyncSettings(settings);
  if (!normalized.url) throw new Error("Enter Supabase settings before testing the connection.");
  const endpoint = `${normalized.url}/rest/v1/rpc/bootstrap_tasks`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    let response: Response;
    try {
      response = await request(endpoint, {
        method: "POST",
        headers: {
          apikey: normalized.publishableKey,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });
    } catch (reason) {
      if (controller.signal.aborted) {
        throw new Error("Supabase connection test timed out after 20 seconds.");
      }
      const detail = reason instanceof Error ? reason.message : "Network request failed";
      throw new Error(`Could not reach Supabase: ${detail}`);
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        if (controller.signal.aborted) {
          throw new Error("Supabase connection test timed out after 20 seconds.");
        }
      }
      let detail = body.trim();
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const message = parsed.message ?? parsed.error_description ?? parsed.error;
        if (typeof message === "string") detail = message;
      } catch {
        // The HTTP status remains useful when Supabase returns a non-JSON proxy response.
      }
      detail = detail.replace(/\s+/g, " ").trim();
      if (detail.length > 400) detail = `${detail.slice(0, 399)}…`;
      throw new Error(`Supabase returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new Error("Supabase connection test timed out after 20 seconds.");
      }
      throw new Error("Supabase returned an invalid bootstrap payload.");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("Supabase returned an invalid bootstrap payload.");
    }
    const record = payload as Record<string, unknown>;
    if (
      record.protocol_version !== 1
      || typeof record.epoch !== "string"
      || !record.epoch
      || !Number.isSafeInteger(record.watermark)
      || (record.watermark as number) < 0
      || !Array.isArray(record.tasks)
    ) {
      throw new Error("Supabase returned an invalid bootstrap payload for Todou protocol 1.");
    }

    const hostname = new URL(normalized.url).hostname.toLocaleLowerCase();
    const target = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
      ? "local"
      : "hosted";
    return {
      target,
      protocolVersion: 1,
      epoch: record.epoch,
      watermark: record.watermark as number,
      taskCount: record.tasks.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function toNativeShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => ({ Ctrl: "Control", Meta: "Command" })[part] ?? part)
    .join("+");
}
