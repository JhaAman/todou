import { GitMerge, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DedupeResolutionAction, DedupeSuggestion } from "../../lib/taskClient";

interface DedupeSuggestionToastProps {
  suggestion: DedupeSuggestion;
  onDismiss: () => Promise<void>;
  onResolve: (action: DedupeResolutionAction) => Promise<void>;
}

function titleCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function formatBucket(bucket: DedupeSuggestion["mergedTask"]["bucket"]): string {
  return bucket === "in_progress" ? "In Progress" : titleCase(bucket);
}

function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return "No due date";
  const [year, month, day] = dueDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return dueDate;
  const date = new Date(year, month - 1, day, 12);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function isWindowActive(): boolean {
  return document.visibilityState !== "hidden" && document.hasFocus();
}

export function DedupeSuggestionToast({
  suggestion,
  onDismiss,
  onResolve,
}: DedupeSuggestionToastProps) {
  const [pinned, setPinned] = useState(false);
  const [windowActive, setWindowActive] = useState(isWindowActive);
  const [busyAction, setBusyAction] = useState<DedupeResolutionAction | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dismissRef = useRef(onDismiss);

  dismissRef.current = onDismiss;

  useEffect(() => {
    setPinned(false);
    setBusyAction(null);
    setError(null);
  }, [suggestion.id]);

  useEffect(() => {
    const handleFocus = () => setWindowActive(isWindowActive());
    const handleBlur = () => setWindowActive(false);
    const handleVisibility = () => setWindowActive(isWindowActive());
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (pinned || !windowActive) return;
    const timer = window.setTimeout(() => {
      setBusyAction("dismiss");
      void dismissRef.current().catch((reason) => {
        setBusyAction(null);
        setError(reason instanceof Error ? reason.message : "Could not dismiss this suggestion.");
      });
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [pinned, suggestion.id, windowActive]);

  const pin = useCallback(() => {
    setPinned(true);
  }, []);

  const dismiss = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("dismiss");
    setError(null);
    try {
      await onDismiss();
    } catch (reason) {
      setBusyAction(null);
      setError(reason instanceof Error ? reason.message : "Could not dismiss this suggestion.");
    }
  }, [busyAction, onDismiss]);

  const resolve = useCallback(async (action: DedupeResolutionAction) => {
    if (busyAction) return;
    setBusyAction(action);
    setError(null);
    try {
      await onResolve(action);
    } catch (reason) {
      setBusyAction(null);
      setError(reason instanceof Error ? reason.message : "The tasks changed. Todou will check them again.");
    }
  }, [busyAction, onResolve]);

  const merged = suggestion.mergedTask;

  return (
    <section
      className={`dedupe-toast ${pinned ? "is-pinned" : ""}`}
      role="region"
      aria-label="Possible duplicate tasks"
      aria-live="polite"
      onPointerDownCapture={pin}
      onKeyDownCapture={pin}
      onFocusCapture={pin}
    >
      <header className="dedupe-toast-header">
        <span className="dedupe-spark"><Sparkles size={15} /></span>
        <div>
          <strong>These tasks look alike</strong>
          <span>
            {pinned
              ? "Waiting for your choice"
              : windowActive
                ? "Dismisses in 30 seconds"
                : "Timer paused"}
          </span>
        </div>
        <button
          type="button"
          className="dedupe-close"
          aria-label="Dismiss duplicate suggestion"
          disabled={Boolean(busyAction)}
          onClick={() => void dismiss()}
        >
          <X size={15} />
        </button>
      </header>

      <div className="dedupe-comparison">
        <article>
          <span>New task</span>
          <p>{suggestion.newTask.title}</p>
          <p className={`dedupe-task-description ${suggestion.newTask.description ? "" : "is-empty"}`}>
            {suggestion.newTask.description || "No description"}
          </p>
        </article>
        <article>
          <span>Existing task</span>
          <p>{suggestion.existingTask.title}</p>
          <p className={`dedupe-task-description ${suggestion.existingTask.description ? "" : "is-empty"}`}>
            {suggestion.existingTask.description || "No description"}
          </p>
        </article>
      </div>

      <div className="dedupe-merge-preview">
        <span className="dedupe-preview-label"><GitMerge size={12} />Merged result</span>
        <strong>{merged.title}</strong>
        <p className={`dedupe-merged-description ${merged.description ? "" : "is-empty"}`}>
          {merged.description || "No description"}
        </p>
        <div className="dedupe-preview-meta" aria-label="Merged task details">
          <span>{formatBucket(merged.bucket)}</span>
          <span>{titleCase(merged.priority)} priority</span>
          <span>{titleCase(merged.area)}</span>
          <span>{formatDueDate(merged.dueDate)}</span>
          <span>{merged.estimateMinutes === null ? "No estimate" : `${merged.estimateMinutes} min`}</span>
        </div>
      </div>

      {error && <p className="dedupe-error" role="alert">{error}</p>}

      <footer className="dedupe-actions">
        <button
          type="button"
          disabled={Boolean(busyAction)}
          onClick={() => void resolve("deleteNew")}
          aria-label="Delete new task"
        >
          <Trash2 size={12} />Delete new
        </button>
        <button
          type="button"
          disabled={Boolean(busyAction)}
          onClick={() => void resolve("deleteExisting")}
          aria-label="Delete existing task"
        >
          <Trash2 size={12} />Delete existing
        </button>
        <button
          type="button"
          className="dedupe-merge"
          disabled={Boolean(busyAction)}
          onClick={() => void resolve("merge")}
          aria-label="Merge tasks"
        >
          <GitMerge size={13} />{busyAction === "merge" ? "Merging…" : "Merge"}
        </button>
      </footer>
      {!pinned && windowActive && <span className="dedupe-timer" aria-hidden="true" />}
    </section>
  );
}
