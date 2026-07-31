import { useMemo, useState, type FocusEvent, type FormEvent, type KeyboardEvent } from "react";
import { CalendarDays, Clock3, CornerDownLeft, Flag, Inbox, UserRound, X } from "lucide-react";
import { parseNaturalLanguage } from "../../lib/naturalLanguage";
import { newTaskBucket } from "../../lib/newTaskSchedule";
import type { Area, Bucket, CreateTaskInput, Priority, Task } from "../../lib/types";

interface InlineComposerProps {
  bucket: Bucket;
  defaultArea: Area;
  onCreate: (input: CreateTaskInput) => Promise<Task>;
  onCreated: (task: Task) => void;
  onCancel: () => void;
}

const tokenIcons = {
  date: CalendarDays,
  estimate: Clock3,
  priority: Flag,
  area: UserRound,
  bucket: Inbox,
};

export function InlineComposer({ bucket, defaultArea, onCreate, onCreated, onCancel }: InlineComposerProps) {
  const [value, setValue] = useState("");
  const [priority, setPriority] = useState<Priority>("low");
  const [area, setArea] = useState<Area>(defaultArea);
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => parseNaturalLanguage(value), [value]);
  const effectivePriority = parsed.fields.priority ?? priority;
  const effectiveArea = parsed.fields.area ?? area;
  const effectiveBucket = newTaskBucket(parsed.fields.bucket ?? bucket, parsed.fields.dueDate);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!parsed.title.trim() || saving) return;
    setSaving(true);
    try {
      const task = await onCreate({
        title: parsed.title,
        bucket: effectiveBucket,
        priority: effectivePriority,
        area: effectiveArea,
        dueDate: parsed.fields.dueDate ?? null,
        estimateMinutes: parsed.fields.estimateMinutes ?? null,
      });
      onCreated(task);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  const onBlur = (event: FocusEvent<HTMLFormElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (!value.trim() && priority === "low" && area === defaultArea) onCancel();
  };

  return (
    <form className="inline-composer" onBlur={onBlur} onSubmit={submit} aria-label={`Add task to ${effectiveBucket}`}>
      <div className={`composer-area-rail area-${effectiveArea}`} aria-hidden="true" />
      <div className="composer-main">
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What needs to happen? Try “Review brief tomorrow 25m !high /work”"
          aria-label="Task title"
        />
        <div className="composer-preview">
          {parsed.tokens.map((token) => {
            const Icon = tokenIcons[token.kind];
            return <span className={`parse-chip ${token.kind} ${token.kind === "area" ? token.value : ""}`} key={`${token.kind}-${token.start}`}><Icon size={11} />{token.label}</span>;
          })}
          {!parsed.tokens.length && <span className="parse-help">Natural dates, 25m, !high, /work</span>}
        </div>
      </div>
      <div className="composer-controls" role="group" aria-label="Task details">
        <button type="button" className={effectivePriority === "high" ? "is-on" : ""} onClick={() => setPriority(effectivePriority === "high" ? "low" : "high")} title="Toggle priority" aria-label="High priority" aria-pressed={effectivePriority === "high"}><Flag size={14} fill={effectivePriority === "high" ? "currentColor" : "none"} /></button>
        <button type="button" className={`area-toggle ${effectiveArea}`} onClick={() => setArea(effectiveArea === "work" ? "personal" : "work")} title={`Set ${effectiveArea === "work" ? "personal" : "work"}`} aria-label="Work task" aria-pressed={effectiveArea === "work"}><UserRound size={14} /></button>
        <button type="submit" className="composer-submit" disabled={!parsed.title.trim() || saving} title={`Add to ${effectiveBucket === "today" ? "Today" : "Inbox"}`} aria-label={`Add to ${effectiveBucket === "today" ? "Today" : "Inbox"}`}>
          <CornerDownLeft size={15} />
        </button>
        <button type="button" onClick={onCancel} title="Cancel" aria-label="Cancel"><X size={14} /></button>
      </div>
    </form>
  );
}
