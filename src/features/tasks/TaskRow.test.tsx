import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultShortcuts } from "../../lib/shortcuts";
import type { Task } from "../../lib/types";
import { TaskRow } from "./TaskRow";

function task(description: string): Task {
  return {
    id: "task-1",
    title: "Review the brief",
    description,
    bucket: "today",
    priority: "low",
    area: "work",
    dueDate: null,
    estimateMinutes: null,
    orderKey: "V",
    completedAt: null,
    deletedAt: null,
    createdAt: "2026-07-20T20:00:00.000Z",
    updatedAt: "2026-07-20T20:00:00.000Z",
  };
}

function renderRow(description: string) {
  return render(
    <TaskRow
      task={task(description)}
      selected={false}
      shortcuts={defaultShortcuts}
      onSelect={vi.fn()}
      onComplete={vi.fn()}
      onRestore={vi.fn()}
      onMove={vi.fn()}
      onTogglePriority={vi.fn()}
      onToggleArea={vi.fn()}
      onDelete={vi.fn()}
      onDropTask={vi.fn()}
    />,
  );
}

describe("task row", () => {
  it("shows a description indicator only when the description contains text", () => {
    const { rerender } = renderRow("https://example.com/brief");

    expect(screen.getByRole("img", { name: "Has description" })).toBeInTheDocument();

    rerender(
      <TaskRow
        task={task("  \n  ")}
        selected={false}
        shortcuts={defaultShortcuts}
        onSelect={vi.fn()}
        onComplete={vi.fn()}
        onRestore={vi.fn()}
        onMove={vi.fn()}
        onTogglePriority={vi.fn()}
        onToggleArea={vi.fn()}
        onDelete={vi.fn()}
        onDropTask={vi.fn()}
      />,
    );

    expect(screen.queryByRole("img", { name: "Has description" })).not.toBeInTheDocument();
  });
});

describe("task context menu", () => {
  it("offers available task actions with the saved shortcut and performs the chosen action", () => {
    const onMove = vi.fn();
    render(
      <TaskRow
        task={{ ...task(""), title: "Plan the release" }}
        selected={false}
        shortcuts={{ ...defaultShortcuts, moveInbox: "Ctrl+Shift+I" }}
        onSelect={vi.fn()}
        onComplete={vi.fn()}
        onRestore={vi.fn()}
        onMove={onMove}
        onTogglePriority={vi.fn()}
        onToggleArea={vi.fn()}
        onDelete={vi.fn()}
        onDropTask={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("option", { name: /Plan the release/i }), { clientX: 100, clientY: 200 });

    const menu = screen.getByRole("menu");
    const moveToInbox = screen.getByRole("menuitem", { name: /Move to Inbox/i });
    expect(menu).toBeVisible();
    expect(moveToInbox).toHaveTextContent("⌃⇧I");
    expect(screen.getByRole("menuitem", { name: /Mark complete/i })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowDown" });

    expect(moveToInbox).toHaveFocus();

    fireEvent.click(moveToInbox);

    expect(onMove).toHaveBeenCalledWith("inbox");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
