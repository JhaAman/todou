import { demoTasks } from "./demoData";
import { loadPreferences } from "./preferences";
import { compareTasks } from "./taskOrdering";
import {
  checkSupabaseConnection,
  emptySyncSettings,
  environmentSyncSettings,
  type NativeSyncDiagnostics,
  type SyncConnectionCheck,
  type SyncDiagnostics,
  type SyncSettings,
} from "./syncSettings";
import type { CreateTaskInput, EditableTaskPatch, Task, TaskFilter } from "./types";

export interface ExportResult {
  json?: string;
  path?: string;
}

export interface TaskClient {
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(id: string, patch: EditableTaskPatch): Promise<Task>;
  moveTask(id: string, bucket: Task["bucket"]): Promise<Task>;
  reorderTask(id: string, beforeId?: string, afterId?: string): Promise<Task[]>;
  completeTask(id: string): Promise<Task>;
  restoreTask(id: string): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  undoDelete(id: string): Promise<Task>;
  exportTasks(): Promise<ExportResult>;
  getSyncSettings(): Promise<SyncSettings>;
  setSyncSettings(settings: SyncSettings): Promise<void>;
  testSyncConnection(settings: SyncSettings): Promise<SyncConnectionCheck>;
  getSyncDiagnostics(): Promise<SyncDiagnostics>;
  wakeSync(): Promise<void>;
  registerQuickEntryShortcut(shortcut: string): Promise<void>;
  subscribe(listener: () => void): Promise<() => void>;
  hideCurrentWindow(): Promise<void>;
}

const browserStoreKey = "todou.browser.tasks.v1";
const browserSeedKey = "todou.browser.seeded.v1";
const browserEvent = "todou:browser-tasks-changed";
const browserSyncSettingsKey = "todou.browser.sync-settings.v1";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function localDateString(): string {
  const date = new Date();
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

function readBrowserTasks(): Task[] {
  try {
    const existing = localStorage.getItem(browserStoreKey);
    if (existing) return JSON.parse(existing) as Task[];
    if (!localStorage.getItem(browserSeedKey)) {
      const seeded = demoTasks();
      localStorage.setItem(browserSeedKey, "true");
      localStorage.setItem(browserStoreKey, JSON.stringify(seeded));
      return seeded;
    }
  } catch {
    return demoTasks();
  }
  return [];
}

function writeBrowserTasks(tasks: Task[]): void {
  localStorage.setItem(browserStoreKey, JSON.stringify(tasks));
  window.dispatchEvent(new CustomEvent(browserEvent));
}

function nextOrderKey(tasks: Task[], bucket: Task["bucket"], priority: Task["priority"]): string {
  const last = tasks
    .filter((task) => task.bucket === bucket && task.priority === priority && !task.deletedAt && !task.completedAt)
    .sort(compareTasks)
    .at(-1);
  const numeric = Number(last?.orderKey ?? "0");
  return Number.isFinite(numeric) ? `${numeric + 1}`.padStart(6, "0") : `${Date.now()}`;
}

function applyFilter(tasks: Task[], filter: TaskFilter = {}): Task[] {
  return tasks.filter((task) => {
    if (filter.bucket && task.bucket !== filter.bucket) return false;
    if (filter.priority && task.priority !== filter.priority) return false;
    if (filter.area && task.area !== filter.area) return false;
    if (filter.completed !== undefined && Boolean(task.completedAt) !== filter.completed) return false;
    if (filter.query && !task.title.toLocaleLowerCase().includes(filter.query.toLocaleLowerCase())) return false;
    return true;
  });
}

function browserClient(): TaskClient {
  return {
    async listTasks(filter) {
      return clone(applyFilter(readBrowserTasks(), filter));
    },
    async createTask(input) {
      const tasks = readBrowserTasks();
      const now = new Date().toISOString();
      const dueToday = Boolean(input.dueDate && input.dueDate <= localDateString());
      const bucket = dueToday ? "today" : (input.bucket ?? "inbox");
      const priority = input.priority ?? "low";
      const task: Task = {
        id: crypto.randomUUID(),
        title: input.title.trim(),
        bucket,
        priority,
        area: input.area ?? "work",
        dueDate: input.dueDate ?? null,
        estimateMinutes: input.estimateMinutes ?? null,
        orderKey: nextOrderKey(tasks, bucket, priority),
        completedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      writeBrowserTasks([...tasks, task]);
      return clone(task);
    },
    async updateTask(id, patch) {
      const tasks = readBrowserTasks();
      const current = tasks.find((task) => task.id === id);
      if (!current) throw new Error("Task not found");
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      if (patch.dueDate && patch.dueDate <= localDateString()) next.bucket = "today";
      if (patch.priority && patch.priority !== current.priority) {
        next.orderKey = nextOrderKey(tasks, next.bucket, patch.priority);
      }
      writeBrowserTasks(tasks.map((task) => (task.id === id ? next : task)));
      return clone(next);
    },
    async moveTask(id, bucket) {
      const tasks = readBrowserTasks();
      const current = tasks.find((task) => task.id === id);
      if (!current) throw new Error("Task not found");
      const next: Task = {
        ...current,
        bucket,
        dueDate: bucket === "inbox" ? null : current.dueDate,
        orderKey: nextOrderKey(tasks, bucket, current.priority),
        updatedAt: new Date().toISOString(),
      };
      writeBrowserTasks(tasks.map((task) => (task.id === id ? next : task)));
      return clone(next);
    },
    async reorderTask(id, beforeId, afterId) {
      const tasks = readBrowserTasks();
      const moving = tasks.find((task) => task.id === id);
      if (!moving) throw new Error("Task not found");
      const tier = tasks
        .filter((task) => task.bucket === moving.bucket && task.priority === moving.priority && !task.completedAt && !task.deletedAt && task.id !== id)
        .sort(compareTasks);
      const targetId = beforeId ?? afterId;
      const targetIndex = targetId ? tier.findIndex((task) => task.id === targetId) : tier.length;
      const insertAt = beforeId ? Math.max(0, targetIndex) : Math.max(0, targetIndex + (afterId ? 1 : 0));
      tier.splice(insertAt, 0, moving);
      const keys = new Map(tier.map((task, index) => [task.id, `${index + 1}`.padStart(6, "0")]));
      const updated = tasks.map((task) => keys.has(task.id) ? { ...task, orderKey: keys.get(task.id)!, updatedAt: new Date().toISOString() } : task);
      writeBrowserTasks(updated);
      return clone(updated.filter((task) => keys.has(task.id)));
    },
    async completeTask(id) {
      const tasks = readBrowserTasks();
      const current = tasks.find((task) => task.id === id);
      if (!current) throw new Error("Task not found");
      const next = { ...current, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      writeBrowserTasks(tasks.map((task) => task.id === id ? next : task));
      return clone(next);
    },
    async restoreTask(id) {
      const tasks = readBrowserTasks();
      const current = tasks.find((task) => task.id === id);
      if (!current) throw new Error("Task not found");
      const dueToday = Boolean(current.dueDate && current.dueDate <= localDateString());
      const next = { ...current, completedAt: null, bucket: dueToday ? "today" as const : current.bucket, updatedAt: new Date().toISOString() };
      writeBrowserTasks(tasks.map((task) => task.id === id ? next : task));
      return clone(next);
    },
    async deleteTask(id) {
      const tasks = readBrowserTasks();
      const now = new Date().toISOString();
      writeBrowserTasks(tasks.map((task) => task.id === id ? { ...task, deletedAt: now, updatedAt: now } : task));
    },
    async undoDelete(id) {
      const tasks = readBrowserTasks();
      const current = tasks.find((task) => task.id === id);
      if (!current) throw new Error("Task not found");
      const next = { ...current, deletedAt: null, updatedAt: new Date().toISOString() };
      writeBrowserTasks(tasks.map((task) => task.id === id ? next : task));
      return clone(next);
    },
    async exportTasks() {
      return {
        json: JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), tasks: readBrowserTasks().filter((task) => !task.deletedAt), preferences: loadPreferences() }, null, 2),
      };
    },
    async getSyncSettings() {
      try {
        const stored = localStorage.getItem(browserSyncSettingsKey);
        return stored ? JSON.parse(stored) as SyncSettings : environmentSyncSettings();
      } catch {
        return emptySyncSettings;
      }
    },
    async setSyncSettings(settings) {
      localStorage.setItem(browserSyncSettingsKey, JSON.stringify(settings));
    },
    testSyncConnection: checkSupabaseConnection,
    async getSyncDiagnostics() {
      return { runtime: "browser", syncAvailable: false };
    },
    async wakeSync() {},
    async registerQuickEntryShortcut() {},
    async subscribe(listener) {
      const localListener = () => listener();
      const storageListener = (event: StorageEvent) => {
        if (event.key === browserStoreKey) listener();
      };
      window.addEventListener(browserEvent, localListener);
      window.addEventListener("storage", storageListener);
      return () => {
        window.removeEventListener(browserEvent, localListener);
        window.removeEventListener("storage", storageListener);
      };
    },
    async hideCurrentWindow() {
      window.blur();
    },
  };
}

function tauriClient(): TaskClient {
  interface Revisioned<T> {
    result: T;
    revision: number;
  }

  async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const api = await import("@tauri-apps/api/core");
    return api.invoke<T>(command, args);
  }

  async function invokeResult<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const value = await invoke<T | Revisioned<T>>(command, args);
    if (
      typeof value === "object"
      && value !== null
      && "result" in value
      && "revision" in value
    ) {
      return (value as Revisioned<T>).result;
    }
    return value;
  }

  return {
    listTasks: (filter = {}) => invokeResult<Task[]>("list_tasks", { filter }),
    createTask: (input) => invokeResult<Task>("create_task", { input }),
    updateTask: (id, patch) => invokeResult<Task>("update_task", { id, patch }),
    moveTask: (id, bucket) => invokeResult<Task>("move_task", { id, bucket }),
    reorderTask: (id, beforeId, afterId) => invokeResult<Task[]>("reorder_task", { id, beforeId, afterId }),
    completeTask: (id) => invokeResult<Task>("complete_task", { id }),
    restoreTask: (id) => invokeResult<Task>("restore_task", { id }),
    deleteTask: async (id) => { await invokeResult<null>("delete_task", { id }); },
    undoDelete: (id) => invokeResult<Task>("undo_delete", { id }),
    async exportTasks() {
      return {
        path: await invokeResult<string>("export_tasks_to_file", { uiPreferences: loadPreferences() }),
      };
    },
    async getSyncSettings() {
      const values = await invokeResult<Record<string, unknown>>("get_preferences");
      const fromEnvironment = environmentSyncSettings();
      return {
        url: typeof values.supabaseUrl === "string" ? values.supabaseUrl : fromEnvironment.url,
        publishableKey: typeof values.supabasePublishableKey === "string"
          ? values.supabasePublishableKey
          : fromEnvironment.publishableKey,
      };
    },
    async setSyncSettings(settings) {
      await invokeResult<unknown>("set_sync_settings", {
        url: settings.url,
        publishableKey: settings.publishableKey,
      });
    },
    testSyncConnection: checkSupabaseConnection,
    async getSyncDiagnostics() {
      const diagnostics = await invokeResult<Omit<NativeSyncDiagnostics, "runtime" | "syncAvailable">>("sync_diagnostics");
      return { ...diagnostics, runtime: "tauri", syncAvailable: true };
    },
    async wakeSync() {
      await invoke<number>("wake_sync");
    },
    async registerQuickEntryShortcut(shortcut) {
      await invoke<void>("register_quick_entry_shortcut", { accelerator: shortcut });
    },
    async subscribe(listener) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen("todou://tasks-changed", listener);
    },
    async hideCurrentWindow() {
      await invoke<void>("hide_quick_entry");
    },
  };
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export const taskClient: TaskClient = isTauriRuntime() ? tauriClient() : browserClient();

export async function resolveWindowKind(): Promise<"main" | "quick-entry"> {
  const params = new URLSearchParams(window.location.search);
  if (params.get("window") === "quick-entry" || params.has("quick-entry")) return "quick-entry";
  if (!isTauriRuntime()) return "main";
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label.includes("quick") ? "quick-entry" : "main";
  } catch {
    return "main";
  }
}
