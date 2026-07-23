import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import {
  CalendarDays,
  Check,
  Clock3,
  CornerDownLeft,
  FileText,
  Flag,
  GripVertical,
  Inbox,
  RotateCcw,
  Trash2,
  UserRound,
} from "lucide-react";
import { KeyHint } from "../../components/KeyHint";
import type { ShortcutAction, Task } from "../../lib/types";

interface TaskRowProps {
  task: Task;
  selected: boolean;
  semanticRole?: "option" | "listitem";
  onSelect: () => void;
  onComplete: () => void;
  onRestore: () => void;
  onMove: (bucket: Task["bucket"]) => void;
  onTogglePriority: () => void;
  onToggleArea: () => void;
  onDelete: () => void;
  onDropTask: (movingId: string, targetId: string, edge: "before" | "after") => void;
  canAcceptDrop?: (movingId: string) => boolean;
  onDropRejected?: () => void;
  draggedTaskId?: string | null;
  onTaskDragStart?: (id: string) => void;
  onTaskDragEnd?: () => void;
  shortcuts: Record<ShortcutAction, string>;
}

export const taskDragType = "text/todou-task";

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

type ContextMenuPosition = { left: number; top: number };

export function TaskRow({ task, selected, semanticRole = "option", onSelect, onComplete, onRestore, onMove, onTogglePriority, onToggleArea, onDelete, onDropTask, canAcceptDrop, onDropRejected, draggedTaskId, onTaskDragStart, onTaskDragEnd, shortcuts }: TaskRowProps) {
  const [dropEdge, setDropEdge] = useState<"before" | "after" | null>(null);
  const [invalidDrop, setInvalidDrop] = useState(false);
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuPosition) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuPosition(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuPosition(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuPosition]);

  const stop = (event: MouseEvent, action: () => void) => {
    event.stopPropagation();
    action();
  };

  const acceptsDrop = (movingId?: string | null) => (
    !movingId || movingId === task.id || (canAcceptDrop?.(movingId) ?? true)
  );

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (task.completedAt) return;
    event.preventDefault();
    const movingId = event.dataTransfer.getData(taskDragType) || draggedTaskId;
    const accepted = acceptsDrop(movingId);
    event.dataTransfer.dropEffect = accepted ? "move" : "none";
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropEdge(event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
    setInvalidDrop(!accepted);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const movingId = event.dataTransfer.getData(taskDragType) || draggedTaskId;
    if (movingId && movingId !== task.id && dropEdge) {
      if (acceptsDrop(movingId)) onDropTask(movingId, task.id, dropEdge);
      else onDropRejected?.();
    }
    setDropEdge(null);
    setInvalidDrop(false);
  };

  const runMenuAction = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    event.stopPropagation();
    setMenuPosition(null);
    action();
  };

  const openContextMenu = (position: ContextMenuPosition) => {
    onSelect();
    setMenuPosition(position);
  };

  const navigateContextMenu = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuPosition(null);
      return;
    }
    if (event.key === "Home" || event.key === "End" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[nextIndex]?.focus();
    }
  };

  return (
    <div
      className={`task-row area-${task.area} ${task.priority === "high" ? "is-high" : ""} ${selected ? "is-selected" : ""} ${task.completedAt ? "is-completed" : ""} ${dropEdge && !invalidDrop ? "is-task-drop-target" : ""} ${invalidDrop ? "is-task-drop-invalid" : ""}`}
      role={semanticRole}
      aria-selected={semanticRole === "option" ? selected : undefined}
      aria-current={semanticRole === "listitem" && selected ? "true" : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        openContextMenu({
          left: Math.max(8, Math.min(event.clientX, window.innerWidth - 256)),
          top: Math.max(8, Math.min(event.clientY, window.innerHeight - 264)),
        });
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        openContextMenu({
          left: Math.max(8, Math.min(bounds.left + bounds.width / 2, window.innerWidth - 256)),
          top: Math.max(8, Math.min(bounds.top + bounds.height / 2, window.innerHeight - 264)),
        });
      }}
      draggable={!task.completedAt}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(taskDragType, task.id);
        onTaskDragStart?.(task.id);
      }}
      onDragEnd={() => {
        setDropEdge(null);
        setInvalidDrop(false);
        onTaskDragEnd?.();
      }}
      onDragOver={onDragOver}
      onDragLeave={() => {
        setDropEdge(null);
        setInvalidDrop(false);
      }}
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
          {task.description.trim() && <FileText className="description-mark" size={12} role="img" aria-label="Has description" />}
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
      {menuPosition && (
        <div
          ref={menuRef}
          className="task-context-menu"
          role="menu"
          aria-label={`Actions for ${task.title}`}
          style={menuPosition}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={navigateContextMenu}
        >
          {task.completedAt ? (
            <button role="menuitem" onClick={(event) => runMenuAction(event, onRestore)}>
              <RotateCcw size={16} />
              <span>Restore task</span>
              <KeyHint shortcut={shortcuts.complete} />
            </button>
          ) : (
            <button role="menuitem" onClick={(event) => runMenuAction(event, onComplete)}>
              <Check size={16} />
              <span>Mark complete</span>
              <KeyHint shortcut={shortcuts.complete} />
            </button>
          )}
          {!task.completedAt && task.bucket !== "today" && (
            <button role="menuitem" onClick={(event) => runMenuAction(event, () => onMove("today"))}>
              <CornerDownLeft size={16} />
              <span>Move to Today</span>
              <KeyHint shortcut={shortcuts.moveToday} />
            </button>
          )}
          {!task.completedAt && task.bucket !== "inbox" && (
            <button role="menuitem" onClick={(event) => runMenuAction(event, () => onMove("inbox"))}>
              <Inbox size={16} />
              <span>Move to Inbox</span>
              <KeyHint shortcut={shortcuts.moveInbox} />
            </button>
          )}
          <div className="task-context-menu-divider" role="separator" />
          <button role="menuitem" onClick={(event) => runMenuAction(event, onTogglePriority)}>
            <Flag size={16} fill={task.priority === "high" ? "currentColor" : "none"} />
            <span>{task.priority === "high" ? "Set low priority" : "Set high priority"}</span>
            <KeyHint shortcut={shortcuts.togglePriority} />
          </button>
          <button role="menuitem" onClick={(event) => runMenuAction(event, onToggleArea)}>
            <UserRound size={16} />
            <span>Move to {task.area === "work" ? "Personal" : "Work"}</span>
            <KeyHint shortcut={shortcuts.toggleArea} />
          </button>
          <div className="task-context-menu-divider" role="separator" />
          <button className="is-danger" role="menuitem" onClick={(event) => runMenuAction(event, onDelete)}>
            <Trash2 size={16} />
            <span>Delete task</span>
            <KeyHint shortcut={shortcuts.delete} />
          </button>
        </div>
      )}
    </div>
  );
}
