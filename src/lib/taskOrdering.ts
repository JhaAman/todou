import type { Task } from "./types";

export function compareTasks(a: Task, b: Task): number {
  if (a.priority !== b.priority) {
    return a.priority === "high" ? -1 : 1;
  }

  const byOrder = a.orderKey === b.orderKey ? 0 : a.orderKey < b.orderKey ? -1 : 1;
  if (byOrder) return byOrder;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

export interface ReorderAnchors {
  beforeId?: string;
  afterId?: string;
}

export function reorderAnchors(
  tasks: Task[],
  movingId: string,
  targetId: string,
  edge: "before" | "after",
): ReorderAnchors | null {
  const moving = tasks.find((task) => task.id === movingId && !task.deletedAt && !task.completedAt);
  const target = tasks.find((task) => task.id === targetId && !task.deletedAt && !task.completedAt);
  if (!moving || !target || moving.bucket !== target.bucket || moving.priority !== target.priority) return null;

  const tier = tasks
    .filter((task) => (
      task.id !== movingId
      && !task.deletedAt
      && !task.completedAt
      && task.bucket === moving.bucket
      && task.priority === moving.priority
    ))
    .sort(compareTasks);
  const targetIndex = tier.findIndex((task) => task.id === targetId);
  if (targetIndex < 0) return null;
  const insertionIndex = edge === "before" ? targetIndex : targetIndex + 1;
  const lower = tier[insertionIndex - 1];
  const upper = tier[insertionIndex];
  return {
    ...(upper ? { beforeId: upper.id } : {}),
    ...(lower ? { afterId: lower.id } : {}),
  };
}

export function activeTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.deletedAt && !task.completedAt);
}

export function tasksForBucket(tasks: Task[], bucket: Task["bucket"]): Task[] {
  return activeTasks(tasks)
    .filter((task) => task.bucket === bucket)
    .sort(compareTasks);
}

export function completedTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => !task.deletedAt && task.completedAt)
    .sort((a, b) => {
      const byCompletion = (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
      return byCompletion || a.id.localeCompare(b.id);
    });
}

export function searchTasks(tasks: Task[], query: string): Task[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  return tasks
    .filter((task) => !task.deletedAt)
    .filter((task) => {
      const haystack = `${task.title} ${task.area} ${task.bucket} ${task.priority}`.toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => {
      if (Boolean(a.completedAt) !== Boolean(b.completedAt)) return a.completedAt ? 1 : -1;
      return compareTasks(a, b);
    });
}
