import { Plus } from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import type { Bucket, ShortcutAction, Task } from "../../lib/types";
import { taskDragType, TaskRow } from "./TaskRow";

interface TaskSectionProps {
  title: string;
  bucket: Bucket;
  hideHeader?: boolean;
  maxTasks?: number;
  tasks: Task[];
  selectedTaskId: string | null;
  onAdd?: () => void;
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onRestore: (id: string) => void;
  onMove: (id: string, bucket: Task["bucket"]) => void;
  onTogglePriority: (task: Task) => void;
  onToggleArea: (task: Task) => void;
  onDelete: (id: string) => void;
  onDropTask: (movingId: string, targetId: string, edge: "before" | "after") => void;
  onDropIntoBucket: (movingId: string, bucket: Bucket) => void;
  canAcceptDrop?: (movingId: string, bucket: Bucket) => boolean;
  onDropRejected?: (bucket: Bucket) => void;
  draggedTaskId?: string | null;
  onTaskDragStart?: (id: string) => void;
  onTaskDragEnd?: () => void;
  shortcuts: Record<ShortcutAction, string>;
  children?: ReactNode;
}

export function TaskSection(props: TaskSectionProps) {
  const [dropState, setDropState] = useState<"idle" | "valid" | "invalid">("idle");
  const sectionId = `section-${props.bucket}`;
  const isFull = props.maxTasks !== undefined && props.tasks.length >= props.maxTasks;

  useEffect(() => {
    const clearDropState = () => setDropState("idle");
    window.addEventListener("dragend", clearDropState);
    window.addEventListener("drop", clearDropState, true);
    return () => {
      window.removeEventListener("dragend", clearDropState);
      window.removeEventListener("drop", clearDropState, true);
    };
  }, []);

  const renderRows = (tasks: Task[]) => tasks.map((task) => (
    <TaskRow
      key={task.id}
      task={task}
      semanticRole="listitem"
      selected={props.selectedTaskId === task.id}
      onSelect={() => props.onSelect(task.id)}
      onComplete={() => props.onComplete(task.id)}
      onRestore={() => props.onRestore(task.id)}
      onMove={(bucket) => props.onMove(task.id, bucket)}
      onTogglePriority={() => props.onTogglePriority(task)}
      onToggleArea={() => props.onToggleArea(task)}
      onDelete={() => props.onDelete(task.id)}
      onDropTask={props.onDropTask}
      canAcceptDrop={(movingId) => props.canAcceptDrop?.(movingId, props.bucket) ?? true}
      onDropRejected={() => props.onDropRejected?.(props.bucket)}
      draggedTaskId={props.draggedTaskId}
      onTaskDragStart={props.onTaskDragStart}
      onTaskDragEnd={props.onTaskDragEnd}
      shortcuts={props.shortcuts}
    />
  ));

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    const movingId = props.draggedTaskId ?? event.dataTransfer.getData(taskDragType);
    if (!movingId) return;
    event.preventDefault();
    const accepted = props.canAcceptDrop?.(movingId, props.bucket) ?? true;
    event.dataTransfer.dropEffect = accepted ? "move" : "none";
    setDropState(accepted ? "valid" : "invalid");
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropState("idle");
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const movingId = event.dataTransfer.getData(taskDragType) || props.draggedTaskId;
    const accepted = Boolean(movingId) && (props.canAcceptDrop?.(movingId, props.bucket) ?? true);
    setDropState("idle");
    if (movingId && accepted) props.onDropIntoBucket(movingId, props.bucket);
    else if (movingId) props.onDropRejected?.(props.bucket);
  };

  return (
    <section
      className={`task-section task-section-${props.bucket} ${dropState === "valid" ? "is-task-drop-target" : ""} ${dropState === "invalid" ? "is-task-drop-invalid" : ""}`}
      data-drop-target={props.bucket}
      aria-label={props.hideHeader ? `${props.title} tasks` : undefined}
      aria-labelledby={props.hideHeader ? undefined : sectionId}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {!props.hideHeader && (
        <header className="section-header">
          <h2 id={sectionId}>{props.title}</h2>
          <div className="section-header-actions">
            <span className="section-count">{props.tasks.length}{props.maxTasks !== undefined ? ` / ${props.maxTasks}` : ""}</span>
            {props.onAdd && <button className="icon-button" onClick={props.onAdd} aria-label={`Add task to ${props.title}`} title={`Add task to ${props.title}`}><Plus size={16} /></button>}
          </div>
        </header>
      )}

      {dropState === "invalid" && isFull && <span className="sr-only" role="status">In Progress is full. Move or complete a task before adding another.</span>}

      {props.children}

      {props.tasks.length ? (
        <div className="task-list" role="list" aria-label={`${props.title} tasks`}>
          {renderRows(props.tasks)}
        </div>
      ) : (
        <div className="task-list flat-empty" data-empty="true">
          Drop tasks here
          <span className="sr-only">. {props.title} is empty</span>
        </div>
      )}
    </section>
  );
}
