import {
  CalendarDays,
  CheckCircle2,
  Command,
  Inbox,
  PanelRightOpen,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyHint } from "./components/KeyHint";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette, type PaletteMode } from "./features/palette/CommandPalette";
import { SyncSettingsDialog } from "./features/settings/SyncSettingsDialog";
import { FlatTaskList } from "./features/tasks/FlatTaskList";
import { InlineComposer } from "./features/tasks/InlineComposer";
import { TaskInspector } from "./features/tasks/TaskInspector";
import { TaskSection } from "./features/tasks/TaskSection";
import { useTaskController } from "./features/tasks/useTaskController";
import { loadPreferences, savePreferences } from "./lib/preferences";
import { isInteractiveShortcutTarget, shortcutLabels, shortcutMatches } from "./lib/shortcuts";
import { startRealtimeWake } from "./lib/realtimeWake";
import {
  emptySyncSettings,
  toNativeShortcut,
  type SyncSettings,
  type SyncStatus,
} from "./lib/syncSettings";
import { isTauriRuntime, taskClient } from "./lib/taskClient";
import { completedTasks, reorderAnchors, searchTasks, tasksForBucket } from "./lib/taskOrdering";
import { applyTheme, themeById } from "./lib/themes";
import type { AppPreferences, Bucket, ShortcutAction, Task, ThemeId, View } from "./lib/types";

function formatHeaderDate(): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

const shortcutWarningKey = "todou.quick-entry-shortcut-warning.v1";
const inProgressTaskLimit = 3;
type TaskShortcutAction = Extract<ShortcutAction, "complete" | "moveToday" | "moveInbox" | "togglePriority" | "toggleArea" | "delete">;
type ShortcutTip = { action: TaskShortcutAction; label: string };

function viewTitle(view: View): { title: string; subtitle?: string; icon: typeof Sparkles } {
  if (view === "today") return { title: "Today", subtitle: formatHeaderDate(), icon: CalendarDays };
  if (view === "inbox") return { title: "Inbox", icon: Inbox };
  if (view === "logbook") return { title: "Logbook", icon: CheckCircle2 };
  if (view === "search") return { title: "Search", icon: Search };
  return { title: "Home", subtitle: formatHeaderDate(), icon: Sparkles };
}

function InspectorPlaceholder() {
  return (
    <aside className="inspector inspector-placeholder" aria-label="Task details">
      <div className="inspector-topbar" data-tauri-drag-region><span className="sr-only">Task details</span></div>
      <div className="inspector-placeholder-body">
        <span className="placeholder-glyph"><PanelRightOpen size={21} /></span>
        <strong>Select a task</strong>
      </div>
    </aside>
  );
}

export default function App() {
  const controller = useTaskController();
  const [view, setView] = useState<View>("home");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [composerBucket, setComposerBucket] = useState<Bucket | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("commands");
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  const [previewTheme, setPreviewTheme] = useState<ThemeId>(preferences.themeId);
  const [searchQuery, setSearchQuery] = useState("");
  const [logbookQuery, setLogbookQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [shortcutTip, setShortcutTip] = useState<ShortcutTip | null>(null);
  const [shortcutWarning, setShortcutWarning] = useState<string | null>(() => localStorage.getItem(shortcutWarningKey));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(emptySyncSettings);
  const [syncSettingsLoaded, setSyncSettingsLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("not-connected");
  const [buildingInstaller, setBuildingInstaller] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchReturnViewRef = useRef<View>("home");
  const noticeTimerRef = useRef<number | null>(null);
  const selectionVersionRef = useRef(0);
  const shortcutTipTimerRef = useRef<number | null>(null);

  const selectTask = useCallback((id: string | null) => {
    selectionVersionRef.current += 1;
    setSelectedTaskId(id);
  }, []);

  const inProgressTasks = useMemo(() => tasksForBucket(controller.tasks, "in_progress"), [controller.tasks]);
  const todayTasks = useMemo(() => tasksForBucket(controller.tasks, "today"), [controller.tasks]);
  const inboxTasks = useMemo(() => tasksForBucket(controller.tasks, "inbox"), [controller.tasks]);
  const logbookTasks = useMemo(() => {
    const completed = completedTasks(controller.tasks);
    if (!logbookQuery.trim()) return completed;
    return searchTasks(completed, logbookQuery);
  }, [controller.tasks, logbookQuery]);
  const searchResults = useMemo(() => searchTasks(controller.tasks, searchQuery), [controller.tasks, searchQuery]);
  const selectedTask = useMemo(() => controller.tasks.find(({ id, deletedAt }) => id === selectedTaskId && !deletedAt) ?? null, [controller.tasks, selectedTaskId]);
  const header = viewTitle(view);
  const HeaderIcon = header.icon;

  useEffect(() => {
    applyTheme(previewTheme);
    if (isTauriRuntime()) {
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit("todou://theme-preview", { themeId: previewTheme }))
        .catch(() => undefined);
    }
  }, [previewTheme]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    void taskClient.getSyncSettings()
      .then(setSyncSettings)
      .finally(() => setSyncSettingsLoaded(true));
  }, []);

  useEffect(() => {
    if (!syncSettingsLoaded) return;
    let cancelled = false;
    let disconnect: (() => Promise<void>) | undefined;
    void startRealtimeWake(syncSettings, () => taskClient.wakeSync()).then((cleanup) => {
      if (cancelled) void cleanup();
      else disconnect = cleanup;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (disconnect) void disconnect();
    };
  }, [syncSettings, syncSettingsLoaded]);

  useEffect(() => {
    if (!syncSettingsLoaded) return;
    let disposed = false;
    let statusEventReceived = false;
    let disconnect: (() => void) | undefined;
    setSyncStatus(syncSettings.url ? "updating" : "not-connected");

    void (async () => {
      try {
        const cleanup = await taskClient.subscribeSyncStatus((status) => {
          if (disposed) return;
          statusEventReceived = true;
          setSyncStatus(status);
        });
        if (disposed) {
          cleanup();
          return;
        }
        disconnect = cleanup;
        const status = await taskClient.getSyncStatus();
        if (!disposed && !statusEventReceived) setSyncStatus(status);
      } catch {
        if (!disposed) setSyncStatus("not-connected");
      }
    })();

    return () => {
      disposed = true;
      disconnect?.();
    };
  }, [syncSettings, syncSettingsLoaded]);

  useEffect(() => {
    if (selectedTaskId && !selectedTask) selectTask(null);
  }, [selectedTask, selectedTaskId, selectTask]);

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, 4_500);
  }, []);

  const showShortcutTip = useCallback((action: TaskShortcutAction, label = shortcutLabels[action]) => {
    if (shortcutTipTimerRef.current) window.clearTimeout(shortcutTipTimerRef.current);
    setShortcutTip({ action, label });
    shortcutTipTimerRef.current = window.setTimeout(() => {
      shortcutTipTimerRef.current = null;
      setShortcutTip(null);
    }, 4_500);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    if (shortcutTipTimerRef.current) window.clearTimeout(shortcutTipTimerRef.current);
  }, []);

  useEffect(() => {
    const clearDraggedTask = () => setDraggedTaskId(null);
    window.addEventListener("dragend", clearDraggedTask);
    window.addEventListener("drop", clearDraggedTask, true);
    return () => {
      window.removeEventListener("dragend", clearDraggedTask);
      window.removeEventListener("drop", clearDraggedTask, true);
    };
  }, []);

  useEffect(() => {
    void taskClient
      .registerQuickEntryShortcut(toNativeShortcut(preferences.shortcuts.quickEntry))
      .then(() => {
        localStorage.removeItem(shortcutWarningKey);
        setShortcutWarning(null);
      })
      .catch(() => {
        const message = "The saved system-wide quick-entry shortcut is unavailable.";
        localStorage.setItem(shortcutWarningKey, message);
        setShortcutWarning(message);
      });
  }, []);

  const navigate = useCallback((next: View) => {
    if (next === "search" && view !== "search") searchReturnViewRef.current = view;
    setView(next);
    setComposerBucket(null);
    if (next === "search") window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [view]);

  const openComposer = useCallback((bucket?: Bucket) => {
    const defaultBucket = bucket ?? (view === "inbox" ? "inbox" : view === "today" || view === "home" ? "today" : "inbox");
    if (view === "search" || view === "logbook") setView(defaultBucket);
    setComposerBucket(defaultBucket);
  }, [view]);

  const openPalette = useCallback((mode: PaletteMode = "commands") => {
    setPaletteMode(mode);
    setPaletteOpen(true);
  }, []);

  const changeTheme = useCallback((themeId: ThemeId) => {
    setPreferences((current) => ({ ...current, themeId }));
    setPreviewTheme(themeId);
  }, []);

  const changeShortcut = useCallback(async (action: keyof AppPreferences["shortcuts"], shortcut: string) => {
    if (action === "quickEntry") {
      try {
        await taskClient.registerQuickEntryShortcut(toNativeShortcut(shortcut));
        localStorage.removeItem(shortcutWarningKey);
        setShortcutWarning(null);
      } catch (reason) {
        await taskClient.registerQuickEntryShortcut(toNativeShortcut(preferences.shortcuts.quickEntry)).catch(() => undefined);
        const message = reason instanceof Error ? reason.message : "That system-wide shortcut is unavailable.";
        localStorage.setItem(shortcutWarningKey, message);
        setShortcutWarning(message);
        return;
      }
    }
    setPreferences((current) => ({
      ...current,
      shortcuts: { ...current.shortcuts, [action]: shortcut },
    }));
  }, [preferences.shortcuts.quickEntry, showNotice]);

  const saveSyncSettings = useCallback(async (settings: SyncSettings) => {
    await taskClient.setSyncSettings(settings);
    setSyncSettings(settings);
    showNotice(settings.url ? "Supabase settings saved" : "Supabase settings cleared");
  }, [showNotice]);

  const exportTasks = useCallback(async () => {
    try {
      const result = await taskClient.exportTasks();
      if (result.path) {
        showNotice(`Exported to ${result.path}`);
        return;
      }
      if (!result.json) throw new Error("Export produced no data");
      const blob = new Blob([result.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `todou-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      showNotice("JSON export downloaded");
    } catch {
      showNotice("Export failed");
    }
  }, [showNotice]);

  const buildProductionApp = useCallback(async () => {
    if (!import.meta.env.DEV || !isTauriRuntime() || buildingInstaller) return;
    setBuildingInstaller(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<string>("dev_build_and_open_dmg");
      showNotice("DMG opened — drag Todou to Applications");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      showNotice(`Build failed: ${message}`);
    } finally {
      setBuildingInstaller(false);
    }
  }, [buildingInstaller, showNotice]);

  const completeTask = useCallback((id: string) => {
    void controller.completeTask(id);
    showShortcutTip("complete");
  }, [controller.completeTask, showShortcutTip]);

  const restoreTask = useCallback((id: string) => {
    void controller.restoreTask(id);
    showShortcutTip("complete", "Restore selected task");
  }, [controller.restoreTask, showShortcutTip]);

  const moveTask = useCallback((id: string, bucket: Bucket) => {
    const task = controller.tasks.find((candidate) => candidate.id === id);
    if (!task || task.bucket === bucket) return;
    void controller.moveTask(id, bucket);
    if (bucket === "today") showShortcutTip("moveToday");
    if (bucket === "inbox") showShortcutTip("moveInbox");
  }, [controller.moveTask, controller.tasks, showShortcutTip]);

  const deleteTask = useCallback((id: string) => {
    void controller.deleteTask(id);
    showShortcutTip("delete");
    if (selectedTaskId === id) selectTask(null);
  }, [controller.deleteTask, selectedTaskId, selectTask, showShortcutTip]);

  const reorderTask = useCallback((movingId: string, targetId: string, edge: "before" | "after") => {
    const anchors = reorderAnchors(controller.tasks, movingId, targetId, edge);
    if (!anchors) {
      showNotice("Reorder tasks within the same priority group");
      return;
    }
    void controller.reorderTask(movingId, anchors.beforeId, anchors.afterId);
  }, [controller.tasks, controller.reorderTask, showNotice]);

  const canDropTaskIntoBucket = useCallback((movingId: string, bucket: Bucket) => {
    const moving = controller.tasks.find(({ id, completedAt, deletedAt }) => id === movingId && !completedAt && !deletedAt);
    if (!moving) return false;
    return bucket !== "in_progress"
      || moving.bucket === bucket
      || inProgressTasks.length < inProgressTaskLimit;
  }, [controller.tasks, inProgressTasks.length]);

  const rejectTaskDrop = useCallback((bucket: Bucket) => {
    if (bucket === "in_progress") showNotice("In Progress is full — finish or move a task first");
  }, [showNotice]);

  const dropTaskOnRow = useCallback((movingId: string, targetId: string, edge: "before" | "after") => {
    const moving = controller.tasks.find(({ id, completedAt, deletedAt }) => id === movingId && !completedAt && !deletedAt);
    const target = controller.tasks.find(({ id, completedAt, deletedAt }) => id === targetId && !completedAt && !deletedAt);
    if (!moving || !target) return;
    if (moving.bucket !== target.bucket) {
      if (!canDropTaskIntoBucket(moving.id, target.bucket)) {
        rejectTaskDrop(target.bucket);
        return;
      }
      moveTask(moving.id, target.bucket);
      return;
    }
    reorderTask(moving.id, target.id, edge);
  }, [canDropTaskIntoBucket, controller.tasks, moveTask, rejectTaskDrop, reorderTask]);

  const dropTaskIntoBucket = useCallback((movingId: string, bucket: Bucket) => {
    const moving = controller.tasks.find(({ id, completedAt, deletedAt }) => id === movingId && !completedAt && !deletedAt);
    if (!moving || moving.bucket === bucket) return;
    if (!canDropTaskIntoBucket(moving.id, bucket)) {
      rejectTaskDrop(bucket);
      return;
    }
    moveTask(moving.id, bucket);
  }, [canDropTaskIntoBucket, controller.tasks, moveTask, rejectTaskDrop]);

  const togglePriority = useCallback((task: Task) => {
    void controller.updateTask(task.id, { priority: task.priority === "high" ? "low" : "high" });
    showShortcutTip("togglePriority");
  }, [controller.updateTask, showShortcutTip]);

  const toggleArea = useCallback((task: Task) => {
    void controller.updateTask(task.id, { area: task.area === "work" ? "personal" : "work" });
    showShortcutTip("toggleArea");
  }, [controller.updateTask, showShortcutTip]);

  const moveTaskAndSelectSourceNeighbor = useCallback((task: Task, bucket: Bucket) => {
    if (task.bucket === bucket) return;

    const sourceTasks = tasksForBucket(controller.tasks, task.bucket);
    const sourceIndex = sourceTasks.findIndex(({ id }) => id === task.id);
    if (sourceIndex < 0) {
      void controller.moveTask(task.id, bucket);
      return;
    }
    const neighborId = sourceTasks[sourceIndex + 1]?.id ?? sourceTasks[sourceIndex - 1]?.id ?? null;

    const selectionVersion = selectionVersionRef.current + 1;
    selectionVersionRef.current = selectionVersion;
    setSelectedTaskId(neighborId);
    void controller.moveTask(task.id, bucket).catch(() => {
      if (selectionVersionRef.current === selectionVersion) selectTask(task.id);
    });
  }, [controller.moveTask, controller.tasks, selectTask]);

  const visibleTasks = useMemo(() => {
    if (view === "today") return todayTasks;
    if (view === "inbox") return inboxTasks;
    if (view === "logbook") return logbookTasks;
    if (view === "search") return searchResults;
    return [...inProgressTasks, ...todayTasks, ...inboxTasks];
  }, [view, inProgressTasks, todayTasks, inboxTasks, logbookTasks, searchResults]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const isEditing = Boolean(target?.closest("input, select, textarea, [contenteditable]:not([contenteditable='false'])"));
      if (paletteOpen) return;
      if (event.key === "Escape" && view === "search") {
        event.preventDefault();
        navigate(searchReturnViewRef.current);
        return;
      }
      if (shortcutMatches(event, preferences.shortcuts.commandPalette)) {
        event.preventDefault();
        openPalette("commands");
        return;
      }
      if (shortcutMatches(event, preferences.shortcuts.search)) {
        event.preventDefault();
        navigate("search");
        return;
      }
      if (isEditing) return;
      const isUnmodifiedSpace = shortcutMatches(event, "Space");
      const canUseAmbientSpace = !selectedTask && !isInteractiveShortcutTarget(event.target);
      if (shortcutMatches(event, preferences.shortcuts.newTask)) {
        if (isUnmodifiedSpace && !canUseAmbientSpace) return;
        event.preventDefault();
        openComposer();
        return;
      }
      if (isUnmodifiedSpace && canUseAmbientSpace) {
        event.preventDefault();
        openComposer();
        return;
      }
      if (shortcutMatches(event, preferences.shortcuts.undo) && controller.undo) {
        event.preventDefault();
        void controller.runUndo();
        return;
      }
      if (selectedTask) {
        if (shortcutMatches(event, preferences.shortcuts.complete)) {
          event.preventDefault();
          if (selectedTask.completedAt) void controller.restoreTask(selectedTask.id);
          else void controller.completeTask(selectedTask.id);
          return;
        }
        if (shortcutMatches(event, preferences.shortcuts.moveToday)) {
          event.preventDefault();
          moveTaskAndSelectSourceNeighbor(selectedTask, "today");
          return;
        }
        if (shortcutMatches(event, preferences.shortcuts.moveInbox)) {
          event.preventDefault();
          moveTaskAndSelectSourceNeighbor(selectedTask, "inbox");
          return;
        }
        if (shortcutMatches(event, preferences.shortcuts.togglePriority)) {
          event.preventDefault();
          togglePriority(selectedTask);
          return;
        }
        if (shortcutMatches(event, preferences.shortcuts.toggleArea)) {
          event.preventDefault();
          void controller.updateTask(selectedTask.id, { area: selectedTask.area === "work" ? "personal" : "work" });
          return;
        }
        if (shortcutMatches(event, preferences.shortcuts.delete)) {
          event.preventDefault();
          deleteTask(selectedTask.id);
          return;
        }
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visibleTasks.length) {
        event.preventDefault();
        const currentIndex = visibleTasks.findIndex(({ id }) => id === selectedTaskId);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = currentIndex < 0 ? (delta > 0 ? 0 : visibleTasks.length - 1) : (currentIndex + delta + visibleTasks.length) % visibleTasks.length;
        selectTask(visibleTasks[nextIndex]?.id ?? null);
      }
      if (event.key === "Escape" && selectedTaskId) selectTask(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [preferences.shortcuts, paletteOpen, view, selectedTask, selectedTaskId, visibleTasks, controller, openComposer, openPalette, navigate, togglePriority, moveTaskAndSelectSourceNeighbor, deleteTask, selectTask]);

  const sectionProps = {
    selectedTaskId,
    onSelect: selectTask,
    onComplete: completeTask,
    onRestore: restoreTask,
    onMove: moveTask,
    onTogglePriority: togglePriority,
    onToggleArea: toggleArea,
    onDelete: deleteTask,
    onDropTask: dropTaskOnRow,
    onDropIntoBucket: dropTaskIntoBucket,
    canAcceptDrop: canDropTaskIntoBucket,
    onDropRejected: rejectTaskDrop,
    draggedTaskId,
    onTaskDragStart: (id: string) => setDraggedTaskId(id),
    onTaskDragEnd: () => setDraggedTaskId(null),
    shortcuts: preferences.shortcuts,
  };

  const composer = (bucket: Bucket) => composerBucket === bucket ? (
    <InlineComposer
      bucket={bucket}
      defaultArea={preferences.lastArea}
      onCreate={controller.createTask}
      onCreated={(task) => {
        setComposerBucket(null);
        selectTask(task.id);
        setPreferences((current) => ({ ...current, lastArea: task.area }));
      }}
      onCancel={() => setComposerBucket(null)}
    />
  ) : null;

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onViewChange={navigate}
        onNewTask={() => openComposer()}
        onOpenPalette={() => openPalette("commands")}
        onOpenThemes={() => openPalette("themes")}
        onDropTask={dropTaskIntoBucket}
        todayCount={todayTasks.length}
        inboxCount={inboxTasks.length}
        theme={themeById(previewTheme)}
        newTaskShortcut={preferences.shortcuts.newTask}
        commandPaletteShortcut={preferences.shortcuts.commandPalette}
        syncStatus={syncStatus}
      />

      <main className="workspace">
        <header className="workspace-topbar" data-tauri-drag-region>
          <div className="workspace-heading">
            <span className="workspace-heading-icon"><HeaderIcon size={16} /></span>
            <div><h1>{header.title}</h1>{header.subtitle && <p>{header.subtitle}</p>}</div>
          </div>
          <div className="workspace-actions">
            <button onClick={() => navigate("search")} title="Search" aria-label="Search"><Search size={15} /><KeyHint shortcut={preferences.shortcuts.search} /></button>
            <button onClick={() => openPalette("commands")} title="Commands" aria-label="Commands"><Command size={15} /></button>
            <button className="topbar-add" onClick={() => openComposer()} title="New task" aria-label="New task"><Plus size={15} /></button>
          </div>
        </header>

        <div className="workspace-scroll">
          {controller.loading ? (
            <div className="loading-list" aria-label="Loading tasks"><span /><span /><span /><span /></div>
          ) : view === "home" ? (
            <>
              <TaskSection title="In Progress" bucket="in_progress" maxTasks={inProgressTaskLimit} tasks={inProgressTasks} {...sectionProps} />
              <TaskSection title="Today" bucket="today" tasks={todayTasks} onAdd={() => openComposer("today")} {...sectionProps}>{composer("today")}</TaskSection>
              <TaskSection title="Inbox" bucket="inbox" tasks={inboxTasks} onAdd={() => openComposer("inbox")} {...sectionProps}>{composer("inbox")}</TaskSection>
            </>
          ) : view === "today" ? (
            <TaskSection title="Today" bucket="today" hideHeader tasks={todayTasks} onAdd={() => openComposer("today")} {...sectionProps}>{composer("today")}</TaskSection>
          ) : view === "inbox" ? (
            <TaskSection title="Inbox" bucket="inbox" hideHeader tasks={inboxTasks} onAdd={() => openComposer("inbox")} {...sectionProps}>{composer("inbox")}</TaskSection>
          ) : view === "logbook" ? (
            <FlatTaskList
              query={logbookQuery}
              onQueryChange={setLogbookQuery}
              placeholder="Search logbook"
              tasks={logbookTasks}
              {...sectionProps}
            />
          ) : (
            <FlatTaskList
              query={searchQuery}
              onQueryChange={setSearchQuery}
              inputRef={searchInputRef}
              placeholder="Search"
              tasks={searchResults}
              {...sectionProps}
            />
          )}
        </div>
      </main>

      {selectedTask ? (
        <TaskInspector
          task={selectedTask}
          onClose={() => selectTask(null)}
          onUpdate={(patch) => {
            if (patch.priority !== undefined) showShortcutTip("togglePriority");
            if (patch.area !== undefined) showShortcutTip("toggleArea");
            return controller.updateTask(selectedTask.id, patch);
          }}
          onMove={(bucket) => {
            if (!canDropTaskIntoBucket(selectedTask.id, bucket)) {
              rejectTaskDrop(bucket);
              return;
            }
            moveTask(selectedTask.id, bucket);
          }}
          inProgressFull={inProgressTasks.length >= inProgressTaskLimit}
          onComplete={() => completeTask(selectedTask.id)}
          onRestore={() => restoreTask(selectedTask.id)}
          onDelete={() => deleteTask(selectedTask.id)}
          completeShortcut={preferences.shortcuts.complete}
        />
      ) : <InspectorPlaceholder />}

      <CommandPalette
        open={paletteOpen}
        startMode={paletteMode}
        onOpenChange={setPaletteOpen}
        onNavigate={navigate}
        onNewTask={() => openComposer()}
        onExport={() => void exportTasks()}
        onOpenSettings={() => setSettingsOpen(true)}
        {...(import.meta.env.DEV && isTauriRuntime() ? { onBuildInstaller: () => void buildProductionApp() } : {})}
        selectedTask={selectedTask}
        canUndo={Boolean(controller.undo)}
        onCompleteSelected={() => { if (selectedTask) completeTask(selectedTask.id); }}
        onRestoreSelected={() => { if (selectedTask) restoreTask(selectedTask.id); }}
        onMoveSelected={(bucket) => { if (selectedTask) moveTask(selectedTask.id, bucket); }}
        onTogglePrioritySelected={() => { if (selectedTask) togglePriority(selectedTask); }}
        onToggleAreaSelected={() => { if (selectedTask) toggleArea(selectedTask); }}
        onDeleteSelected={() => { if (selectedTask) deleteTask(selectedTask.id); }}
        onUndo={() => void controller.runUndo()}
        committedTheme={preferences.themeId}
        onThemePreview={setPreviewTheme}
        onThemeCommit={changeTheme}
        shortcuts={preferences.shortcuts}
        onShortcutChange={(action, shortcut) => void changeShortcut(action, shortcut)}
      />

      <SyncSettingsDialog
        open={settingsOpen}
        settings={syncSettings}
        runtime={isTauriRuntime() ? "tauri" : "browser"}
        onOpenChange={setSettingsOpen}
        onSave={saveSyncSettings}
        onTestConnection={taskClient.testSyncConnection}
        onLoadDiagnostics={taskClient.getSyncDiagnostics}
      />

      {controller.undo && (
        <div className="undo-toast" role="status">
          <CheckCircle2 size={16} />
          <span>{controller.undo.label}</span>
          <button onClick={() => void controller.runUndo()}>Undo <KeyHint shortcut={preferences.shortcuts.undo} /></button>
          <span className="undo-timer" />
        </div>
      )}
      {shortcutTip && (
        <div className={`shortcut-tip-toast ${controller.undo ? "has-undo" : ""}`} role="status">
          <span>Next time, use</span>
          <KeyHint shortcut={preferences.shortcuts[shortcutTip.action]} />
          <span>to {shortcutTip.label.toLocaleLowerCase()}</span>
        </div>
      )}
      {notice && <div className="notice-toast" role="status">{notice}</div>}
      {buildingInstaller && (
        <div className="notice-toast dev-build-toast" role="status" aria-live="polite">
          <span className="dev-build-spinner" aria-hidden="true" />
          Building production app…
        </div>
      )}
      {shortcutWarning && (
        <div className="shortcut-warning-banner" role="alert">
          <span>{shortcutWarning}</span>
          <button onClick={() => openPalette("shortcuts")}>Edit shortcut</button>
          <button
            className="warning-dismiss"
            onClick={() => {
              localStorage.removeItem(shortcutWarningKey);
              setShortcutWarning(null);
            }}
            aria-label="Dismiss shortcut warning"
          >×</button>
        </div>
      )}
      {controller.error && <div className="error-banner" role="alert">{controller.error}<button onClick={() => void controller.reload()}>Retry</button></div>}
    </div>
  );
}
