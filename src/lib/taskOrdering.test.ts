import { describe, expect, it } from "vitest";
import { completedTasks, reorderAnchors, searchTasks, tasksForBucket } from "./taskOrdering";
import type { Task } from "./types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Write launch notes",
    description: "",
    bucket: "today",
    priority: "low",
    area: "work",
    dueDate: null,
    estimateMinutes: null,
    orderKey: "b",
    completedAt: null,
    deletedAt: null,
    createdAt: "2026-07-20T16:00:00.000Z",
    updatedAt: "2026-07-20T16:00:00.000Z",
    ...overrides,
  };
}

describe("task list ordering", () => {
  it("puts high-priority tasks before low-priority tasks while preserving tier order", () => {
    const result = tasksForBucket(
      [
        task({ id: "low-a", orderKey: "a" }),
        task({ id: "high-b", priority: "high", orderKey: "b" }),
        task({ id: "high-a", priority: "high", orderKey: "a" }),
      ],
      "today",
    );

    expect(result.map(({ id }) => id)).toEqual(["high-a", "high-b", "low-a"]);
  });

  it("uses bytewise order so JavaScript agrees with SQLite and Postgres", () => {
    const result = tasksForBucket([
      task({ id: "lowercase", orderKey: "a" }),
      task({ id: "uppercase", orderKey: "Z" }),
    ], "today");

    expect(result.map(({ id }) => id)).toEqual(["uppercase", "lowercase"]);
  });

  it("derives both adjacent native reorder anchors for a middle drop", () => {
    const tasks = [
      task({ id: "a", orderKey: "A" }),
      task({ id: "b", orderKey: "B" }),
      task({ id: "c", orderKey: "C" }),
      task({ id: "d", orderKey: "D" }),
    ];

    expect(reorderAnchors(tasks, "b", "c", "after")).toEqual({
      afterId: "c",
      beforeId: "d",
    });
    expect(reorderAnchors(tasks, "d", "a", "before")).toEqual({ beforeId: "a" });
  });

  it("keeps deleted and completed tasks out of active buckets", () => {
    const result = tasksForBucket(
      [task(), task({ id: "done", completedAt: "2026-07-20T17:00:00.000Z" }), task({ id: "gone", deletedAt: "2026-07-20T17:00:00.000Z" })],
      "today",
    );

    expect(result.map(({ id }) => id)).toEqual(["task-1"]);
  });

  it("orders the logbook by most recently completed", () => {
    const result = completedTasks([
      task({ id: "older", completedAt: "2026-07-19T17:00:00.000Z" }),
      task({ id: "newer", completedAt: "2026-07-20T17:00:00.000Z" }),
    ]);

    expect(result.map(({ id }) => id)).toEqual(["newer", "older"]);
  });

  it("matches every search word against task metadata", () => {
    const result = searchTasks(
      [task({ id: "match", title: "Review contract", area: "work" }), task({ id: "miss", title: "Review groceries", area: "personal" })],
      "review work",
    );

    expect(result.map(({ id }) => id)).toEqual(["match"]);
  });
});
