import { afterEach, describe, expect, it, vi } from "vitest";
import { tasksForBucket } from "./taskOrdering";
import type { Task } from "./types";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockReset();
  listen.mockReset();
  vi.resetModules();
});

const browserTaskStoreKey = "todou.browser.tasks.v1";
const browserTaskSeedKey = "todou.browser.seeded.v1";

function browserTask(overrides: Partial<Task> & Pick<Task, "id" | "title" | "bucket">): Task {
  return {
    description: "",
    priority: "low",
    area: "work",
    dueDate: null,
    estimateMinutes: null,
    orderKey: "000001",
    completedAt: null,
    deletedAt: null,
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    ...overrides,
  };
}

function seedBrowserTasks(tasks: Task[]): void {
  localStorage.setItem(browserTaskSeedKey, "true");
  localStorage.setItem(browserTaskStoreKey, JSON.stringify(tasks));
}

describe("browser In Progress ordering", () => {
  it("keeps manual order after a priority change and module reload", async () => {
    seedBrowserTasks([
      browserTask({ id: "first", title: "First", bucket: "in_progress", orderKey: "000001" }),
      browserTask({ id: "second", title: "Second", bucket: "in_progress", orderKey: "000002" }),
    ]);
    const { taskClient } = await import("./taskClient");

    const updated = await taskClient.updateTask("first", { priority: "high" });
    expect(updated.orderKey).toBe("000001");

    vi.resetModules();
    const { taskClient: reloadedClient } = await import("./taskClient");
    const reloaded = tasksForBucket(await reloadedClient.listTasks(), "in_progress");
    expect(reloaded.map(({ id }) => id)).toEqual(["first", "second"]);
  });

  it("appends a task moved into In Progress without changing existing keys", async () => {
    seedBrowserTasks([
      browserTask({ id: "first", title: "First", bucket: "in_progress", priority: "low", orderKey: "000001" }),
      browserTask({ id: "second", title: "Second", bucket: "in_progress", priority: "high", orderKey: "000002" }),
      browserTask({ id: "third", title: "Third", bucket: "inbox", priority: "high", orderKey: "000001" }),
    ]);
    const { taskClient } = await import("./taskClient");

    await taskClient.moveTask("third", "in_progress");
    const tasks = tasksForBucket(await taskClient.listTasks(), "in_progress");

    expect(tasks.map(({ id }) => id)).toEqual(["first", "second", "third"]);
    expect(tasks.map(({ orderKey }) => orderKey)).toEqual(["000001", "000002", "000003"]);
  });
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

describe("AI de-duplication client", () => {
  it("reads messages from native serialized errors", async () => {
    const { readErrorMessage } = await import("./taskClient");

    expect(readErrorMessage(
      { code: "invalid_transition", message: "In Progress is full" },
      "Fallback",
    )).toBe("In Progress is full");
    expect(readErrorMessage("Provider unavailable", "Fallback")).toBe("Provider unavailable");
    expect(readErrorMessage({ code: "unknown" }, "Fallback")).toBe("Fallback");
  });

  it("keeps the browser preview native-only and never persists API keys", async () => {
    localStorage.clear();
    const { taskClient } = await import("./taskClient");

    await expect(taskClient.getLlmSettings()).resolves.toEqual({
      openai: { configured: false, source: null },
      anthropic: { configured: false, source: null },
      pendingJobs: 0,
      failedJobs: 0,
    });
    await expect(taskClient.listDedupeSuggestions()).resolves.toEqual([]);
    await expect(taskClient.saveLlmSettings({ openaiApiKey: "sk-secret" })).rejects.toThrow(/desktop app/i);
    expect(Object.keys(localStorage).some((key) => key.includes("llm"))).toBe(false);
  });

  it("uses the native command contracts without returning credentials", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const status = {
      openai: { configured: true, source: "saved" },
      anthropic: { configured: false, source: null },
      pendingJobs: 1,
      failedJobs: 0,
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === "get_llm_settings" || command === "save_llm_settings") return status;
      if (command === "list_dedupe_suggestions") return [];
      if (command === "run_dedupe_scan") {
        return { status: "completed" };
      }
      if (command === "resolve_dedupe_suggestion") {
        return {
          status: "stale",
          revision: 7,
          survivor: null,
          deletedTaskId: null,
          syncRequired: false,
        };
      }
      return undefined;
    });
    const { taskClient } = await import("./taskClient");

    await expect(taskClient.getLlmSettings()).resolves.toEqual(status);
    await expect(taskClient.saveLlmSettings({ anthropicApiKey: "sk-ant-new" })).resolves.toEqual(status);
    await taskClient.dismissDedupeSuggestion("suggestion-1");
    await expect(
      taskClient.resolveDedupeSuggestion("suggestion-2", "merge"),
    ).resolves.toMatchObject({ status: "stale", revision: 7 });
    await taskClient.processPendingDedupe();
    await expect(taskClient.runDedupeScan()).resolves.toEqual({ status: "completed" });

    expect(invoke).toHaveBeenCalledWith("get_llm_settings", undefined);
    expect(invoke).toHaveBeenCalledWith("save_llm_settings", {
      input: { anthropicApiKey: "sk-ant-new" },
    });
    expect(invoke).toHaveBeenCalledWith("dismiss_dedupe_suggestion", { id: "suggestion-1" });
    expect(invoke).toHaveBeenCalledWith("resolve_dedupe_suggestion", {
      id: "suggestion-2",
      action: "merge",
    });
    expect(invoke).toHaveBeenCalledWith("process_pending_dedupe", undefined);
    expect(invoke).toHaveBeenCalledWith("run_dedupe_scan", undefined);
  });

  it("subscribes to durable suggestion and credentials wake events", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    listen.mockResolvedValue(vi.fn());
    const { taskClient } = await import("./taskClient");

    await taskClient.subscribeDedupeSuggestions(vi.fn());
    await taskClient.subscribeLlmCredentialsRequired(vi.fn());

    expect(listen).toHaveBeenCalledWith("todou://dedupe-suggestions-changed", expect.any(Function));
    expect(listen).toHaveBeenCalledWith("todou://llm-credentials-required", expect.any(Function));
  });
});
