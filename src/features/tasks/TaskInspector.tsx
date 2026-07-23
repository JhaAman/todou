import { useEffect, useState, type KeyboardEvent } from "react";
import {
  CalendarDays,
  Check,
  Clock3,
  FileText,
  Flag,
  Inbox,
  RotateCcw,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { formatEstimate, parseEstimate } from "../../lib/naturalLanguage";
import { taskDescriptionMaxLength, type EditableTaskPatch, type Task } from "../../lib/types";

interface TaskInspectorProps {
  task: Task;
  onClose: () => void;
  onUpdate: (patch: EditableTaskPatch) => Promise<unknown>;
  onMove: (bucket: Task["bucket"]) => Promise<unknown>;
  onComplete: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

export function TaskInspector({ task, onClose, onUpdate, onMove, onComplete, onRestore, onDelete }: TaskInspectorProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [estimate, setEstimate] = useState(formatEstimate(task.estimateMinutes));
  const [estimateError, setEstimateError] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
    setEstimate(formatEstimate(task.estimateMinutes));
    setEstimateError(false);
  }, [task.id, task.title, task.description, task.estimateMinutes]);

  const saveTitle = () => {
    const next = title.trim();
    if (!next) setTitle(task.title);
    else if (next !== task.title) void onUpdate({ title: next });
  };

  const saveDescription = () => {
    const next = description.trim();
    if (next !== description) setDescription(next);
    if (next !== task.description) void onUpdate({ description: next });
  };

  const saveEstimate = () => {
    if (!estimate.trim()) {
      setEstimateError(false);
      if (task.estimateMinutes !== null) void onUpdate({ estimateMinutes: null });
      return;
    }
    const minutes = parseEstimate(estimate);
    if (!minutes) {
      setEstimateError(true);
      return;
    }
    setEstimate(formatEstimate(minutes));
    setEstimateError(false);
    if (minutes !== task.estimateMinutes) void onUpdate({ estimateMinutes: minutes });
  };

  const titleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      saveTitle();
      event.currentTarget.blur();
    }
  };

  return (
    <aside className="inspector" aria-label="Task details">
      <div className="inspector-topbar" data-tauri-drag-region>
        <span className="sr-only">Task details</span>
        <button className="icon-button" onClick={onClose} aria-label="Close details"><X size={16} /></button>
      </div>
      <div className="inspector-scroll">
        <div className="inspector-title-editor">
          <div className={`inspector-area-mark area-${task.area}`} aria-hidden="true" />
          <textarea
            className="inspector-title"
            rows={2}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={titleKeyDown}
            aria-label="Task title"
          />
        </div>
        <label className="inspector-description-editor">
          <span className="inspector-description-label"><FileText size={14} />Description</span>
          <textarea
            className="inspector-description"
            rows={4}
            maxLength={taskDescriptionMaxLength}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={saveDescription}
            placeholder="Add notes, links, or details…"
            aria-label="Description"
          />
        </label>
        {task.completedAt && <div className="inspector-status-row"><span className="status-pill complete"><span />Completed</span></div>}

        <div className="inspector-divider" />

        <div className="field-row">
          <span className="field-name" title="List" aria-label="List"><Inbox size={15} /><span className="sr-only">List</span></span>
          <div className="segmented-control" role="group" aria-label="List">
            <button
              className={task.bucket === "today" ? "is-active" : ""}
              aria-pressed={task.bucket === "today"}
              disabled={Boolean(task.completedAt)}
              title={task.completedAt ? "Restore this task before moving it" : undefined}
              onClick={() => void onMove("today")}
            >Today</button>
            <button
              className={task.bucket === "inbox" ? "is-active" : ""}
              aria-pressed={task.bucket === "inbox"}
              disabled={Boolean(task.completedAt)}
              title={task.completedAt ? "Restore this task before moving it" : undefined}
              onClick={() => void onMove("inbox")}
            >Inbox</button>
          </div>
        </div>

        <div className="field-row">
          <span className="field-name" title="Priority" aria-label="Priority"><Flag size={15} /><span className="sr-only">Priority</span></span>
          <div className="segmented-control" role="group" aria-label="Priority">
            <button aria-pressed={task.priority === "high"} className={task.priority === "high" ? "is-active high" : ""} onClick={() => void onUpdate({ priority: "high" })}>High</button>
            <button aria-pressed={task.priority === "low"} className={task.priority === "low" ? "is-active" : ""} onClick={() => void onUpdate({ priority: "low" })}>Low</button>
          </div>
        </div>

        <div className="field-row">
          <span className="field-name" title="Area" aria-label="Area"><UserRound size={15} /><span className="sr-only">Area</span></span>
          <div className="segmented-control" role="group" aria-label="Area">
            <button aria-pressed={task.area === "work"} className={task.area === "work" ? "is-active work" : ""} onClick={() => void onUpdate({ area: "work" })}>Work</button>
            <button aria-pressed={task.area === "personal"} className={task.area === "personal" ? "is-active personal" : ""} onClick={() => void onUpdate({ area: "personal" })}>Personal</button>
          </div>
        </div>

        <div className="inspector-divider" />

        <label className="detail-input-row">
          <span className="field-name" title="Due date"><CalendarDays size={15} /><span className="sr-only">Due date</span></span>
          <input
            className="date-input"
            type="date"
            value={task.dueDate ?? ""}
            onChange={(event) => void onUpdate({ dueDate: event.target.value || null })}
            aria-label="Due date"
          />
        </label>

        <label className={`detail-input-row compact ${estimateError ? "has-error" : ""}`}>
          <span className="estimate-compact">
            <Clock3 size={14} />
            <input
              className="estimate-input"
              value={estimate}
              onChange={(event) => setEstimate(event.target.value)}
              onBlur={saveEstimate}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              placeholder="30m"
              aria-label="Estimated time"
            />
          </span>
        </label>
        {estimateError && <p className="field-error">Use a duration like 25m or 1h 15m.</p>}

        <div className="inspector-spacer" />
        <div className="inspector-actions">
          {task.completedAt ? (
            <button className="primary-action" onClick={onRestore}><RotateCcw size={15} />Restore to list</button>
          ) : (
            <button className="primary-action has-shortcut" onClick={onComplete}>
              <span className="inspector-action-label"><Check size={15} />Mark complete</span>
              <kbd>⌘↵</kbd>
            </button>
          )}
          <button className="danger-action" onClick={onDelete}><Trash2 size={15} />Delete</button>
        </div>
      </div>
    </aside>
  );
}
