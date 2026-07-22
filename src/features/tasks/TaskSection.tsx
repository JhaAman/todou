import { Plus } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import type { Bucket, Task } from "../../lib/types";
import { taskDragType, TaskRow } from "./TaskRow";

interface TaskSectionProps {
  title: string;
  bucket: Bucket;
  hideHeader?: boolean;
  tasks: Task[];
  selectedTaskId: string | null;
  onAdd?: () => void;
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onRestore: (id: string) => void;
  onMove: (id: string, bucket: Task["bucket"]) => void;
  onTogglePriority: (task: Task) => void;
  onDelete: (id: string) => void;
  onDropTask: (movingId: string, targetId: string, edge: "before" | "after") => void;
  onDropIntoBucket: (movingId: string, bucket: Bucket) => void;
  children?: ReactNode;
}

export function TaskSection(props: TaskSectionProps) {
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
      onDelete={() => props.onDelete(task.id)}
      onDropTask={props.onDropTask}
    />
  ));

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const movingId = event.dataTransfer.getData(taskDragType);
    if (movingId) props.onDropIntoBucket(movingId, props.bucket);
  };

  return (
    <section
      className="task-section"
      data-drop-target={props.bucket}
      aria-label={props.hideHeader ? `${props.title} tasks` : undefined}
      aria-labelledby={props.hideHeader ? undefined : `section-${props.title.toLocaleLowerCase()}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {!props.hideHeader && (
        <header className="section-header">
          <h2 id={`section-${props.title.toLocaleLowerCase()}`}>{props.title}</h2>
          <div className="section-header-actions">
            <span className="section-count">{props.tasks.length}</span>
            {props.onAdd && <button className="icon-button" onClick={props.onAdd} aria-label={`Add task to ${props.title}`} title={`Add task to ${props.title}`}><Plus size={16} /></button>}
          </div>
        </header>
      )}

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
