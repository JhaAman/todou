import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowLeft,
  BrainCircuit,
  CalendarDays,
  Check,
  CheckCircle2,
  Command,
  Download,
  Inbox,
  Keyboard,
  ListTodo,
  Palette,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  UserRound,
  Flag,
  Hammer,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { displayShortcut, shortcutFromEvent, shortcutLabels, shortcutsEqual } from "../../lib/shortcuts";
import { themeById, themes } from "../../lib/themes";
import type { ShortcutAction, Task, ThemeId, View } from "../../lib/types";
import { KeyHint } from "../../components/KeyHint";

export type PaletteMode = "commands" | "themes" | "shortcuts";

interface CommandPaletteProps {
  open: boolean;
  startMode: PaletteMode;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: View) => void;
  onNewTask: () => void;
  onExport: () => void;
  onOpenSettings: () => void;
  onOpenAiSettings: () => void;
  onRunDedupeScan: () => void;
  dedupeScanRunning: boolean;
  onBuildInstaller?: () => void;
  selectedTask: Task | null;
  canUndo: boolean;
  onCompleteSelected: () => void;
  onRestoreSelected: () => void;
  onMoveSelected: (bucket: Task["bucket"]) => void;
  onTogglePrioritySelected: () => void;
  onToggleAreaSelected: () => void;
  onDeleteSelected: () => void;
  onUndo: () => void;
  committedTheme: ThemeId;
  onThemePreview: (theme: ThemeId) => void;
  onThemeCommit: (theme: ThemeId) => void;
  shortcuts: Record<ShortcutAction, string>;
  onShortcutChange: (action: ShortcutAction, shortcut: string) => void;
}

interface PaletteCommand {
  id: string;
  label: string;
  detail: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

const shortcutActions = Object.keys(shortcutLabels) as ShortcutAction[];

export function CommandPalette(props: CommandPaletteProps) {
  const [mode, setMode] = useState<PaletteMode>(props.startMode);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const themeOrigin = useRef(props.committedTheme);
  const themeCommitted = useRef(false);

  const closeAnd = (action: () => void) => {
    props.onOpenChange(false);
    action();
  };

  const commands: PaletteCommand[] = [
    { id: "new", label: "Create new task", detail: "Capture with natural language", icon: <Plus />, shortcut: props.shortcuts.newTask, run: () => closeAnd(props.onNewTask) },
    ...(props.selectedTask ? [
      props.selectedTask.completedAt
        ? { id: "restore", label: "Restore selected task", detail: "Move it out of Logbook", icon: <RotateCcw />, shortcut: props.shortcuts.complete, run: () => closeAnd(props.onRestoreSelected) }
        : { id: "complete", label: "Complete selected task", detail: "Move it to Logbook", icon: <CheckCircle2 />, shortcut: props.shortcuts.complete, run: () => closeAnd(props.onCompleteSelected) },
      ...(!props.selectedTask.completedAt ? [
        { id: "move-today", label: "Move selected task to Today", detail: "Make it part of today's list", icon: <CalendarDays />, shortcut: props.shortcuts.moveToday, run: () => closeAnd(() => props.onMoveSelected("today")) },
        { id: "move-inbox", label: "Move selected task to Inbox", detail: "Clears its due date", icon: <Inbox />, shortcut: props.shortcuts.moveInbox, run: () => closeAnd(() => props.onMoveSelected("inbox")) },
      ] : []),
      { id: "priority", label: props.selectedTask.priority === "high" ? "Set selected task to low priority" : "Set selected task to high priority", detail: "Change its priority flag", icon: <Flag />, shortcut: props.shortcuts.togglePriority, run: () => closeAnd(props.onTogglePrioritySelected) },
      { id: "area", label: `Set selected task to ${props.selectedTask.area === "work" ? "personal" : "work"}`, detail: "Change its area accent", icon: <UserRound />, shortcut: props.shortcuts.toggleArea, run: () => closeAnd(props.onToggleAreaSelected) },
      { id: "delete", label: "Delete selected task", detail: "Recoverable only with Undo", icon: <Trash2 />, shortcut: props.shortcuts.delete, run: () => closeAnd(props.onDeleteSelected) },
    ] satisfies PaletteCommand[] : []),
    ...(props.canUndo ? [{ id: "undo", label: "Undo last action", detail: "Restore the most recent completion or deletion", icon: <Undo2 />, shortcut: props.shortcuts.undo, run: () => closeAnd(props.onUndo) }] : []),
    { id: "home", label: "Go to Home", detail: "Today and Inbox together", icon: <ListTodo />, run: () => closeAnd(() => props.onNavigate("home")) },
    { id: "today", label: "Go to Today", detail: "What needs your attention now", icon: <CalendarDays />, run: () => closeAnd(() => props.onNavigate("today")) },
    { id: "inbox", label: "Go to Inbox", detail: "Unscheduled tasks and ideas", icon: <Inbox />, run: () => closeAnd(() => props.onNavigate("inbox")) },
    { id: "logbook", label: "Open Logbook", detail: "Search and restore completed work", icon: <CheckCircle2 />, run: () => closeAnd(() => props.onNavigate("logbook")) },
    { id: "search", label: "Search all tasks", detail: "Active tasks and Logbook", icon: <Search />, shortcut: props.shortcuts.search, run: () => closeAnd(() => props.onNavigate("search")) },
    { id: "theme", label: "Change theme", detail: themeById(props.committedTheme).name, icon: <Palette />, run: () => enterMode("themes") },
    { id: "shortcuts", label: "Keyboard shortcuts", detail: "Change the system-wide Quick Entry shortcut and other commands", icon: <Keyboard />, run: () => enterMode("shortcuts") },
    { id: "export", label: "Export tasks as JSON", detail: "One human-readable file", icon: <Download />, run: () => closeAnd(props.onExport) },
    { id: "dedupe-scan", label: "Check all tasks for duplicates", detail: props.dedupeScanRunning ? "A scan is already running" : "Analyze active tasks now", icon: <Sparkles />, run: () => closeAnd(props.onRunDedupeScan) },
    { id: "ai-settings", label: "AI de-duplication settings", detail: "Configure OpenAI or Anthropic", icon: <BrainCircuit />, run: () => closeAnd(props.onOpenAiSettings) },
    { id: "settings", label: "Connection settings", detail: "Configure Supabase on this Mac", icon: <Settings2 />, run: () => closeAnd(props.onOpenSettings) },
    ...(import.meta.env.DEV && props.onBuildInstaller ? [{
      id: "build-installer",
      label: "Build production app",
      detail: "Install directly without leaving a mounted DMG",
      icon: <Hammer />,
      run: () => closeAnd(props.onBuildInstaller!),
    }] satisfies PaletteCommand[] : []),
  ];

  const filteredCommands = useMemo(() => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return commands;
    return commands.filter((command) => words.every((word) => `${command.label} ${command.detail}`.toLocaleLowerCase().includes(word)));
  }, [commands, query]);

  function enterMode(nextMode: PaletteMode) {
    setMode(nextMode);
    setQuery("");
    setActiveIndex(nextMode === "themes" ? Math.max(0, themes.findIndex(({ id }) => id === props.committedTheme)) : 0);
    setRecording(null);
    setShortcutError(null);
    if (nextMode === "themes") {
      themeOrigin.current = props.committedTheme;
      themeCommitted.current = false;
    }
  }

  useEffect(() => {
    if (!props.open) return;
    themeOrigin.current = props.committedTheme;
    themeCommitted.current = false;
    setMode(props.startMode);
    setQuery("");
    setRecording(null);
    setShortcutError(null);
    setActiveIndex(props.startMode === "themes" ? Math.max(0, themes.findIndex(({ id }) => id === props.committedTheme)) : 0);
  }, [props.open, props.startMode, props.committedTheme]);

  useEffect(() => {
    if (mode === "themes" && props.open) props.onThemePreview(themes[activeIndex]?.id ?? props.committedTheme);
  }, [activeIndex, mode, props.open]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, filteredCommands.length - 1)));
  }, [filteredCommands.length]);

  useEffect(() => {
    if (props.open) activeRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, mode, props.open]);

  const requestOpenChange = (open: boolean) => {
    if (!open && mode === "themes" && !themeCommitted.current) props.onThemePreview(themeOrigin.current);
    props.onOpenChange(open);
  };

  const back = () => {
    if (mode === "themes" && !themeCommitted.current) props.onThemePreview(themeOrigin.current);
    setMode("commands");
    setQuery("");
    setActiveIndex(0);
    setRecording(null);
    setShortcutError(null);
  };

  const itemCount = mode === "commands" ? filteredCommands.length : mode === "themes" ? themes.length : shortcutActions.length;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (recording) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setShortcutError(null);
        return;
      }
      const next = shortcutFromEvent(event);
      if (!next) return;
      const collision = shortcutActions.find((action) => action !== recording && shortcutsEqual(props.shortcuts[action], next));
      if (collision) {
        setShortcutError(`${displayShortcut(next)} is already used by ${shortcutLabels[collision]}.`);
        return;
      }
      props.onShortcutChange(recording, next);
      setRecording(null);
      setShortcutError(null);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + itemCount) % Math.max(1, itemCount));
      return;
    }
    if (event.key === "Escape" && mode !== "commands") {
      event.preventDefault();
      event.stopPropagation();
      back();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (mode === "commands") filteredCommands[activeIndex]?.run();
      if (mode === "themes") {
        const theme = themes[activeIndex];
        if (theme) {
          themeCommitted.current = true;
          props.onThemeCommit(theme.id);
          props.onOpenChange(false);
        }
      }
      if (mode === "shortcuts") setRecording(shortcutActions[activeIndex] ?? null);
    }
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={requestOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-backdrop" />
        <Dialog.Viewport className="palette-viewport">
          <Dialog.Popup className="command-palette" onKeyDown={handleKeyDown}>
            <Dialog.Title className="sr-only">{mode === "commands" ? "Command palette" : mode === "themes" ? "Choose theme" : "Keyboard shortcuts"}</Dialog.Title>
            <Dialog.Description className="sr-only">Use arrow keys to navigate and Enter to choose.</Dialog.Description>
            <header className="palette-header">
              {mode === "commands" ? <Command size={18} /> : <button className="palette-back" onClick={back} aria-label="Back to commands"><ArrowLeft size={17} /></button>}
              {mode === "commands" ? (
                <input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} placeholder="Type a command or search features…" aria-label="Search commands" />
              ) : (
                <div className="palette-title-block">
                  <strong>{mode === "themes" ? "Choose a theme" : "Keyboard shortcuts"}</strong>
                  <span>{mode === "themes" ? "Preview instantly with ↑ and ↓" : "Select a row, then press a new shortcut"}</span>
                </div>
              )}
              {mode === "commands" && <KeyHint shortcut={props.shortcuts.commandPalette} />}
            </header>

            <div className="palette-list" role="listbox">
              {mode === "commands" && (
                filteredCommands.length ? filteredCommands.map((command, index) => (
                  <button
                    key={command.id}
                    ref={index === activeIndex ? activeRowRef : undefined}
                    className={`palette-row ${index === activeIndex ? "is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={command.run}
                    role="option"
                    aria-selected={index === activeIndex}
                  >
                    <span className="palette-icon">{command.icon}</span>
                    <span className="palette-copy"><strong>{command.label}</strong><small>{command.detail}</small></span>
                    {command.shortcut && <KeyHint shortcut={command.shortcut} />}
                  </button>
                )) : <div className="palette-empty"><Search size={24} /><span>No command matches “{query}”</span></div>
              )}

              {mode === "themes" && themes.map((theme, index) => (
                <button
                  key={theme.id}
                  ref={index === activeIndex ? activeRowRef : undefined}
                  className={`theme-row ${index === activeIndex ? "is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    themeCommitted.current = true;
                    props.onThemeCommit(theme.id);
                    props.onOpenChange(false);
                  }}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <span className="theme-swatches">{theme.colors.map((color, swatchIndex) => <i key={swatchIndex} style={{ background: color }} />)}</span>
                  <span className="palette-copy"><strong>{theme.name}</strong><small>{theme.description}</small></span>
                  {props.committedTheme === theme.id && <Check size={16} />}
                </button>
              ))}

              {mode === "shortcuts" && shortcutActions.map((action, index) => (
                <button
                  key={action}
                  ref={index === activeIndex ? activeRowRef : undefined}
                  className={`shortcut-row ${index === activeIndex ? "is-active" : ""} ${recording === action ? "is-recording" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => { setRecording(action); setShortcutError(null); }}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <span className="shortcut-symbol">{action === "quickEntry" ? <Sparkles size={15} /> : <Keyboard size={15} />}</span>
                  <span className="shortcut-label">{shortcutLabels[action]}</span>
                  {recording === action ? <span className="recording-pill">Press keys…</span> : <KeyHint shortcut={props.shortcuts[action]} />}
                </button>
              ))}
            </div>

            {mode === "shortcuts" && shortcutError && <div className="shortcut-error">{shortcutError}</div>}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
