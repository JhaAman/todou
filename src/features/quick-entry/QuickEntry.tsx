import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  CalendarDays,
  Check,
  Clock3,
  CornerDownLeft,
  Flag,
  Inbox,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { parseNaturalLanguage } from "../../lib/naturalLanguage";
import { loadPreferences, savePreferences } from "../../lib/preferences";
import { isTauriRuntime, taskClient } from "../../lib/taskClient";
import { applyTheme } from "../../lib/themes";
import type { Area, Bucket, Priority, ThemeId } from "../../lib/types";

const tokenIcons = {
  date: CalendarDays,
  estimate: Clock3,
  priority: Flag,
  area: UserRound,
  bucket: Inbox,
};

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

export function QuickEntry() {
  const preferences = useRef(loadPreferences());
  const [value, setValue] = useState("");
  const [priority, setPriority] = useState<Priority>("low");
  const [area, setArea] = useState<Area>(preferences.current.lastArea);
  const [bucket, setBucket] = useState<Bucket>("inbox");
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseNaturalLanguage(value), [value]);
  const finalPriority = parsed.fields.priority ?? priority;
  const finalArea = parsed.fields.area ?? area;
  const finalDueDate = parsed.fields.dueDate ?? dueDate;
  const finalBucket = finalDueDate && finalDueDate <= today() ? "today" : (parsed.fields.bucket ?? bucket);

  useEffect(() => {
    inputRef.current?.focus();
    if (!isTauriRuntime()) return;

    let disposed = false;
    let cleanup: (() => void)[] = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlistenShown = await listen("todou://quick-entry-shown", () => {
        preferences.current = loadPreferences();
        setValue("");
        setPriority("low");
        setArea(preferences.current.lastArea);
        setBucket("inbox");
        setDueDate(null);
        setSaving(false);
        setSaved(false);
        window.requestAnimationFrame(() => inputRef.current?.focus());
      });
      const unlistenTheme = await listen<{ themeId: ThemeId }>("todou://theme-preview", (event) => {
        applyTheme(event.payload.themeId);
      });
      if (disposed) {
        unlistenShown();
        unlistenTheme();
      } else {
        cleanup = [unlistenShown, unlistenTheme];
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      cleanup.forEach((unlisten) => unlisten());
    };
  }, []);

  const close = async () => {
    setValue("");
    setPriority("low");
    setBucket("inbox");
    setDueDate(null);
    setSaved(false);
    if (isTauriRuntime()) await taskClient.hideCurrentWindow();
  };

  const save = async () => {
    if (!parsed.title.trim() || saving) return;
    setSaving(true);
    try {
      await taskClient.createTask({
        title: parsed.title,
        bucket: finalBucket,
        priority: finalPriority,
        area: finalArea,
        dueDate: finalDueDate,
        estimateMinutes: parsed.fields.estimateMinutes ?? null,
      });
      preferences.current = { ...preferences.current, lastArea: finalArea };
      savePreferences(preferences.current);
      setSaved(true);
      if (isTauriRuntime()) {
        window.setTimeout(() => void close(), 120);
      } else {
        setValue("");
        window.setTimeout(() => setSaved(false), 1_500);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void close();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
  };

  return (
    <main className="quick-window">
      <section className={`quick-card ${saved ? "is-saved" : ""}`}>
        <header className="quick-header" data-tauri-drag-region>
          <div className="quick-brand">
            <span className="brand-mark small"><span /></span>
            <strong>Quick Entry</strong>
            {import.meta.env.DEV && <span className="dev-badge dev-badge-quick">DEV</span>}
          </div>
          <button onClick={() => void close()} aria-label="Hide quick entry"><X size={15} /></button>
        </header>

        <div className="quick-input-wrap">
          <Sparkles size={20} className="quick-spark" />
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => { setValue(event.target.value); setSaved(false); }}
            onKeyDown={handleKeyDown}
            placeholder="What needs to happen?"
            aria-label="New task"
          />
          {saved && <span className="quick-saved" role="status"><Check size={14} />Saved</span>}
        </div>

        <div className="quick-preview">
          {parsed.tokens.length ? parsed.tokens.map((token) => {
            const Icon = tokenIcons[token.kind];
            return <span className={`parse-chip ${token.kind} ${token.kind === "area" ? token.value : ""}`} key={`${token.kind}-${token.start}`}><Icon size={11} />{token.label}</span>;
          }) : (
            <span>Try “Send update tomorrow 25m !high /work”</span>
          )}
        </div>

        <footer className="quick-footer">
          <div className="quick-options" role="group" aria-label="Task details">
            <button className={finalPriority === "high" ? "is-active priority" : ""} onClick={() => setPriority(finalPriority === "high" ? "low" : "high")} title="Toggle priority" aria-label="High priority" aria-pressed={finalPriority === "high"}><Flag size={14} fill={finalPriority === "high" ? "currentColor" : "none"} />{finalPriority === "high" ? "High" : "Low"}</button>
            <button className={`is-active-${finalArea}`} onClick={() => setArea(finalArea === "work" ? "personal" : "work")} title={`Set area to ${finalArea === "work" ? "personal" : "work"}`} aria-label="Work task" aria-pressed={finalArea === "work"}><UserRound size={14} />{finalArea === "work" ? "Work" : "Personal"}</button>
            <button onClick={() => setBucket(finalBucket === "inbox" ? "today" : "inbox")} title={`Move to ${finalBucket === "inbox" ? "Today" : "Inbox"}`} aria-label="Today list" aria-pressed={finalBucket === "today"}>{finalBucket === "inbox" ? <Inbox size={14} /> : <CornerDownLeft size={14} />}{finalBucket === "inbox" ? "Inbox" : "Today"}</button>
            <label className={finalDueDate ? "has-value" : ""} title="Due date"><CalendarDays size={14} /><input type="date" value={finalDueDate ?? ""} onChange={(event) => setDueDate(event.target.value || null)} aria-label="Due date" /></label>
          </div>
          <button
            className="quick-save"
            onClick={() => void save()}
            disabled={!parsed.title.trim() || saving}
            aria-label={saving ? "Saving task" : `Add to ${finalBucket === "today" ? "Today" : "Inbox"}`}
            title={`Add to ${finalBucket === "today" ? "Today" : "Inbox"}`}
          >
            <CornerDownLeft size={15} aria-hidden="true" />
          </button>
        </footer>
      </section>
    </main>
  );
}
