import * as chrono from "chrono-node";

export type ParsedQuickTask = {
  title: string;
  bucket?: "in_progress" | "today" | "inbox";
  priority?: "high" | "low";
  area?: "personal" | "work";
  dueDate?: string;
  estimateMinutes?: number;
};

const pad = (value: number) => String(value).padStart(2, "0");

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseQuickTask(input: string, now = new Date()): ParsedQuickTask {
  let remaining = input.trim();
  const parsed: ParsedQuickTask = { title: "" };

  const tokenRules: Array<{
    pattern: RegExp;
    apply: (match: RegExpMatchArray) => void;
  }> = [
    { pattern: /(?:^|\s)!high(?=\s|$)/i, apply: () => { parsed.priority = "high"; } },
    { pattern: /(?:^|\s)!low(?=\s|$)/i, apply: () => { parsed.priority = "low"; } },
    { pattern: /(?:^|\s)\/work(?=\s|$)/i, apply: () => { parsed.area = "work"; } },
    { pattern: /(?:^|\s)\/personal(?=\s|$)/i, apply: () => { parsed.area = "personal"; } },
    { pattern: /(?:^|\s)\/in_progress(?=\s|$)/i, apply: () => { parsed.bucket = "in_progress"; } },
    { pattern: /(?:^|\s)\/today(?=\s|$)/i, apply: () => {
      parsed.bucket = "today";
      parsed.dueDate = localDate(now);
    } },
    { pattern: /(?:^|\s)\/inbox(?=\s|$)/i, apply: () => { parsed.bucket = "inbox"; } },
    {
      pattern: /(?:^|\s)(\d{1,3})\s*(m|min|mins|minutes)(?=\s|$)/i,
      apply: (match) => { parsed.estimateMinutes = Number(match[1]); },
    },
    {
      pattern: /(?:^|\s)(\d{1,2}(?:\.\d+)?)\s*(h|hr|hrs|hours)(?=\s|$)/i,
      apply: (match) => { parsed.estimateMinutes = Math.round(Number(match[1]) * 60); },
    },
  ];

  for (const rule of tokenRules) {
    const match = remaining.match(rule.pattern);
    if (!match) continue;
    rule.apply(match);
    remaining = remaining.replace(rule.pattern, " ");
  }

  const dateResult = chrono.parse(remaining, now, { forwardDate: true })[0];
  if (dateResult) {
    parsed.dueDate = localDate(dateResult.start.date());
    if (parsed.dueDate <= localDate(now)) parsed.bucket = "today";
    remaining = `${remaining.slice(0, dateResult.index)} ${remaining.slice(dateResult.index + dateResult.text.length)}`;
  }

  parsed.title = remaining.replace(/\s+/g, " ").trim();
  if (!parsed.title) throw new Error("Quick entry must contain a task title.");
  if (
    parsed.estimateMinutes !== undefined &&
    (parsed.estimateMinutes < 1 || parsed.estimateMinutes > 1440)
  ) {
    throw new Error("Estimate must be between 1 minute and 24 hours.");
  }

  return parsed;
}
