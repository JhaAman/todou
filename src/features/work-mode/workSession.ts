export const DEFAULT_DURATION_MINUTES = 30;
export const IDLE_THRESHOLD_MS = 5 * 60 * 1_000;

export type WorkSessionStatus = "running" | "manual-paused" | "idle-paused";

export interface WorkSessionSnapshot {
  version: 1;
  taskId: string;
  durationMs: number;
  remainingMs: number;
  status: WorkSessionStatus;
  checkpointWallTimeMs: number;
  zeroNotified: boolean;
}

export interface WorkSessionState extends WorkSessionSnapshot {
  observedIdleMs: number;
  observedAwakeTimeMs: number | null;
  chargedIdleMs: number;
}

export interface WorkSessionSample {
  nowMs: number;
  observedIdleMs: number;
  observedAwakeTimeMs?: number | null;
}

export interface CreateWorkSessionOptions extends WorkSessionSample {
  taskId: string;
  durationMinutes?: number | null;
  defaultDurationMinutes?: number;
}

export function createWorkSession({
  taskId,
  durationMinutes,
  defaultDurationMinutes = DEFAULT_DURATION_MINUTES,
  nowMs,
  observedIdleMs,
  observedAwakeTimeMs = null,
}: CreateWorkSessionOptions): WorkSessionState {
  const selectedDurationMinutes = durationMinutes ?? defaultDurationMinutes;
  if (!Number.isFinite(selectedDurationMinutes) || selectedDurationMinutes <= 0) {
    throw new RangeError("Work session duration must be greater than zero");
  }

  const durationMs = selectedDurationMinutes * 60 * 1_000;

  return {
    version: 1,
    taskId,
    durationMs,
    remainingMs: durationMs,
    status: "running",
    checkpointWallTimeMs: nowMs,
    zeroNotified: false,
    observedIdleMs: normalizeIdle(observedIdleMs),
    observedAwakeTimeMs: normalizeAwakeTime(observedAwakeTimeMs),
    chargedIdleMs: 0,
  };
}

export function reconcileWorkSession(
  session: WorkSessionState,
  { nowMs, observedIdleMs, observedAwakeTimeMs = null }: WorkSessionSample,
): WorkSessionState {
  const idleMs = normalizeIdle(observedIdleMs);
  const awakeTimeMs = normalizeAwakeTime(observedAwakeTimeMs);
  const wallElapsedMs = Math.max(0, nowMs - session.checkpointWallTimeMs);
  const elapsedMs =
    awakeTimeMs !== null
    && session.observedAwakeTimeMs !== null
    && awakeTimeMs >= session.observedAwakeTimeMs
      ? awakeTimeMs - session.observedAwakeTimeMs
      : wallElapsedMs;
  const activityDetected =
    idleMs < session.observedIdleMs + elapsedMs;

  if (session.status === "manual-paused") {
    return resetZeroNotificationIfPositive({
      ...session,
      checkpointWallTimeMs: nowMs,
      observedIdleMs: idleMs,
      observedAwakeTimeMs: awakeTimeMs,
      chargedIdleMs: 0,
    });
  }

  if (session.status === "idle-paused") {
    if (!activityDetected || idleMs >= IDLE_THRESHOLD_MS) {
      return resetZeroNotificationIfPositive({
        ...session,
        checkpointWallTimeMs: nowMs,
        observedIdleMs: idleMs,
        observedAwakeTimeMs: awakeTimeMs,
        chargedIdleMs: 0,
      });
    }

    return resetZeroNotificationIfPositive({
      ...session,
      remainingMs: session.remainingMs - idleMs,
      status: "running",
      checkpointWallTimeMs: nowMs,
      observedIdleMs: idleMs,
      observedAwakeTimeMs: awakeTimeMs,
      chargedIdleMs: idleMs,
    });
  }

  const remainingMs = session.remainingMs - elapsedMs;
  const chargedIdleMs = activityDetected
    ? idleMs
    : session.chargedIdleMs + elapsedMs;

  if (idleMs >= IDLE_THRESHOLD_MS) {
    return resetZeroNotificationIfPositive({
      ...session,
      remainingMs: remainingMs + chargedIdleMs,
      status: "idle-paused",
      checkpointWallTimeMs: nowMs,
      observedIdleMs: idleMs,
      observedAwakeTimeMs: awakeTimeMs,
      chargedIdleMs: 0,
    });
  }

  return resetZeroNotificationIfPositive({
    ...session,
    remainingMs,
    checkpointWallTimeMs: nowMs,
    observedIdleMs: idleMs,
    observedAwakeTimeMs: awakeTimeMs,
    chargedIdleMs,
  });
}

export const tickWorkSession = reconcileWorkSession;

export function toggleManualPause(
  session: WorkSessionState,
  sample: WorkSessionSample,
): WorkSessionState {
  const idleMs = normalizeIdle(sample.observedIdleMs);
  const awakeTimeMs = normalizeAwakeTime(sample.observedAwakeTimeMs ?? null);

  if (session.status === "running") {
    const reconciled = reconcileWorkSession(session, sample);
    return resetZeroNotificationIfPositive({
      ...reconciled,
      status: "manual-paused",
      chargedIdleMs: 0,
    });
  }

  return resetZeroNotificationIfPositive({
    ...session,
    status: "running",
    checkpointWallTimeMs: sample.nowMs,
    observedIdleMs: idleMs,
    observedAwakeTimeMs: awakeTimeMs,
    chargedIdleMs: 0,
  });
}

export function checkpointWorkSession(
  session: WorkSessionState,
): WorkSessionSnapshot {
  return {
    version: 1,
    taskId: session.taskId,
    durationMs: session.durationMs,
    remainingMs: session.remainingMs,
    status: session.status,
    checkpointWallTimeMs: session.checkpointWallTimeMs,
    zeroNotified: session.zeroNotified,
  };
}

export function hydrateWorkSession(
  snapshot: WorkSessionSnapshot,
  { nowMs, observedIdleMs, observedAwakeTimeMs = null }: WorkSessionSample,
): WorkSessionState {
  const idleMs = normalizeIdle(observedIdleMs);

  return resetZeroNotificationIfPositive({
    ...snapshot,
    status:
      snapshot.status === "idle-paused" && idleMs < IDLE_THRESHOLD_MS
        ? "running"
        : snapshot.status,
    checkpointWallTimeMs: nowMs,
    observedIdleMs: idleMs,
    observedAwakeTimeMs: normalizeAwakeTime(observedAwakeTimeMs),
    chargedIdleMs: 0,
  });
}

export function markZeroNotified(
  session: WorkSessionState,
): WorkSessionState {
  return {
    ...session,
    zeroNotified: true,
  };
}

export function formatRemainingTime(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.abs(remainingMs) / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const clock =
    hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;

  return remainingMs < 0 ? `+${clock}` : clock;
}

export const displayRemaining = formatRemainingTime;

function normalizeIdle(observedIdleMs: number): number {
  return Math.max(0, observedIdleMs);
}

function normalizeAwakeTime(observedAwakeTimeMs: number | null): number | null {
  return observedAwakeTimeMs === null
    ? null
    : Math.max(0, observedAwakeTimeMs);
}

function resetZeroNotificationIfPositive(
  session: WorkSessionState,
): WorkSessionState {
  return session.remainingMs > 0 && session.zeroNotified
    ? { ...session, zeroNotified: false }
    : session;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
