import { Search } from "lucide-react";
import type { RefObject } from "react";
import type { Task } from "../../lib/types";
import { TaskRow } from "./TaskRow";

interface FlatTaskListProps {
  query: string;
  onQueryChange: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder: string;
  tasks: Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onRestore: (id: string) => void;
  onMove: (id: string, bucket: Task["bucket"]) => void;
  onTogglePriority: (task: Task) => void;
  onDelete: (id: string) => void;
}

export function FlatTaskList(props: FlatTaskListProps) {
  return (
    <section className="flat-view">
      <header className="flat-header">
        <label className="search-field">
          <Search size={17} />
          <input
            ref={props.inputRef}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={props.placeholder}
            aria-label={props.placeholder}
          />
          {props.query && (
            <output aria-live="polite" aria-atomic="true">
              <span aria-hidden="true">{props.tasks.length}</span>
              <span className="sr-only">{props.tasks.length === 1 ? "1 result" : `${props.tasks.length} results`}</span>
            </output>
          )}
        </label>
      </header>

      {props.tasks.length ? (
        <div className="flat-results" role="list" aria-label="Search results">
          {props.tasks.map((task) => (
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
              onDropTask={() => undefined}
            />
          ))}
        </div>
      ) : props.query ? <div className="flat-empty">No results</div> : null}
    </section>
  );
}
