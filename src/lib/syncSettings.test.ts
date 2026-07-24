import { describe, expect, it, vi } from "vitest";
import { checkSupabaseConnection, normalizeSyncSettings, toNativeShortcut } from "./syncSettings";

describe("sync settings", () => {
  it("normalizes a configured Supabase connection", () => {
    expect(normalizeSyncSettings({
      url: "  http://127.0.0.1:54321/ ",
      publishableKey: " local-key ",
    })).toEqual({
      url: "http://127.0.0.1:54321",
      publishableKey: "local-key",
    });
  });

  it("allows sync to be disabled but rejects half-configured credentials", () => {
    expect(normalizeSyncSettings({ url: "", publishableKey: "" })).toEqual({
      url: "",
      publishableKey: "",
    });
    expect(() => normalizeSyncSettings({ url: "https://example.supabase.co", publishableKey: "" }))
      .toThrow("both");
  });

  it("translates editable UI shortcuts into native accelerators", () => {
    expect(toNativeShortcut("Ctrl+Space")).toBe("Control+Space");
    expect(toNativeShortcut("Meta+Shift+K")).toBe("Command+Shift+K");
  });

  it("checks the read-only bootstrap contract and identifies a local project", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: 2,
      epoch: "84cfc657-b08f-403a-bab1-915c705f969b",
      watermark: 12,
      tasks: [{ id: "task-1" }, { id: "task-2" }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    await expect(checkSupabaseConnection({
      url: "http://127.0.0.1:54321/",
      publishableKey: "local-key",
    }, request)).resolves.toEqual({
      target: "local",
      protocolVersion: 2,
      epoch: "84cfc657-b08f-403a-bab1-915c705f969b",
      watermark: 12,
      taskCount: 2,
    });
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/bootstrap_tasks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: "local-key" }),
        body: "{}",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("stops a connection test after 20 seconds", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as typeof fetch;
      const result = expect(checkSupabaseConnection({
        url: "https://example.supabase.co",
        publishableKey: "publishable-key",
      }, request)).rejects.toThrow("timed out after 20 seconds");

      await vi.advanceTimersByTimeAsync(20_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("identifies hosted projects and rejects an invalid bootstrap payload", async () => {
    const hostedRequest = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: 2,
      epoch: "hosted-epoch",
      watermark: 0,
      tasks: [],
    }), { status: 200 })) as typeof fetch;
    await expect(checkSupabaseConnection({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    }, hostedRequest)).resolves.toMatchObject({ target: "hosted", taskCount: 0 });

    const invalidRequest = vi.fn(async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 })) as typeof fetch;
    await expect(checkSupabaseConnection({
      url: "http://localhost:54321",
      publishableKey: "local-key",
    }, invalidRequest)).rejects.toThrow("bootstrap payload");
  });

  it("caps HTTP error details before showing them", async () => {
    const request = vi.fn(async () => new Response(`<html>${"proxy failure ".repeat(100)}</html>`, { status: 502 })) as typeof fetch;

    const result = await checkSupabaseConnection({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    }, request).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("HTTP 502");
    expect((result as Error).message.length).toBeLessThan(450);
  });
});
