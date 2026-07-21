import { useState, type DragEvent, type MouseEvent } from "react";
import {
  CalendarDays,
  Check,
  Clock3,
  CornerDownLeft,
  Flag,
  GripVertical,
  Inbox,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { Task } from "../../lib/types";

interface TaskRowProps {
  task: Task;
  selected: boolean;
  semanticRole?: "option" | "listitem";
  onSelect: () => void;
  onComplete: () => void;
  onRestore: () => void;
  onMove: (bucket: Task["bucket"]) => void;
  onTogglePriority: () => void;
  onDelete: () => void;
  onReorder: (movingId: string, targetId: string, edge: "before" | "after") => void;
}

function prettyDate(value: string): string {
  const parts = value.split("-").map(Number);
  const year = parts[0] ?? new Date().getFullYear();
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const todayValue = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, "0")}-${`${today.getDate()}`.padStart(2, "0")}`;
  if (value === todayValue) return "Today";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function TaskRow({ task, selected, semanticRole = "option", onSelect, onComplete, onRestore, onMove, onTogglePriority, onDelete, onReorder }: TaskRowProps) {
  const [dropEdge, setDropEdge] = useState<"before" | "after" | null>(null);

  const stop = (event: MouseEvent, action: () => void) => {
    event.stopPropagation();
    action();
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (task.completedAt) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropEdge(event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const movingId = event.dataTransfer.getData("text/todou-task");
    if (movingId && movingId !== task.id && dropEdge) onReorder(movingId, task.id, dropEdge);
    setDropEdge(null);
  };

  return (
    <div
      className={`task-row area-${task.area} ${task.priority === "high" ? "is-high" : ""} ${selected ? "is-selected" : ""} ${task.completedAt ? "is-completed" : ""} ${dropEdge ? `drop-${dropEdge}` : ""}`}
      role={semanticRole}
      aria-selected={semanticRole === "option" ? selected : undefined}
      aria-current={semanticRole === "listitem" && selected ? "true" : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      draggable={!task.completedAt}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/todou-task", task.id);
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDropEdge(null)}
      onDrop={onDrop}
    >
      <span className="area-rail" aria-hidden="true" />
      {!task.completedAt && <GripVertical className="drag-handle" size={15} aria-hidden="true" />}
      <button
        className="complete-button"
        aria-label={task.completedAt ? `Restore ${task.title}` : `Complete ${task.title}`}
        onClick={(event) => stop(event, task.completedAt ? onRestore : onComplete)}
      >
        {task.completedAt ? <RotateCcw size={13} /> : <Check size={13} />}
      </button>
      <div className="task-copy">
        <div className="task-title-line">
          <span className="task-title">{task.title}</span>
          {task.priority === "high" && <Flag className="priority-mark" size={12} fill="currentColor" aria-label="High priority" />}
        </div>
        <div className="task-meta">
          <span className={`area-label ${task.area}`}>{task.area}</span>
          {task.dueDate && <span className="meta-item"><CalendarDays size={11} />{prettyDate(task.dueDate)}</span>}
          {task.estimateMinutes && <span className="meta-item"><Clock3 size={11} />{task.estimateMinutes}m</span>}
          {task.completedAt && <span className="meta-item">Completed {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(task.completedAt))}</span>}
        </div>
      </div>
      <div className="task-actions" role="group" aria-label={`Actions for ${task.title}`}>
        {!task.completedAt && (
          <>
            <button
              title={task.priority === "high" ? "Set low priority" : "Set high priority"}
              aria-label="High priority"
              aria-pressed={task.priority === "high"}
              onClick={(event) => stop(event, onTogglePriority)}
            >
              <Flag size={14} fill={task.priority === "high" ? "currentColor" : "none"} />
            </button>
            <button
              title={`Move to ${task.bucket === "today" ? "Inbox" : "Today"}`}
              aria-label={`Move ${task.title} to ${task.bucket === "today" ? "Inbox" : "Today"}`}
              onClick={(event) => stop(event, () => onMove(task.bucket === "today" ? "inbox" : "today"))}
            >
              {task.bucket === "today" ? <Inbox size={14} /> : <CornerDownLeft size={14} />}
            </button>
          </>
        )}
        <button title="Delete" aria-label={`Delete ${task.title}`} onClick={(event) => stop(event, onDelete)}><Trash2 size={14} /></button>
      </div>
    </div>
  );
}
