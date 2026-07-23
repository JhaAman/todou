import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockReset();
  listen.mockReset();
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

  it("reports browser preview as not connected", async () => {
    const { taskClient } = await import("./taskClient");
    const listener = vi.fn();

    await taskClient.subscribeSyncStatus(listener);

    expect(listener).toHaveBeenCalledWith("not-connected");
  });

  it("subscribes to native sync worker status events", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    listen.mockImplementation(async (_event, listener) => {
      listener({ payload: "up-to-date" });
      return vi.fn();
    });
    const { taskClient } = await import("./taskClient");
    const listener = vi.fn();

    await taskClient.subscribeSyncStatus(listener);

    expect(listen).toHaveBeenCalledWith("todou://sync-status", expect.any(Function));
    expect(listener).toHaveBeenCalledWith("up-to-date");
  });

  it("reads the native worker status after subscribing", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockResolvedValue("updating");
    const { taskClient } = await import("./taskClient");

    await expect(taskClient.getSyncStatus()).resolves.toBe("updating");

    expect(invoke).toHaveBeenCalledWith("sync_status", undefined);
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
