import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../lib/types";
import { TaskInspector } from "./TaskInspector";

const completedTask: Task = {
  id: "task-1",
  title: "Done",
  description: "",
  bucket: "today",
  priority: "low",
  area: "work",
  dueDate: null,
  estimateMinutes: null,
  orderKey: "V",
  completedAt: "2026-07-20T21:00:00.000Z",
  deletedAt: null,
  createdAt: "2026-07-20T20:00:00.000Z",
  updatedAt: "2026-07-20T21:00:00.000Z",
};

describe("task inspector", () => {
  it("requires restore before moving a completed task", () => {
    render(
      <TaskInspector
        task={completedTask}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onMove={vi.fn()}
        onComplete={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        completeShortcut="Meta+Enter"
      />,
    );

    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Inbox" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Restore to list/i })).toBeEnabled();
  });

  it("saves a trimmed description when the description field loses focus", () => {
    const onUpdate = vi.fn();
    render(
      <TaskInspector
        task={completedTask}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onMove={vi.fn()}
        onComplete={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        completeShortcut="Meta+Enter"
      />,
    );

    const description = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(description, { target: { value: "  https://example.com/brief  " } });
    fireEvent.blur(description);

    expect(onUpdate).toHaveBeenCalledWith({ description: "https://example.com/brief" });
  });

  it("clears an existing description when the field is emptied", () => {
    const onUpdate = vi.fn();
    render(
      <TaskInspector
        task={{ ...completedTask, description: "Keep this note" }}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onMove={vi.fn()}
        onComplete={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
        completeShortcut="Meta+Enter"
      />,
    );

    const description = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(description, { target: { value: "" } });
    fireEvent.blur(description);

    expect(onUpdate).toHaveBeenCalledWith({ description: "" });
  });
});
