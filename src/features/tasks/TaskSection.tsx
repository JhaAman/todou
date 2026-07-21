import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { Task } from "../../lib/types";
import { TaskRow } from "./TaskRow";

interface TaskSectionProps {
  title: string;
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
  onReorder: (movingId: string, targetId: string, edge: "before" | "after") => void;
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
      onReorder={props.onReorder}
    />
  ));

  return (
    <section
      className="task-section"
      aria-label={props.hideHeader ? `${props.title} tasks` : undefined}
      aria-labelledby={props.hideHeader ? undefined : `section-${props.title.toLocaleLowerCase()}`}
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
      ) : <span className="sr-only">{props.title} is empty</span>}
    </section>
  );
}
