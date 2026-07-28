import { describe, expect, it } from "vitest";
import {
  checkpointWorkSession,
  createWorkSession,
  formatRemainingTime,
  hydrateWorkSession,
  IDLE_THRESHOLD_MS,
  markZeroNotified,
  reconcileWorkSession,
  toggleManualPause,
} from "./workSession";

const minute = 60_000;

describe("work session", () => {
  it("uses thirty minutes when a task has no configured duration", () => {
    const session = createWorkSession({
      taskId: "task-1",
      durationMinutes: null,
      nowMs: 0,
      observedIdleMs: 0,
    });

    expect(session.durationMs).toBe(30 * minute);
    expect(session.remainingMs).toBe(30 * minute);
  });

  it("uses the caller's fallback when a task has no configured duration", () => {
    const session = createWorkSession({
      taskId: "task-1",
      durationMinutes: null,
      defaultDurationMinutes: 45,
      nowMs: 0,
      observedIdleMs: 0,
    });

    expect(session.durationMs).toBe(45 * minute);
  });

  it("allows the remaining time to run into overtime", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 1,
      nowMs: 0,
      observedIdleMs: 0,
    });

    const overtime = reconcileWorkSession(started, {
      nowMs: minute + 1_000,
      observedIdleMs: 0,
    });

    expect(overtime.remainingMs).toBe(-1_000);
  });

  it("rolls the timer back to the last input when idle reaches five minutes", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
    });

    const idle = reconcileWorkSession(started, {
      nowMs: IDLE_THRESHOLD_MS,
      observedIdleMs: IDLE_THRESHOLD_MS,
    });

    expect(idle.status).toBe("idle-paused");
    expect(idle.remainingMs).toBe(30 * minute);
  });

  it("automatically resumes an idle pause after new activity", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
    });
    const idle = reconcileWorkSession(started, {
      nowMs: 5 * minute,
      observedIdleMs: 5 * minute,
    });

    const resumed = reconcileWorkSession(idle, {
      nowMs: 5 * minute,
      observedIdleMs: 0,
    });

    expect(resumed.status).toBe("running");
    expect(resumed.remainingMs).toBe(30 * minute);
  });

  it("allows a new elapsed notification after idle time rewinds past zero", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 1,
      nowMs: 0,
      observedIdleMs: 0,
    });
    const elapsedDuringIdle = markZeroNotified(reconcileWorkSession(started, {
      nowMs: minute + 1_000,
      observedIdleMs: minute + 1_000,
    }));

    const idlePaused = reconcileWorkSession(elapsedDuringIdle, {
      nowMs: IDLE_THRESHOLD_MS,
      observedIdleMs: IDLE_THRESHOLD_MS,
    });

    expect(idlePaused.status).toBe("idle-paused");
    expect(idlePaused.remainingMs).toBe(minute);
    expect(idlePaused.zeroNotified).toBe(false);
  });

  it("never automatically resumes a manual pause", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
    });
    const paused = toggleManualPause(started, {
      nowMs: 0,
      observedIdleMs: 0,
    });

    const afterActivity = reconcileWorkSession(paused, {
      nowMs: 10 * minute,
      observedIdleMs: 0,
    });

    expect(afterActivity.status).toBe("manual-paused");
    expect(afterActivity.remainingMs).toBe(30 * minute);
  });

  it("preserves remaining time across manual pause and resume", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
    });
    const paused = toggleManualPause(started, {
      nowMs: 2 * minute,
      observedIdleMs: 0,
    });
    const resumed = toggleManualPause(paused, {
      nowMs: 12 * minute,
      observedIdleMs: 0,
    });

    expect(resumed.status).toBe("running");
    expect(resumed.remainingMs).toBe(28 * minute);
  });

  it("does not refund a polling gap when activity occurred before five idle minutes", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
    });
    const beforeGap = reconcileWorkSession(started, {
      nowMs: 4 * minute,
      observedIdleMs: 4 * minute,
    });

    const afterActivity = reconcileWorkSession(beforeGap, {
      nowMs: 6 * minute,
      observedIdleMs: 90_000,
    });

    expect(afterActivity.remainingMs).toBe(24 * minute);
  });

  it("does not charge detected system sleep during a polling gap", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
      observedAwakeTimeMs: 0,
    });
    const beforeSuspension = reconcileWorkSession(started, {
      nowMs: 4 * minute,
      observedIdleMs: 4 * minute,
      observedAwakeTimeMs: 4 * minute,
    });

    const afterWakeActivity = reconcileWorkSession(beforeSuspension, {
      nowMs: 10 * minute,
      observedIdleMs: 1_000,
      observedAwakeTimeMs: 5 * minute,
    });

    expect(afterWakeActivity.status).toBe("running");
    expect(afterWakeActivity.remainingMs).toBe(25 * minute);
  });

  it("does not mistake a delayed active sample for uninterrupted idle", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
      observedAwakeTimeMs: 0,
    });
    const beforeGap = reconcileWorkSession(started, {
      nowMs: 4 * minute,
      observedIdleMs: 4 * minute,
      observedAwakeTimeMs: 4 * minute,
    });

    const afterActiveGap = reconcileWorkSession(beforeGap, {
      nowMs: 10 * minute,
      observedIdleMs: 1_000,
      observedAwakeTimeMs: 10 * minute,
    });

    expect(afterActiveGap.remainingMs).toBe(20 * minute);
  });

  it("hydrates a running checkpoint without deducting app downtime", () => {
    const started = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 0,
      observedIdleMs: 0,
    });
    const elapsed = reconcileWorkSession(started, {
      nowMs: 2 * minute,
      observedIdleMs: 0,
    });
    const snapshot = checkpointWorkSession(elapsed);

    const restored = hydrateWorkSession(snapshot, {
      nowMs: 60 * minute,
      observedIdleMs: 0,
    });

    expect(restored.remainingMs).toBe(28 * minute);
    expect(restored.checkpointWallTimeMs).toBe(60 * minute);
  });

  it("checkpoints only the durable native session fields", () => {
    const session = createWorkSession({
      taskId: "task-1",
      durationMinutes: 30,
      nowMs: 123,
      observedIdleMs: 12,
    });

    expect(checkpointWorkSession(session)).toEqual({
      version: 1,
      taskId: "task-1",
      durationMs: 30 * minute,
      remainingMs: 30 * minute,
      status: "running",
      checkpointWallTimeMs: 123,
      zeroNotified: false,
    });
  });

  it.each([
    [30 * minute, "30:00"],
    [3_599_001, "1:00:00"],
    [0, "00:00"],
    [-1, "+00:01"],
    [-60_001, "+01:01"],
  ])("formats %i milliseconds as %s", (remainingMs, expected) => {
    expect(formatRemainingTime(remainingMs)).toBe(expected);
  });
});
