import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DedupeSuggestion, LlmSettingsStatus } from "./lib/taskClient";
import type { Task } from "./lib/types";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  isFocused: vi.fn(),
  listTasks: vi.fn(),
  subscribeTasks: vi.fn(),
  getSyncSettings: vi.fn(),
  subscribeSyncStatus: vi.fn(),
  getSyncStatus: vi.fn(),
  registerQuickEntryShortcut: vi.fn(),
  getLlmSettings: vi.fn(),
  listDedupeSuggestions: vi.fn(),
  dismissDedupeSuggestion: vi.fn(),
  resolveDedupeSuggestion: vi.fn(),
  processPendingDedupe: vi.fn(),
  runDedupeScan: vi.fn(),
  subscribeDedupeSuggestions: vi.fn(),
  subscribeLlmCredentialsRequired: vi.fn(),
  listeners: new Map<string, () => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: mocks.isFocused }),
}));
vi.mock("./lib/taskClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/taskClient")>();
  return {
    ...actual,
    isTauriRuntime: () => true,
    taskClient: {
      ...actual.taskClient,
      listTasks: mocks.listTasks,
      subscribe: mocks.subscribeTasks,
      getSyncSettings: mocks.getSyncSettings,
      subscribeSyncStatus: mocks.subscribeSyncStatus,
      getSyncStatus: mocks.getSyncStatus,
      registerQuickEntryShortcut: mocks.registerQuickEntryShortcut,
      getLlmSettings: mocks.getLlmSettings,
      listDedupeSuggestions: mocks.listDedupeSuggestions,
      dismissDedupeSuggestion: mocks.dismissDedupeSuggestion,
      resolveDedupeSuggestion: mocks.resolveDedupeSuggestion,
      processPendingDedupe: mocks.processPendingDedupe,
      runDedupeScan: mocks.runDedupeScan,
      subscribeDedupeSuggestions: mocks.subscribeDedupeSuggestions,
      subscribeLlmCredentialsRequired: mocks.subscribeLlmCredentialsRequired,
    },
  };
});

import App from "./App";

function task(id: string, title: string): Task {
  return {
    id,
    title,
    description: "",
    bucket: "today",
    priority: "low",
    area: "work",
    dueDate: null,
    estimateMinutes: null,
    orderKey: "000001",
    completedAt: null,
    deletedAt: null,
    createdAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:00.000Z",
  };
}

function suggestion(): DedupeSuggestion {
  return {
    id: "suggestion-1",
    createdAt: "2026-07-23T12:00:02.000Z",
    newTask: task("new-task", "Email the launch update"),
    existingTask: task("existing-task", "Send launch status email"),
    mergedTask: {
      title: "Send the launch update email",
      description: "Include final status, risks, and owners.",
      bucket: "today",
      priority: "low",
      area: "work",
      dueDate: null,
      estimateMinutes: 15,
    },
  };
}

let suggestions: DedupeSuggestion[];
let llmStatus: LlmSettingsStatus;
let processHadWakeListeners: boolean;

beforeEach(() => {
  localStorage.clear();
  suggestions = [];
  llmStatus = {
    openai: { configured: true, source: "saved" },
    anthropic: { configured: false, source: null },
    pendingJobs: 0,
    failedJobs: 0,
  };
  processHadWakeListeners = false;
  mocks.listeners.clear();
  Object.values(mocks).forEach((value) => {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  });
  mocks.isFocused.mockResolvedValue(true);
  mocks.listTasks.mockResolvedValue([]);
  mocks.subscribeTasks.mockResolvedValue(() => undefined);
  mocks.getSyncSettings.mockResolvedValue({ url: "", publishableKey: "" });
  mocks.subscribeSyncStatus.mockImplementation(async (listener: (status: string) => void) => {
    listener("not-connected");
    return () => undefined;
  });
  mocks.getSyncStatus.mockResolvedValue("not-connected");
  mocks.registerQuickEntryShortcut.mockResolvedValue(undefined);
  mocks.getLlmSettings.mockImplementation(async () => llmStatus);
  mocks.listDedupeSuggestions.mockImplementation(async () => suggestions);
  mocks.dismissDedupeSuggestion.mockResolvedValue(undefined);
  mocks.resolveDedupeSuggestion.mockResolvedValue({
    status: "resolved",
    revision: 1,
    survivor: null,
    deletedTaskId: null,
    syncRequired: true,
  });
  mocks.subscribeDedupeSuggestions.mockImplementation(async (listener: () => void) => {
    mocks.listeners.set("todou://dedupe-suggestions-changed", listener);
    return () => mocks.listeners.delete("todou://dedupe-suggestions-changed");
  });
  mocks.subscribeLlmCredentialsRequired.mockImplementation(async (listener: () => void) => {
    mocks.listeners.set("todou://llm-credentials-required", listener);
    return () => mocks.listeners.delete("todou://llm-credentials-required");
  });
  mocks.processPendingDedupe.mockImplementation(async () => {
    processHadWakeListeners = mocks.listeners.has("todou://dedupe-suggestions-changed")
      && mocks.listeners.has("todou://llm-credentials-required");
  });
  mocks.runDedupeScan.mockResolvedValue({ status: "completed" });
});

async function runDedupeScanFromPalette() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  fireEvent.click(await screen.findByRole("option", { name: /Check all tasks for duplicates/i }));
}

describe("App AI de-duplication lifecycle", () => {
  it("registers the new native Quick Entry default on startup", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.registerQuickEntryShortcut).toHaveBeenCalledWith("Control+Shift+Space"));
  });

  it("attaches wake listeners before processing focused startup jobs", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.processPendingDedupe).toHaveBeenCalledOnce());
    expect(processHadWakeListeners).toBe(true);
  });

  it("reloads durable suggestions after the backend wake event", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.listeners.has("todou://dedupe-suggestions-changed")).toBe(true));

    suggestions = [suggestion()];
    act(() => {
      mocks.listeners.get("todou://dedupe-suggestions-changed")?.();
    });

    expect(await screen.findByRole("region", { name: "Possible duplicate tasks" })).toHaveTextContent(
      "Email the launch update",
    );
  });

  it("processes queued Quick Entry and MCP work on window focus", async () => {
    mocks.isFocused.mockResolvedValue(false);
    render(<App />);
    await waitFor(() => expect(mocks.listeners.has("todou://dedupe-suggestions-changed")).toBe(true));
    mocks.processPendingDedupe.mockClear();

    act(() => window.dispatchEvent(new FocusEvent("focus")));

    await waitFor(() => expect(mocks.processPendingDedupe).toHaveBeenCalledOnce());
  });

  it("retries wake listener setup on focus without leaking a partial subscription", async () => {
    mocks.isFocused.mockResolvedValue(false);
    const suggestionCleanups: Array<ReturnType<typeof vi.fn>> = [];
    mocks.subscribeDedupeSuggestions.mockImplementation(async (listener: () => void) => {
      mocks.listeners.set("todou://dedupe-suggestions-changed", listener);
      const cleanup = vi.fn(() => {
        mocks.listeners.delete("todou://dedupe-suggestions-changed");
      });
      suggestionCleanups.push(cleanup);
      return cleanup;
    });
    mocks.subscribeLlmCredentialsRequired.mockRejectedValueOnce(
      new Error("listener unavailable"),
    );
    render(<App />);

    await waitFor(() => expect(suggestionCleanups[0]).toHaveBeenCalledOnce());
    expect(mocks.listeners.has("todou://dedupe-suggestions-changed")).toBe(false);
    mocks.isFocused.mockResolvedValue(true);

    act(() => window.dispatchEvent(new FocusEvent("focus")));

    await waitFor(() => expect(mocks.subscribeLlmCredentialsRequired).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.processPendingDedupe).toHaveBeenCalledOnce());
    expect(mocks.listeners.has("todou://dedupe-suggestions-changed")).toBe(true);
    expect(mocks.listeners.has("todou://llm-credentials-required")).toBe(true);
  });

  it("opens AI settings when startup finds queued work with no provider", async () => {
    llmStatus = {
      openai: { configured: false, source: null },
      anthropic: { configured: false, source: null },
      pendingJobs: 1,
      failedJobs: 0,
    };
    mocks.isFocused.mockResolvedValue(false);

    render(<App />);

    expect(await screen.findByRole("dialog", { name: "AI task de-duplication" })).toBeInTheDocument();
  });

  it("opens AI settings when the coordinator reports unusable credentials", async () => {
    mocks.isFocused.mockResolvedValue(false);
    render(<App />);
    await waitFor(() => expect(mocks.listeners.has("todou://llm-credentials-required")).toBe(true));

    act(() => {
      mocks.listeners.get("todou://llm-credentials-required")?.();
    });

    expect(await screen.findByRole("dialog", { name: "AI task de-duplication" })).toBeInTheDocument();
  });

  it("shows progress and no-match feedback for an on-demand scan", async () => {
    let finishScan: ((outcome: { status: "completed" }) => void) | undefined;
    mocks.runDedupeScan.mockImplementation(() => new Promise((resolve) => {
      finishScan = resolve;
    }));
    render(<App />);

    await runDedupeScanFromPalette();
    expect(await screen.findByRole("status")).toHaveTextContent("Checking all tasks for duplicates");

    finishScan?.({ status: "completed" });
    expect(await screen.findByRole("status")).toHaveTextContent("No duplicate tasks found");
  });

  it("opens the existing suggestion popup when an on-demand scan finds a match", async () => {
    mocks.runDedupeScan.mockImplementation(async () => {
      suggestions = [suggestion()];
      return { status: "completed" };
    });
    render(<App />);

    await runDedupeScanFromPalette();

    expect(await screen.findByRole("region", { name: "Possible duplicate tasks" })).toHaveTextContent(
      "Email the launch update",
    );
  });

  it("reports durable suggestions instead of claiming an on-demand scan found nothing", async () => {
    suggestions = [suggestion()];
    mocks.runDedupeScan.mockResolvedValue({ status: "completed" });
    render(<App />);
    await screen.findByRole("region", { name: "Possible duplicate tasks" });

    await runDedupeScanFromPalette();

    expect(await screen.findByRole("status")).toHaveTextContent("Found 1 possible duplicate");
  });

  it.each([
    ["alreadyRunning", "A duplicate scan is already running"],
    ["configurationRequired", "Configure AI de-duplication to run this scan"],
    ["failed", "The duplicate scan could not finish"],
  ] as const)("reports the %s on-demand scan outcome", async (status, message) => {
    mocks.runDedupeScan.mockResolvedValue({ status });
    render(<App />);

    await runDedupeScanFromPalette();

    expect(await screen.findByRole("status")).toHaveTextContent(message);
    if (status === "configurationRequired") {
      expect(await screen.findByRole("dialog", { name: "AI task de-duplication" })).toBeInTheDocument();
    }
  });

  it("reports an unexpected on-demand scan error without disrupting startup processing", async () => {
    mocks.runDedupeScan.mockRejectedValue(new Error("storage unavailable"));
    render(<App />);
    await waitFor(() => expect(mocks.processPendingDedupe).toHaveBeenCalledOnce());

    await runDedupeScanFromPalette();

    expect(await screen.findByRole("status")).toHaveTextContent("The duplicate scan could not start");
    expect(mocks.processPendingDedupe).toHaveBeenCalledOnce();
  });

  it("distinguishes a result refresh failure from a scan start failure", async () => {
    mocks.runDedupeScan.mockImplementation(async () => {
      mocks.listDedupeSuggestions.mockRejectedValueOnce(new Error("read unavailable"));
      return { status: "completed" };
    });
    render(<App />);

    await runDedupeScanFromPalette();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The duplicate scan finished, but results could not be refreshed",
    );
  });

  it("immediately requeues a stale resolution instead of treating it as merged", async () => {
    suggestions = [suggestion()];
    mocks.resolveDedupeSuggestion.mockImplementation(async () => {
      suggestions = [];
      return {
        status: "stale",
        revision: 7,
        survivor: null,
        deletedTaskId: null,
        syncRequired: false,
      };
    });

    render(<App />);
    await screen.findByRole("region", { name: "Possible duplicate tasks" });
    await waitFor(() => expect(mocks.processPendingDedupe).toHaveBeenCalled());
    mocks.processPendingDedupe.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Merge tasks" }));

    expect(
      await screen.findByText("Tasks changed — checking for duplicates again"),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.processPendingDedupe).toHaveBeenCalledOnce());
  });
});
