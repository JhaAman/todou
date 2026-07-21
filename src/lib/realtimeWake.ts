import type { SyncSettings } from "./syncSettings";

export interface RealtimeChannelLike {
  on(kind: string, filter: Record<string, string>, callback: () => void): RealtimeChannelLike;
  subscribe(callback: (status: string) => void): RealtimeChannelLike;
}

export interface RealtimeClientLike {
  channel(name: string): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>;
}

export function connectRealtimeWake(
  client: RealtimeClientLike,
  wake: () => Promise<void>,
): () => Promise<void> {
  const channel = client
    .channel("todou-sync-wake")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "sync_changes" },
      () => { void wake(); },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") void wake();
    });
  return async () => { await client.removeChannel(channel); };
}

export async function startRealtimeWake(
  settings: SyncSettings,
  wake: () => Promise<void>,
): Promise<() => Promise<void>> {
  if (!settings.url || !settings.publishableKey) return async () => undefined;
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(settings.url, settings.publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return connectRealtimeWake(client as unknown as RealtimeClientLike, wake);
}
