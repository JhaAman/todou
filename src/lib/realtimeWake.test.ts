import { describe, expect, it, vi } from "vitest";
import { connectRealtimeWake, type RealtimeClientLike } from "./realtimeWake";

describe("Realtime wake-up", () => {
  it("treats WebSocket changes as pull wake-ups and tears down cleanly", async () => {
    let change: (() => void) | undefined;
    let status: ((value: string) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, filter, callback: () => void) => {
        expect(filter).toEqual({ event: "INSERT", schema: "public", table: "sync_changes" });
        change = callback;
        return channel;
      }),
      subscribe: vi.fn((callback: (value: string) => void) => {
        status = callback;
        return channel;
      }),
    };
    const client: RealtimeClientLike = {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(async () => "ok"),
    };
    const wake = vi.fn(async () => undefined);

    const disconnect = connectRealtimeWake(client, wake);
    status?.("SUBSCRIBED");
    change?.();
    await Promise.resolve();

    expect(wake).toHaveBeenCalledTimes(2);
    await disconnect();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });
});
