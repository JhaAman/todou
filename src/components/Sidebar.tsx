import {
  CalendarDays,
  CheckCircle2,
  Command,
  Inbox,
  ListTodo,
  Palette,
  Plus,
} from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { KeyHint } from "./KeyHint";
import { SyncStatusBar } from "./SyncStatusBar";
import type { ThemeDefinition } from "../lib/themes";
import type { SyncStatus } from "../lib/syncSettings";
import type { Bucket, View } from "../lib/types";

interface SidebarProps {
  view: View;
  onViewChange: (view: View) => void;
  onNewTask: () => void;
  onOpenPalette: () => void;
  onOpenThemes: () => void;
  onDropTask: (movingId: string, bucket: Bucket) => void;
  todayCount: number;
  inboxCount: number;
  theme: ThemeDefinition;
  newTaskShortcut: string;
  commandPaletteShortcut: string;
  syncStatus: SyncStatus;
}

const navigation = [
  { id: "home" as const, label: "Home", icon: ListTodo },
  { id: "today" as const, label: "Today", icon: CalendarDays },
  { id: "inbox" as const, label: "Inbox", icon: Inbox },
  { id: "logbook" as const, label: "Logbook", icon: CheckCircle2 },
];

export function Sidebar({
  view,
  onViewChange,
  onNewTask,
  onOpenPalette,
  onOpenThemes,
  onDropTask,
  todayCount,
  inboxCount,
  theme,
  newTaskShortcut,
  commandPaletteShortcut,
  syncStatus,
}: SidebarProps) {
  const [dropTarget, setDropTarget] = useState<Bucket | null>(null);

  useEffect(() => {
    const clearDropTarget = () => setDropTarget(null);
    window.addEventListener("dragend", clearDropTarget);
    window.addEventListener("drop", clearDropTarget);
    return () => {
      window.removeEventListener("dragend", clearDropTarget);
      window.removeEventListener("drop", clearDropTarget);
    };
  }, []);

  const handleDragOver = (event: DragEvent<HTMLButtonElement>, bucket: Bucket) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(bucket);
  };

  const handleDragLeave = (event: DragEvent<HTMLButtonElement>, bucket: Bucket) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (dropTarget === bucket) setDropTarget(null);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>, bucket: Bucket) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const movingId = event.dataTransfer.getData("text/todou-task");
    if (movingId) onDropTask(movingId, bucket);
  };

  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="traffic-spacer" data-tauri-drag-region />
      <div className="brand-row">
        <div className="brand-mark"><span /></div>
        <span className="brand-name">Todou</span>
        {import.meta.env.DEV && <span className="dev-badge">DEV</span>}
      </div>

      <button className="sidebar-create" onClick={onNewTask} aria-label="New task" title="New task">
        <Plus size={15} strokeWidth={2.2} />
        <span className="sr-only">New task</span>
        <KeyHint shortcut={newTaskShortcut} />
      </button>

      <nav className="sidebar-nav">
        {navigation.map(({ id, label, icon: Icon }) => {
          const count = id === "today" ? todayCount : id === "inbox" ? inboxCount : null;
          const dropBucket = id === "today" || id === "inbox" ? id : null;
          return (
            <button
              key={id}
              className={`nav-item ${view === id ? "is-active" : ""} ${dropBucket && dropTarget === dropBucket ? "is-task-drop-target" : ""}`}
              onClick={() => onViewChange(id)}
              aria-current={view === id ? "page" : undefined}
              data-drop-target={dropBucket ?? undefined}
              onDragOver={dropBucket ? (event) => handleDragOver(event, dropBucket) : undefined}
              onDragLeave={dropBucket ? (event) => handleDragLeave(event, dropBucket) : undefined}
              onDrop={dropBucket ? (event) => handleDrop(event, dropBucket) : undefined}
            >
              <Icon size={16} strokeWidth={1.9} />
              <span>{label}</span>
              {count !== null && <span className="nav-count">{count}</span>}
            </button>
          );
        })}
      </nav>

      <SyncStatusBar status={syncStatus} />

      <div className="sidebar-bottom">
        <button className="sidebar-tool theme-tool" onClick={onOpenThemes} aria-label={`Theme: ${theme.name}`} title={`Theme: ${theme.name}`}>
          <Palette size={16} strokeWidth={1.9} />
        </button>
        <button className="sidebar-tool command-launcher" onClick={onOpenPalette} aria-label="Commands" title="Commands">
          <Command size={15} />
          <KeyHint shortcut={commandPaletteShortcut} />
        </button>
      </div>
    </aside>
  );
}
