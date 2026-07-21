import * as chrono from "chrono-node";
import type { Area, Bucket, CreateTaskInput, Priority } from "./types";

export type ParseTokenKind = "date" | "estimate" | "priority" | "area" | "bucket";

export interface ParseToken {
  kind: ParseTokenKind;
  label: string;
  value: string;
  start: number;
  end: number;
}

export interface NaturalLanguageResult {
  title: string;
  fields: Partial<Omit<CreateTaskInput, "title">>;
  tokens: ParseToken[];
  confidence: number;
}

const estimatePattern = /\b(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours)(?:\s+\d+\s*(?:m|min|mins|minute|minutes))?|\d+\s*(?:m|min|mins|minute|minutes))\b/gi;
const priorityPattern = /(?:^|\s)!(high|low)\b/gi;
const areaPattern = /(?:^|\s)\/(work|personal)\b/gi;
const bucketPattern = /(?:^|\s)\/(today|inbox)\b/gi;

function localDateString(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateLabel(text: string, date: Date, referenceDate: Date): string {
  const normalized = text.trim().toLocaleLowerCase();
  if (normalized === "today") return "Today";
  const tomorrow = new Date(referenceDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (localDateString(date) === localDateString(tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function collectExplicitTokens(
  input: string,
  pattern: RegExp,
  kind: ParseTokenKind,
  label: (value: string) => string,
): ParseToken[] {
  pattern.lastIndex = 0;
  const tokens: ParseToken[] = [];
  for (const match of input.matchAll(pattern)) {
    const fullMatch = match[0];
    const leadingSpace = fullMatch.length - fullMatch.trimStart().length;
    const rawValue = (match[1] ?? fullMatch).trim();
    const start = (match.index ?? 0) + leadingSpace;
    tokens.push({
      kind,
      label: label(rawValue),
      value: rawValue.toLocaleLowerCase(),
      start,
      end: (match.index ?? 0) + fullMatch.length,
    });
  }
  return tokens;
}

export function parseEstimate(value: string): number | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;

  const pieces = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/g)];
  const leftover = normalized.replace(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/g, "").trim();
  if (!pieces.length || leftover) return null;

  const minutes = pieces.reduce((total, [, rawAmount, unit]) => {
    const amount = Number(rawAmount);
    return total + (unit?.startsWith("h") ? amount * 60 : amount);
  }, 0);
  const rounded = Math.round(minutes);
  return rounded >= 1 && rounded <= 1440 ? rounded : null;
}

export function formatEstimate(minutes: number | null): string {
  if (!minutes) return "";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function parseNaturalLanguage(input: string, referenceDate = new Date()): NaturalLanguageResult {
  const fields: NaturalLanguageResult["fields"] = {};
  const tokens: ParseToken[] = [];

  const dateResult = chrono.parse(input, referenceDate, { forwardDate: true })[0];
  if (dateResult) {
    const date = dateResult.start.date();
    fields.dueDate = localDateString(date);
    tokens.push({
      kind: "date",
      label: dateLabel(dateResult.text, date, referenceDate),
      value: fields.dueDate,
      start: dateResult.index,
      end: dateResult.index + dateResult.text.length,
    });
  }

  const estimateTokens = collectExplicitTokens(input, estimatePattern, "estimate", (value) => {
    const minutes = parseEstimate(value);
    return minutes ? formatEstimate(minutes) : value;
  });
  const estimateToken = estimateTokens[0];
  const estimate = estimateToken ? parseEstimate(estimateToken.value) : null;
  if (estimate && estimateToken) {
    fields.estimateMinutes = estimate;
    tokens.push(estimateToken);
  }

  const priorityTokens = collectExplicitTokens(input, priorityPattern, "priority", (value) =>
    value.toLocaleLowerCase() === "high" ? "High" : "Low",
  );
  if (priorityTokens[0]) {
    fields.priority = priorityTokens[0].value as Priority;
    tokens.push(priorityTokens[0]);
  }

  const areaTokens = collectExplicitTokens(input, areaPattern, "area", (value) =>
    value.charAt(0).toLocaleUpperCase() + value.slice(1).toLocaleLowerCase(),
  );
  if (areaTokens[0]) {
    fields.area = areaTokens[0].value as Area;
    tokens.push(areaTokens[0]);
  }

  const bucketTokens = collectExplicitTokens(input, bucketPattern, "bucket", (value) =>
    value.charAt(0).toLocaleUpperCase() + value.slice(1).toLocaleLowerCase(),
  );
  if (bucketTokens[0]) {
    fields.bucket = bucketTokens[0].value as Bucket;
    tokens.push(bucketTokens[0]);
  }

  if (fields.dueDate && fields.dueDate <= localDateString(referenceDate)) {
    fields.bucket = "today";
  }

  const removed = new Array(input.length).fill(false) as boolean[];
  for (const token of tokens) {
    for (let index = token.start; index < token.end; index += 1) removed[index] = true;
  }
  const title = [...input]
    .filter((_, index) => !removed[index])
    .join("")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, "")
    .trim();

  tokens.sort((a, b) => a.start - b.start);
  return {
    title,
    fields,
    tokens,
    confidence: tokens.length ? 0.98 : 1,
  };
}
