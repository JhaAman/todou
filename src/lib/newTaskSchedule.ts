import type { Bucket } from "./types";

export function localDateString(value = new Date()): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function newTaskBucket(
  requestedBucket: Bucket | undefined,
  dueDate: string | null | undefined,
  referenceDate = new Date(),
): Bucket {
  if (requestedBucket === "today") return "today";
  return scheduledNewTaskBucket(requestedBucket, dueDate, referenceDate);
}

export function scheduledNewTaskBucket(
  requestedBucket: Bucket | undefined,
  dueDate: string | null | undefined,
  referenceDate = new Date(),
): Bucket {
  if (requestedBucket === "in_progress") return "in_progress";
  return dueDate && dueDate <= localDateString(referenceDate) ? "today" : "inbox";
}

export function inAppTaskDestination(
  requestedBucket: Bucket | undefined,
  contextBucket: Bucket | undefined,
): Exclude<Bucket, "in_progress"> {
  return (requestedBucket ?? contextBucket) === "today" ? "today" : "inbox";
}
