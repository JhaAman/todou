import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickEntry } from "./QuickEntry";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  updateTask: vi.fn(),
  hideCurrentWindow: vi.fn(),
  listeners: new Map<string, (event: { payload: { sessionId: number } }) => void>(),
}));

vi.mock("../../lib/taskClient", () => ({
  isTauriRuntime: () => true,
  taskClient: {
    createTask: mocks.createTask,
    updateTask: mocks.updateTask,
    hideCurrentWindow: mocks.hideCurrentWindow,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, listener: (event: { payload: { sessionId: number } }) => void) => {
    mocks.listeners.set(event, listener);
    return () => mocks.listeners.delete(event);
  }),
}));

describe("quick entry sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.createTask.mockResolvedValue({ id: "task-a" });
    mocks.hideCurrentWindow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mocks.listeners.clear();
    vi.useRealTimers();
  });

  it("does not let an older save clear or close a newer session", async () => {
    let finishUpdate: (() => void) | undefined;
    mocks.updateTask.mockImplementation(() => new Promise<void>((resolve) => {
      finishUpdate = resolve;
    }));
    render(<QuickEntry />);
    await waitFor(() => expect(mocks.listeners.has("todou://quick-entry-shown")).toBe(true));

    act(() => mocks.listeners.get("todou://quick-entry-shown")?.({ payload: { sessionId: 1 } }));
    fireEvent.paste(screen.getByLabelText("New task"), {
      clipboardData: { getData: () => "First https://example.com/first" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add to Inbox/i }));
    await waitFor(() => expect(mocks.updateTask).toHaveBeenCalled());

    act(() => mocks.listeners.get("todou://quick-entry-shown")?.({ payload: { sessionId: 2 } }));
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Second task" } });
    await act(async () => finishUpdate?.());
    await act(async () => vi.advanceTimersByTimeAsync(120));

    expect(screen.getByLabelText("New task")).toHaveValue("Second task");
    expect(mocks.hideCurrentWindow).not.toHaveBeenCalled();
  });
});
