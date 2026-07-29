import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Pause, Play, Sparkles, Square } from "lucide-react";
import {
  readErrorMessage,
  taskClient,
  type TaskClient,
} from "../../lib/taskClient";
import type { Task } from "../../lib/types";
import {
  checkpointWorkSession,
  formatRemainingTime,
  hydrateWorkSession,
  markZeroNotified,
  reconcileWorkSession,
  toggleManualPause,
  type WorkSessionSnapshot,
  type WorkSessionState,
} from "./workSession";

const tickIntervalMs = 500;
const checkpointIntervalMs = 5_000;
const congratulationsDurationMs = 1_500;

export type WorkModeClient = Pick<
  TaskClient,
  | "listTasks"
  | "completeTask"
  | "subscribe"
  | "startWorkMode"
  | "loadWorkModeSession"
  | "checkpointWorkModeSession"
  | "subscribeWorkModeSession"
  | "getSystemActivitySample"
  | "stopWorkMode"
>;

interface WorkModeProps {
  client?: WorkModeClient;
}

export function WorkMode({ client = taskClient }: WorkModeProps) {
  const [session, setSession] = useState<WorkSessionState | null>(null);
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WorkSessionState | null>(null);
  const transitioningRef = useRef(false);
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const celebratingRef = useRef(false);
  const lastCheckpointRef = useRef(0);
  const congratulationsTimerRef = useRef<number | null>(null);
  const lifecycleEpochRef = useRef(0);
  const sessionEventSequenceRef = useRef(0);
  const nativeCommandTailRef = useRef<Promise<void>>(Promise.resolve());
  const refreshCurrentTaskRef = useRef<() => void>(() => undefined);
  const lastSystemActivityRef = useRef({
    observedIdleMs: 0,
    observedAwakeTimeMs: null as number | null,
  });

  const commitSession = useCallback((next: WorkSessionState | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const resetCelebration = useCallback(() => {
    celebratingRef.current = false;
    setCelebrating(false);
    if (congratulationsTimerRef.current !== null) {
      window.clearTimeout(congratulationsTimerRef.current);
      congratulationsTimerRef.current = null;
    }
  }, []);

  const enqueueNativeCommand = useCallback(function enqueueNativeCommand<T>(
    command: () => Promise<T>,
  ): Promise<T> {
    const result = nativeCommandTailRef.current.then(command, command);
    nativeCommandTailRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const readSystemActivity = useCallback(async () => {
    try {
      const sample = await client.getSystemActivitySample();
      const next = {
        observedIdleMs: sample.idleMs ?? 0,
        observedAwakeTimeMs:
          sample.awakeTimeMs ?? lastSystemActivityRef.current.observedAwakeTimeMs,
      };
      lastSystemActivityRef.current = next;
      return next;
    } catch {
      return {
        observedIdleMs: 0,
        observedAwakeTimeMs:
          lastSystemActivityRef.current.observedAwakeTimeMs,
      };
    }
  }, [client]);

  const persistSession = useCallback((next: WorkSessionState) => {
    const epoch = lifecycleEpochRef.current;
    return enqueueNativeCommand(async () => {
      if (
        lifecycleEpochRef.current !== epoch
        || sessionRef.current?.taskId !== next.taskId
      ) {
        return;
      }
      try {
        await client.checkpointWorkModeSession(checkpointWorkSession(next));
        if (lifecycleEpochRef.current === epoch) {
          lastCheckpointRef.current = Date.now();
        }
      } catch (reason) {
        if (
          lifecycleEpochRef.current === epoch
          && sessionRef.current?.taskId === next.taskId
        ) {
          setError(readErrorMessage(reason, "Could not save the work session"));
        }
      }
    });
  }, [client, enqueueNativeCommand]);

  const installSnapshot = useCallback(async (
    snapshot: WorkSessionSnapshot,
    epoch = lifecycleEpochRef.current,
  ): Promise<WorkSessionState | null> => {
    const activity = await readSystemActivity();
    if (lifecycleEpochRef.current !== epoch) return null;
    const next = hydrateWorkSession(snapshot, {
      nowMs: Date.now(),
      ...activity,
    });
    if (sessionRef.current?.taskId !== next.taskId) {
      setCurrentTask(null);
    }
    commitSession(next);
    lastCheckpointRef.current = Date.now();
    return next;
  }, [commitSession, readSystemActivity]);

  const stop = useCallback(async () => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    lifecycleEpochRef.current += 1;
    const eventSequence = sessionEventSequenceRef.current;
    refreshQueuedRef.current = false;
    setBusy(true);
    setError(null);
    try {
      await enqueueNativeCommand(() => client.stopWorkMode());
      const newerSessionAccepted =
        sessionEventSequenceRef.current > eventSequence
        && sessionRef.current !== null;
      if (!newerSessionAccepted) {
        commitSession(null);
        setCurrentTask(null);
        resetCelebration();
      }
    } catch (reason) {
      setError(readErrorMessage(reason, "Could not stop work mode"));
      resetCelebration();
    } finally {
      transitioningRef.current = false;
      setBusy(false);
      if (refreshQueuedRef.current && sessionRef.current) {
        refreshQueuedRef.current = false;
        window.setTimeout(() => refreshCurrentTaskRef.current(), 0);
      }
    }
  }, [client, commitSession, enqueueNativeCommand, resetCelebration]);

  const finishAll = useCallback(() => {
    if (celebratingRef.current) return;
    celebratingRef.current = true;
    setCelebrating(true);
    setCurrentTask(null);
    playTone("complete");
    congratulationsTimerRef.current = window.setTimeout(() => {
      transitioningRef.current = false;
      void stop();
    }, congratulationsDurationMs);
  }, [stop]);

  const refreshCurrentTask = useCallback(async function refreshCurrentTask(
    candidate = sessionRef.current,
    epoch = lifecycleEpochRef.current,
  ): Promise<void> {
    if (!candidate || celebratingRef.current) return;
    if (transitioningRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    if (refreshingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshingRef.current = true;
    try {
      const tasks = await client.listTasks({
        bucket: "in_progress",
        completed: false,
      });
      if (
        lifecycleEpochRef.current !== epoch
        || transitioningRef.current
        || celebratingRef.current
      ) {
        return;
      }
      const first = tasks[0];
      if (!first) {
        finishAll();
        return;
      }

      let activeSession = candidate;
      if (first.id !== activeSession.taskId) {
        const snapshot = await enqueueNativeCommand(async () => {
          if (
            lifecycleEpochRef.current !== epoch
            || transitioningRef.current
          ) {
            return null;
          }
          return client.startWorkMode();
        });
        if (!snapshot || transitioningRef.current) return;
        const snapshotEpoch = ++lifecycleEpochRef.current;
        const installed = await installSnapshot(snapshot, snapshotEpoch);
        if (!installed) return;
        activeSession = installed;

        const currentTasks = await client.listTasks({
          bucket: "in_progress",
          completed: false,
        });
        if (
          lifecycleEpochRef.current !== snapshotEpoch
          || transitioningRef.current
        ) {
          return;
        }
        const exactTask = currentTasks.find(({ id }) => id === activeSession.taskId);
        if (!exactTask) {
          refreshQueuedRef.current = true;
          return;
        }
        setCurrentTask(exactTask);
      } else {
        setCurrentTask(first);
      }
      setError(null);
    } catch (reason) {
      if (lifecycleEpochRef.current === epoch) {
        setError(readErrorMessage(reason, "Could not load the current task"));
      }
    } finally {
      refreshingRef.current = false;
      if (refreshQueuedRef.current && !transitioningRef.current) {
        refreshQueuedRef.current = false;
        window.setTimeout(() => void refreshCurrentTask(), 0);
      }
    }
  }, [client, enqueueNativeCommand, finishAll, installSnapshot]);
  refreshCurrentTaskRef.current = () => void refreshCurrentTask();

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    const acceptSnapshot = async (snapshot: WorkSessionSnapshot | null) => {
      if (disposed) return;
      const epoch = ++lifecycleEpochRef.current;
      if (!snapshot) {
        resetCelebration();
        commitSession(null);
        setCurrentTask(null);
        return;
      }
      resetCelebration();
      const restored = await installSnapshot(snapshot, epoch);
      if (!disposed && restored) await refreshCurrentTask(restored, epoch);
    };

    void (async () => {
      const unsubscribeSession = await client.subscribeWorkModeSession(
        (snapshot) => {
          sessionEventSequenceRef.current += 1;
          void acceptSnapshot(snapshot);
        },
      );
      if (disposed) {
        unsubscribeSession();
        return;
      }
      cleanups.push(unsubscribeSession);

      const unsubscribeTasks = await client.subscribe(() => {
        if (transitioningRef.current) {
          refreshQueuedRef.current = true;
        } else {
          void refreshCurrentTask();
        }
      });
      if (disposed) {
        unsubscribeTasks();
        return;
      }
      cleanups.push(unsubscribeTasks);

      const loadEpoch = lifecycleEpochRef.current;
      const snapshot = await client.loadWorkModeSession();
      if (loadEpoch === lifecycleEpochRef.current) {
        await acceptSnapshot(snapshot);
      }
    })().catch((reason: unknown) => {
      if (!disposed) {
        setError(readErrorMessage(reason, "Could not restore work mode"));
      }
    });

    return () => {
      disposed = true;
      lifecycleEpochRef.current += 1;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [client, commitSession, installSnapshot, refreshCurrentTask, resetCelebration]);

  useEffect(() => {
    let disposed = false;
    let sampling = false;

    const tick = async () => {
      if (
        sampling
        || !sessionRef.current
        || transitioningRef.current
        || celebratingRef.current
      ) {
        return;
      }
      sampling = true;
      try {
        const activity = await readSystemActivity();
        const current = sessionRef.current;
        if (disposed || !current || transitioningRef.current) return;

        let next = reconcileWorkSession(current, {
          nowMs: Date.now(),
          ...activity,
        });
        const statusChanged = next.status !== current.status;
        let shouldCheckpoint =
          statusChanged ||
          Date.now() - lastCheckpointRef.current >= checkpointIntervalMs;

        if (next.remainingMs <= 0 && !next.zeroNotified) {
          playTone("elapsed");
          next = markZeroNotified(next);
          shouldCheckpoint = true;
        }

        commitSession(next);
        if (shouldCheckpoint) await persistSession(next);
      } finally {
        sampling = false;
      }
    };

    const timer = window.setInterval(() => void tick(), tickIntervalMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [commitSession, persistSession, readSystemActivity]);

  useEffect(() => () => {
    if (congratulationsTimerRef.current !== null) {
      window.clearTimeout(congratulationsTimerRef.current);
    }
  }, []);

  const togglePause = async () => {
    const current = sessionRef.current;
    if (!current || busy) return;
    const epoch = lifecycleEpochRef.current;
    setBusy(true);
    setError(null);
    const activity = await readSystemActivity();
    if (
      lifecycleEpochRef.current !== epoch
      || sessionRef.current?.taskId !== current.taskId
    ) {
      setBusy(false);
      return;
    }
    const next = toggleManualPause(current, {
      nowMs: Date.now(),
      ...activity,
    });
    commitSession(next);
    void persistSession(next);
    setBusy(false);
  };

  const completeCurrent = async () => {
    const activeTask = currentTask;
    if (!activeTask || busy || celebratingRef.current) return;
    let refreshAfterTransition = false;
    transitioningRef.current = true;
    lifecycleEpochRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      await enqueueNativeCommand(() => client.completeTask(activeTask.id));
      const remaining = await client.listTasks({
        bucket: "in_progress",
        completed: false,
      });
      if (!remaining.length) {
        transitioningRef.current = false;
        setBusy(false);
        finishAll();
        return;
      }

      const snapshot = await enqueueNativeCommand(() => client.startWorkMode());
      const snapshotEpoch = ++lifecycleEpochRef.current;
      const next = await installSnapshot(snapshot, snapshotEpoch);
      if (!next) {
        refreshAfterTransition = true;
        return;
      }

      const currentTasks = await client.listTasks({
        bucket: "in_progress",
        completed: false,
      });
      if (lifecycleEpochRef.current !== snapshotEpoch) {
        refreshAfterTransition = true;
        return;
      }
      const exactTask = currentTasks.find(({ id }) => id === next.taskId);
      if (!exactTask) {
        refreshAfterTransition = true;
        return;
      }
      setCurrentTask(exactTask);
    } catch (reason) {
      setError(readErrorMessage(reason, "Could not complete this task"));
      refreshAfterTransition = true;
    } finally {
      transitioningRef.current = false;
      setBusy(false);
      if (refreshAfterTransition || refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refreshCurrentTask();
      }
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

  if (!session || !currentTask) {
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

  const paused = session.status !== "running";
  const idlePaused = session.status === "idle-paused";
  const overtime = session.remainingMs < 0;
  const stateLabel = error
    ?? (idlePaused
      ? "Idle — activity resumes"
      : session.status === "manual-paused"
        ? "Paused"
        : overtime
          ? "Overtime"
          : "Focusing now");

  return (
    <main
      className={[
        "work-mode-window",
        idlePaused ? "is-idle" : "",
        session.status === "manual-paused" ? "is-paused" : "",
      ].filter(Boolean).join(" ")}
    >
      <section className="work-mode-task">
        <span className={error ? "is-error" : ""}>
          {stateLabel}
        </span>
        <strong title={currentTask.title}>
          {currentTask.title}
        </strong>
      </section>

      <time
        className={overtime ? "is-overtime" : ""}
        dateTime={durationIso(session.remainingMs)}
      >
        {formatRemainingTime(session.remainingMs)}
      </time>

      <div className="work-mode-controls">
        <button
          type="button"
          tabIndex={-1}
          disabled={busy}
          onClick={() => void togglePause()}
          aria-label={paused ? "Resume timer" : "Pause timer"}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? <Play size={15} fill="currentColor" /> : <Pause size={15} fill="currentColor" />}
        </button>
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

function durationIso(remainingMs: number): string {
  return `PT${Math.ceil(Math.abs(remainingMs) / 1_000)}S`;
}

function playTone(kind: "elapsed" | "complete"): void {
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;
    const duration = kind === "complete" ? 0.24 : 0.16;
    const frequency = kind === "complete" ? 660 : 520;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(
      kind === "complete" ? 880 : 600,
      start + duration,
    );
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
