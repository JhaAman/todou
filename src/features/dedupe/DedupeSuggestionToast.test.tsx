import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DedupeSuggestion, DedupeResolutionAction } from "../../lib/taskClient";
import type { Task } from "../../lib/types";
import { DedupeSuggestionToast } from "./DedupeSuggestionToast";

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
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
    ...overrides,
  };
}

function suggestion(id = "suggestion-1"): DedupeSuggestion {
  return {
    id,
    createdAt: "2026-07-23T12:00:02.000Z",
    newTask: task("new-task", "Email the launch update", {
      description: "Include the launch date.",
    }),
    existingTask: task("existing-task", "Send launch status email", {
      description: "Include risks and owners.",
      bucket: "inbox",
      priority: "high",
      estimateMinutes: 20,
    }),
    mergedTask: {
      title: "Send the launch update email",
      description: "Include the launch date, risks, and owners.",
      bucket: "in_progress",
      priority: "high",
      area: "work",
      dueDate: "2026-07-24",
      estimateMinutes: 30,
    },
  };
}

describe("dedupe suggestion toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("dismisses an untouched suggestion after 30 seconds", () => {
    const onDismiss = vi.fn(async () => undefined);
    render(
      <DedupeSuggestionToast
        suggestion={suggestion()}
        onDismiss={onDismiss}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    act(() => vi.advanceTimersByTime(29_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not count down while the main window is hidden", () => {
    const onDismiss = vi.fn(async () => undefined);
    render(
      <DedupeSuggestionToast
        suggestion={suggestion()}
        onDismiss={onDismiss}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    act(() => window.dispatchEvent(new FocusEvent("blur")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new FocusEvent("focus")));
    act(() => vi.advanceTimersByTime(30_000));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not start counting down when mounted after focus was already lost", () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const onDismiss = vi.fn(async () => undefined);
    render(
      <DedupeSuggestionToast
        suggestion={suggestion()}
        onDismiss={onDismiss}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();

    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => window.dispatchEvent(new FocusEvent("focus")));
    act(() => vi.advanceTimersByTime(30_000));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each([
    ["pointer", (toast: HTMLElement) => fireEvent.pointerDown(toast)],
    ["keyboard", (toast: HTMLElement) => fireEvent.keyDown(toast, { key: "Tab" })],
    ["focus", () => fireEvent.focus(screen.getByRole("button", { name: "Merge tasks" }))],
  ])("%s interaction permanently cancels auto-dismiss", (_name, interact) => {
    const onDismiss = vi.fn(async () => undefined);
    render(
      <DedupeSuggestionToast
        suggestion={suggestion()}
        onDismiss={onDismiss}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    interact(screen.getByRole("region", { name: "Possible duplicate tasks" }));
    act(() => vi.advanceTimersByTime(60_000));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("shows the complete merged draft", () => {
    const onResolve = vi.fn(async (_action: DedupeResolutionAction) => undefined);
    render(
      <DedupeSuggestionToast
        suggestion={suggestion()}
        onDismiss={vi.fn(async () => undefined)}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Email the launch update")).toBeInTheDocument();
    expect(screen.getByText("Include the launch date.")).toBeInTheDocument();
    expect(screen.getByText("Send launch status email")).toBeInTheDocument();
    expect(screen.getByText("Include risks and owners.")).toBeInTheDocument();
    expect(screen.getByText("Send the launch update email")).toBeInTheDocument();
    expect(screen.getByText("Include the launch date, risks, and owners.")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("High priority")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Jul 24")).toBeInTheDocument();
    expect(screen.getByText("30 min")).toBeInTheDocument();
  });

  it("makes description clearing visible before merging", () => {
    const withoutDescriptions = suggestion();
    withoutDescriptions.newTask.description = "";
    withoutDescriptions.existingTask.description = "";
    withoutDescriptions.mergedTask.description = "";

    render(
      <DedupeSuggestionToast
        suggestion={withoutDescriptions}
        onDismiss={vi.fn(async () => undefined)}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getAllByText("No description")).toHaveLength(3);
  });

  it.each([
    ["Delete new task", "deleteNew"],
    ["Delete existing task", "deleteExisting"],
    ["Merge tasks", "merge"],
  ] as const)("offers the %s resolution", (buttonName, action) => {
    const onResolve = vi.fn(async (_action: DedupeResolutionAction) => undefined);
    render(
      <DedupeSuggestionToast
        suggestion={suggestion()}
        onDismiss={vi.fn(async () => undefined)}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    expect(onResolve).toHaveBeenCalledWith(action);
  });

  it("advances to the next durable suggestion after resolving the first", async () => {
    function Harness() {
      const [suggestions, setSuggestions] = useState([
        suggestion("first"),
        {
          ...suggestion("second"),
          newTask: task("next-new", "Second queued task"),
        },
      ]);
      const current = suggestions[0];
      return current ? (
        <DedupeSuggestionToast
          suggestion={current}
          onDismiss={async () => setSuggestions((items) => items.slice(1))}
          onResolve={async () => setSuggestions((items) => items.slice(1))}
        />
      ) : null;
    }

    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge tasks" }));
    });

    expect(screen.getByText("Second queued task")).toBeInTheDocument();
  });
});
