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
});

describe("App AI de-duplication lifecycle", () => {
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
