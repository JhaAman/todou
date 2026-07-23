import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
      onSelect={vi.fn()}
      onComplete={vi.fn()}
      onRestore={vi.fn()}
      onMove={vi.fn()}
      onTogglePriority={vi.fn()}
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
        onSelect={vi.fn()}
        onComplete={vi.fn()}
        onRestore={vi.fn()}
        onMove={vi.fn()}
        onTogglePriority={vi.fn()}
        onDelete={vi.fn()}
        onDropTask={vi.fn()}
      />,
    );

    expect(screen.queryByRole("img", { name: "Has description" })).not.toBeInTheDocument();
  });
});
