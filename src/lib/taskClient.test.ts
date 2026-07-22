import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockReset();
  vi.resetModules();
});

describe("sync diagnostics client", () => {
  it("reports honestly that browser preview has no sync worker", async () => {
    const { taskClient } = await import("./taskClient");

    await expect(taskClient.getSyncDiagnostics()).resolves.toEqual({
      runtime: "browser",
      syncAvailable: false,
    });
  });

  it("exposes native sync diagnostics through the Tauri command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockResolvedValue({
      pendingOutbox: 3,
      quarantinedOutbox: 1,
      cursor: { epoch: "sync-epoch", sequence: 17 },
      lastSuccessfulSync: "1721430000000-0-device",
      lastError: "Remote request timed out",
    });
    const { taskClient } = await import("./taskClient");

    await expect(taskClient.getSyncDiagnostics()).resolves.toMatchObject({
      runtime: "tauri",
      syncAvailable: true,
      pendingOutbox: 3,
      quarantinedOutbox: 1,
      cursor: { epoch: "sync-epoch", sequence: 17 },
      lastError: "Remote request timed out",
    });
    expect(invoke).toHaveBeenCalledWith("sync_diagnostics", undefined);
  });

  it("saves native sync settings atomically with one command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockResolvedValue(undefined);
    const { taskClient } = await import("./taskClient");

    await taskClient.setSyncSettings({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_sync_settings", {
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });
  });
});
