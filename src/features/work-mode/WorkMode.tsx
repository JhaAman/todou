import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Sparkles, Square } from "lucide-react";
import {
  readErrorMessage,
  taskClient,
  type TaskClient,
} from "../../lib/taskClient";
import type { Task } from "../../lib/types";

const congratulationsDurationMs = 1_500;

export type WorkModeClient = Pick<
  TaskClient,
  | "listTasks"
  | "completeTask"
  | "subscribe"
  | "loadWorkModeActive"
  | "subscribeWorkModeActive"
  | "stopWorkMode"
>;

interface WorkModeProps {
  client?: WorkModeClient;
}

export function WorkMode({ client = taskClient }: WorkModeProps) {
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const activeEventSequenceRef = useRef(0);
  const celebratingRef = useRef(false);
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
      setCurrentTask(null);
      resetCelebration();
    }
  }, [resetCelebration]);

  const stop = useCallback(async () => {
    if (busy) return;
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
      setBusy(false);
    }
  }, [applyActive, busy, client, resetCelebration]);

  const finishAll = useCallback(() => {
    if (celebratingRef.current) return;
    celebratingRef.current = true;
    setCelebrating(true);
    setCurrentTask(null);
    playCompletionTone();
    congratulationsTimerRef.current = window.setTimeout(() => {
      void stop();
    }, congratulationsDurationMs);
  }, [stop]);

  const refreshTasks = useCallback(async () => {
    if (!activeRef.current || celebratingRef.current) return;
    try {
      const tasks = await client.listTasks({
        bucket: "in_progress",
        completed: false,
      });
      if (!activeRef.current || celebratingRef.current) return;
      const first = tasks[0];
      if (!first) {
        finishAll();
        return;
      }
      setCurrentTask(first);
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

  const completeCurrent = async () => {
    const activeTask = currentTask;
    if (!activeTask || busy || celebratingRef.current) return;
    setBusy(true);
    setError(null);
    try {
      await client.completeTask(activeTask.id);
      await refreshTasks();
    } catch (reason) {
      setError(readErrorMessage(reason, "Could not complete this task"));
    } finally {
      setBusy(false);
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

  if (!currentTask) {
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
      <section className="work-mode-task">
        <span className={error ? "is-error" : ""}>
          {error ?? "Focusing now"}
        </span>
        <strong title={currentTask.title}>
          {currentTask.title}
        </strong>
      </section>

      <div className="work-mode-controls">
        <button
          type="button"
          tabIndex={-1}
          className="is-done"
          disabled={busy}
          onClick={() => void completeCurrent()}
          aria-label="Mark task done"
          title="Done"
        >
          <Check size={17} strokeWidth={2.4} />
        </button>
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
