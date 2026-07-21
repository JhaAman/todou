import {
  CalendarDays,
  CheckCircle2,
  Command,
  Inbox,
  ListTodo,
  Palette,
  Plus,
} from "lucide-react";
import { KeyHint } from "./KeyHint";
import type { ThemeDefinition } from "../lib/themes";
import type { View } from "../lib/types";

interface SidebarProps {
  view: View;
  onViewChange: (view: View) => void;
  onNewTask: () => void;
  onOpenPalette: () => void;
  onOpenThemes: () => void;
  todayCount: number;
  inboxCount: number;
  theme: ThemeDefinition;
  newTaskShortcut: string;
  commandPaletteShortcut: string;
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
  todayCount,
  inboxCount,
  theme,
  newTaskShortcut,
  commandPaletteShortcut,
}: SidebarProps) {
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
          return (
            <button
              key={id}
              className={`nav-item ${view === id ? "is-active" : ""}`}
              onClick={() => onViewChange(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={16} strokeWidth={1.9} />
              <span>{label}</span>
              {count !== null && <span className="nav-count">{count}</span>}
            </button>
          );
        })}
      </nav>

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
