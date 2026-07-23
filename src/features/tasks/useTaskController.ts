import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { taskClient, type TaskClient } from "../../lib/taskClient";
import { compareTasks } from "../../lib/taskOrdering";
import type { CreateTaskInput, EditableTaskPatch, Task, UndoAction } from "../../lib/types";

function replaceTask(tasks: Task[], next: Task): Task[] {
  return tasks.some(({ id }) => id === next.id)
    ? tasks.map((task) => task.id === next.id ? next : task)
    : [...tasks, next];
}

function optimisticReorder(tasks: Task[], id: string, beforeId?: string, afterId?: string): Task[] {
  const moving = tasks.find((task) => task.id === id);
  if (!moving) return tasks;
  const tier = tasks
    .filter((task) => task.bucket === moving.bucket && task.priority === moving.priority && !task.completedAt && !task.deletedAt && task.id !== id)
    .sort(compareTasks);
  const targetId = beforeId ?? afterId;
  const targetIndex = targetId ? tier.findIndex((task) => task.id === targetId) : tier.length;
  const insertion = beforeId ? Math.max(0, targetIndex) : Math.max(0, targetIndex + (afterId ? 1 : 0));
  tier.splice(insertion, 0, moving);
  const orderById = new Map(tier.map((task, index) => [task.id, `optimistic-${`${index}`.padStart(8, "0")}`]));
  return tasks.map((task) => orderById.has(task.id) ? { ...task, orderKey: orderById.get(task.id)! } : task);
}

export function useTaskController(client: TaskClient = taskClient) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const undoTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await client.listTasks();
      setTasks(result);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load tasks");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void client.subscribe(load).then((cleanup) => {
      if (disposed) cleanup();
      else {
        unsubscribe = cleanup;
        void load();
      }
    }).catch(() => { if (!disposed) void load(); });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [client, load]);

  const offerUndo = useCallback((action: UndoAction) => {
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    setUndo(action);
    undoTimer.current = window.setTimeout(() => setUndo(null), 8_000);
  }, []);

  const createTask = useCallback(async (input: CreateTaskInput) => {
    const temporaryId = `pending-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic: Task = {
      id: temporaryId,
      title: input.title.trim(),
      description: "",
      bucket: input.bucket ?? "inbox",
      priority: input.priority ?? "low",
      area: input.area ?? "work",
      dueDate: input.dueDate ?? null,
      estimateMinutes: input.estimateMinutes ?? null,
      orderKey: `pending-${now}`,
      completedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    setTasks((current) => [...current, optimistic]);
    try {
      const created = await client.createTask(input);
      setTasks((current) => [...current.filter(({ id }) => id !== temporaryId), created]);
      setError(null);
      return created;
    } catch (reason) {
      setTasks((current) => current.filter(({ id }) => id !== temporaryId));
      setError(reason instanceof Error ? reason.message : "Could not create task");
      throw reason;
    }
  }, [client]);

  const updateTask = useCallback(async (id: string, patch: EditableTaskPatch) => {
    let previous: Task | undefined;
    setTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      previous = task;
      return { ...task, ...patch, updatedAt: new Date().toISOString() };
    }));
    try {
      const updated = await client.updateTask(id, patch);
      setTasks((current) => replaceTask(current, updated));
      setError(null);
      return updated;
    } catch (reason) {
      if (previous) setTasks((current) => replaceTask(current, previous!));
      setError(reason instanceof Error ? reason.message : "Could not update task");
      throw reason;
    }
  }, [client]);

  const moveTask = useCallback(async (id: string, bucket: Task["bucket"]) => {
    let previous: Task | undefined;
    setTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      previous = task;
      return { ...task, bucket, dueDate: bucket === "inbox" ? null : task.dueDate };
    }));
    try {
      const updated = await client.moveTask(id, bucket);
      setTasks((current) => replaceTask(current, updated));
      return updated;
    } catch (reason) {
      if (previous) setTasks((current) => replaceTask(current, previous!));
      setError(reason instanceof Error ? reason.message : "Could not move task");
      throw reason;
    }
  }, [client]);

  const reorderTask = useCallback(async (id: string, beforeId?: string, afterId?: string) => {
    let previous: Task[] = [];
    setTasks((current) => {
      previous = current;
      return optimisticReorder(current, id, beforeId, afterId);
    });
    try {
      const updatedTier = await client.reorderTask(id, beforeId, afterId);
      const byId = new Map(updatedTier.map((task) => [task.id, task]));
      setTasks((current) => current.map((task) => byId.get(task.id) ?? task));
    } catch (reason) {
      setTasks(previous);
      setError(reason instanceof Error ? reason.message : "Could not reorder task");
    }
  }, [client]);

  const restoreTask = useCallback(async (id: string) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, completedAt: null } : task));
    try {
      const restored = await client.restoreTask(id);
      setTasks((current) => replaceTask(current, restored));
    } catch (reason) {
      await load();
      setError(reason instanceof Error ? reason.message : "Could not restore task");
    }
  }, [client, load]);

  const completeTask = useCallback(async (id: string) => {
    const completedAt = new Date().toISOString();
    setTasks((current) => current.map((task) => task.id === id ? { ...task, completedAt } : task));
    try {
      const completed = await client.completeTask(id);
      setTasks((current) => replaceTask(current, completed));
      offerUndo({ id: `complete-${id}`, label: "Task completed", run: () => restoreTask(id) });
    } catch (reason) {
      await load();
      setError(reason instanceof Error ? reason.message : "Could not complete task");
    }
  }, [client, load, offerUndo, restoreTask]);

  const deleteTask = useCallback(async (id: string) => {
    const deletedAt = new Date().toISOString();
    setTasks((current) => current.map((task) => task.id === id ? { ...task, deletedAt } : task));
    try {
      await client.deleteTask(id);
      offerUndo({
        id: `delete-${id}`,
        label: "Task deleted",
        run: async () => {
          const restored = await client.undoDelete(id);
          setTasks((current) => replaceTask(current, restored));
        },
      });
    } catch (reason) {
      await load();
      setError(reason instanceof Error ? reason.message : "Could not delete task");
    }
  }, [client, load, offerUndo]);

  const runUndo = useCallback(async () => {
    if (!undo) return;
    setUndo(null);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    await undo.run();
  }, [undo]);

  return useMemo(() => ({
    tasks,
    loading,
    error,
    undo,
    reload: load,
    createTask,
    updateTask,
    moveTask,
    reorderTask,
    completeTask,
    restoreTask,
    deleteTask,
    runUndo,
  }), [tasks, loading, error, undo, load, createTask, updateTask, moveTask, reorderTask, completeTask, restoreTask, deleteTask, runUndo]);
}
