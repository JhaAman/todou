import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Check, GripVertical, Sparkles, Square } from "lucide-react";
import {
  readErrorMessage,
  taskClient,
  type TaskClient,
} from "../../lib/taskClient";
import { reorderAnchors, tasksForBucket } from "../../lib/taskOrdering";
import type { Task } from "../../lib/types";

const congratulationsDurationMs = 1_500;
const workModeTaskLimit = 3;
const workModeTaskDragType = "text/todou-work-mode-task";

export type WorkModeClient = Pick<
  TaskClient,
  | "listTasks"
  | "completeTask"
  | "reorderTask"
  | "subscribe"
  | "loadWorkModeActive"
  | "subscribeWorkModeActive"
  | "stopWorkMode"
>;

interface WorkModeProps {
  client?: WorkModeClient;
}

export function WorkMode({ client = taskClient }: WorkModeProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const activeRef = useRef(false);
  const activeEventSequenceRef = useRef(0);
  const celebratingRef = useRef(false);
  const stoppingRef = useRef(false);
  const congratulationsTimerRef = useRef<number | null>(null);
  const refreshTasksRef = useRef<() => void>(() => undefined);

  const resetCelebration = useCallback(() => {
    celebratingRef.current = false;
    setCelebrating(false);
    if (congratulationsTimerRef.current !== null) {
      window.clearTimeout(congratulationsTimerRef.current);
      congratulationsTimerRef.current = null;
    }
  }, []);

  const applyActive = useCallback((active: boolean) => {
    activeRef.current = active;
    if (!active) {
      setTasks([]);
      resetCelebration();
    }
  }, [resetCelebration]);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const eventSequence = activeEventSequenceRef.current;
    setBusy(true);
    setError(null);
    try {
      await client.stopWorkMode();
      if (activeEventSequenceRef.current === eventSequence) {
        applyActive(false);
      }
    } catch (reason) {
      setError(readErrorMessage(reason, "Could not stop work mode"));
      resetCelebration();
    } finally {
      stoppingRef.current = false;
      setBusy(false);
    }
  }, [applyActive, client, resetCelebration]);

  const finishAll = useCallback(() => {
    if (celebratingRef.current) return;
    celebratingRef.current = true;
    setCelebrating(true);
    setTasks([]);
    playCompletionTone();
    congratulationsTimerRef.current = window.setTimeout(() => {
      void stop();
    }, congratulationsDurationMs);
  }, [stop]);

  const refreshTasks = useCallback(async () => {
    if (!activeRef.current || celebratingRef.current) return;
    try {
      const currentTasks = await client.listTasks({
        bucket: "in_progress",
        completed: false,
      });
      if (!activeRef.current || celebratingRef.current) return;
      if (!currentTasks.length) {
        finishAll();
        return;
      }
      setTasks(tasksForBucket(currentTasks, "in_progress").slice(0, workModeTaskLimit));
      setError(null);
    } catch (reason) {
      if (activeRef.current) {
        setError(readErrorMessage(reason, "Could not load the current task"));
      }
    }
  }, [client, finishAll]);
  refreshTasksRef.current = () => void refreshTasks();

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    const acceptActive = (active: boolean) => {
      if (disposed) return;
      applyActive(active);
      if (active) {
        resetCelebration();
        void refreshTasksRef.current();
      }
    };

    void (async () => {
      const unsubscribeActive = await client.subscribeWorkModeActive((active) => {
        activeEventSequenceRef.current += 1;
        acceptActive(active);
      });
      if (disposed) {
        unsubscribeActive();
        return;
      }
      cleanups.push(unsubscribeActive);

      const unsubscribeTasks = await client.subscribe(() => {
        void refreshTasksRef.current();
      });
      if (disposed) {
        unsubscribeTasks();
        return;
      }
      cleanups.push(unsubscribeTasks);

      const eventSequence = activeEventSequenceRef.current;
      const active = await client.loadWorkModeActive();
      if (eventSequence === activeEventSequenceRef.current) {
        acceptActive(active);
      }
    })().catch((reason: unknown) => {
      if (!disposed) {
        setError(readErrorMessage(reason, "Could not restore work mode"));
      }
    });

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [applyActive, client, resetCelebration]);

  useEffect(() => () => {
    if (congratulationsTimerRef.current !== null) {
      window.clearTimeout(congratulationsTimerRef.current);
    }
  }, []);

  const completeTask = async (taskId: string) => {
    if (busy || celebratingRef.current) return;
    setBusy(true);
    setError(null);
    try {
      await client.completeTask(taskId);
      setTasks((current) => current.filter((task) => task.id !== taskId));
      await refreshTasks();
    } catch (reason) {
      setError(readErrorMessage(reason, "Could not complete this task"));
    } finally {
      setBusy(false);
    }
  };

  const reorderTask = async (movingId: string, targetId: string, edge: "before" | "after") => {
    if (busy || celebratingRef.current) return;
    const anchors = reorderAnchors(tasks, movingId, targetId, edge);
    if (!anchors) return;
    setBusy(true);
    setError(null);
    try {
      const reordered = await client.reorderTask(movingId, anchors.beforeId, anchors.afterId);
      setTasks(tasksForBucket(reordered, "in_progress").slice(0, workModeTaskLimit));
    } catch (reason) {
      await refreshTasks();
      setError(readErrorMessage(reason, "Could not reorder this task"));
    } finally {
      setBusy(false);
    }
  };

  const dragOverTask = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    const movingId = event.dataTransfer.getData(workModeTaskDragType) || draggedTaskId;
    if (!movingId || movingId === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropTarget({
      id: targetId,
      edge: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    });
  };

  const dropTask = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    event.preventDefault();
    const movingId = event.dataTransfer.getData(workModeTaskDragType) || draggedTaskId;
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = dropTarget?.id === targetId
      ? dropTarget.edge
      : event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDraggedTaskId(null);
    setDropTarget(null);
    if (movingId && movingId !== targetId && edge) {
      void reorderTask(movingId, targetId, edge);
    }
  };

  if (celebrating) {
    return (
      <main className="work-mode-window is-celebrating">
        <Sparkles size={20} aria-hidden="true" />
        <div>
          <strong>All done</strong>
          <span>Nice work.</span>
        </div>
      </main>
    );
  }

  if (!tasks.length) {
    return (
      <main className={`work-mode-window is-loading${error ? " has-error" : ""}`}>
        <span>{error ?? "Starting work mode…"}</span>
        {error && (
          <button type="button" tabIndex={-1} onClick={() => void stop()}>
            Return to task list
          </button>
        )}
      </main>
    );
  }

  return (
    <main className="work-mode-window">
      <section className="work-mode-task-list" aria-label="In Progress tasks">
        <span className={error ? "is-error" : ""}>
          {error ?? `${tasks.length} in progress`}
        </span>
        <ul>
          {tasks.map((task) => (
            <li
              className={`work-mode-task${draggedTaskId === task.id ? " is-dragging" : ""}${dropTarget?.id === task.id ? ` drop-${dropTarget.edge}` : ""}`}
              key={task.id}
              draggable={!busy}
              aria-roledescription="sortable task"
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(workModeTaskDragType, task.id);
                setDraggedTaskId(task.id);
              }}
              onDragEnd={() => {
                setDraggedTaskId(null);
                setDropTarget(null);
              }}
              onDragOver={(event) => dragOverTask(event, task.id)}
              onDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                if (dropTarget?.id === task.id) setDropTarget(null);
              }}
              onDrop={(event) => dropTask(event, task.id)}
            >
              <GripVertical size={14} role="img" aria-label={`Drag ${task.title} to reorder`} />
              <strong title={task.title}>{task.title}</strong>
              <button
                type="button"
                tabIndex={-1}
                className="is-done"
                disabled={busy}
                onClick={() => void completeTask(task.id)}
                aria-label={`Mark ${task.title} done`}
                title="Done"
              >
                <Check size={15} strokeWidth={2.4} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="work-mode-controls">
        <button
          type="button"
          tabIndex={-1}
          className="is-stop"
          disabled={busy}
          onClick={() => void stop()}
          aria-label="Stop work mode"
          title="Stop work mode"
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>
    </main>
  );
}

function playCompletionTone(): void {
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;
    const duration = 0.24;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, start);
    oscillator.frequency.exponentialRampToValueAtTime(880, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.025, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
    void context.resume().catch(() => context.close());
  } catch {
    // Sound is optional; work mode must remain usable if WebAudio is unavailable.
  }
}
