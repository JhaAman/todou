import { demoTasks } from "./demoData";
import type { WorkSessionSnapshot } from "../features/work-mode/workSession";
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
  type SyncStatus,
} from "./syncSettings";
import {
  taskDescriptionMaxLength,
  type CreateTaskInput,
  type EditableTaskPatch,
  type Task,
  type TaskFilter,
} from "./types";

export interface ExportResult {
  json?: string;
  path?: string;
}

export interface SystemActivitySample {
  idleMs: number | null;
  awakeTimeMs: number | null;
}

export function readErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  if (
    typeof reason === "object"
    && reason !== null
    && "message" in reason
    && typeof reason.message === "string"
    && reason.message.trim()
  ) {
    return reason.message;
  }
  return fallback;
}

export type ProviderCredentialSource = "saved" | "environment" | null;

export interface ProviderCredentialStatus {
  configured: boolean;
  source: ProviderCredentialSource;
}

export interface LlmSettingsStatus {
  openai: ProviderCredentialStatus;
  anthropic: ProviderCredentialStatus;
  pendingJobs: number;
  failedJobs: number;
}

export type ManualDedupeScanStatus =
  | "completed"
  | "alreadyRunning"
  | "configurationRequired"
  | "failed";

export interface ManualDedupeScanOutcome {
  status: ManualDedupeScanStatus;
}

export interface SaveLlmSettingsInput {
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
}

export interface MergedTaskDraft {
  title: string;
  description: string;
  bucket: Task["bucket"];
  priority: Task["priority"];
  area: Task["area"];
  dueDate: string | null;
  estimateMinutes: number | null;
}

export interface DedupeSuggestion {
  id: string;
  createdAt: string;
  newTask: Task;
  existingTask: Task;
  mergedTask: MergedTaskDraft;
}

export type DedupeResolutionAction = "deleteNew" | "deleteExisting" | "merge";

export interface DedupeResolutionOutcome {
  status: "resolved" | "stale";
  revision: number;
  survivor: Task | null;
  deletedTaskId: string | null;
  syncRequired: boolean;
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
  getSyncStatus(): Promise<SyncStatus>;
  subscribeSyncStatus(listener: (status: SyncStatus) => void): Promise<() => void>;
  registerQuickEntryShortcut(shortcut: string): Promise<void>;
  subscribe(listener: () => void): Promise<() => void>;
  getLlmSettings(): Promise<LlmSettingsStatus>;
  saveLlmSettings(input: SaveLlmSettingsInput): Promise<LlmSettingsStatus>;
  listDedupeSuggestions(): Promise<DedupeSuggestion[]>;
  dismissDedupeSuggestion(id: string): Promise<void>;
  resolveDedupeSuggestion(
    id: string,
    action: DedupeResolutionAction,
  ): Promise<DedupeResolutionOutcome>;
  processPendingDedupe(): Promise<void>;
  runDedupeScan(): Promise<ManualDedupeScanOutcome>;
  subscribeDedupeSuggestions(listener: () => void): Promise<() => void>;
  subscribeLlmCredentialsRequired(listener: () => void): Promise<() => void>;
  hideCurrentWindow(): Promise<void>;
  startWorkMode(): Promise<WorkSessionSnapshot>;
  loadWorkModeSession(): Promise<WorkSessionSnapshot | null>;
  checkpointWorkModeSession(session: WorkSessionSnapshot): Promise<WorkSessionSnapshot>;
  subscribeWorkModeSession(
    listener: (session: WorkSessionSnapshot | null) => void,
  ): Promise<() => void>;
  getSystemActivitySample(): Promise<SystemActivitySample>;
  stopWorkMode(): Promise<void>;
}

const browserStoreKey = "todou.browser.tasks.v1";
const browserSeedKey = "todou.browser.seeded.v1";
const browserEvent = "todou:browser-tasks-changed";
const browserSyncSettingsKey = "todou.browser.sync-settings.v1";
const inProgressTaskLimit = 3;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function localDateString(): string {
  const date = new Date();
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

function normalizeBrowserDescription(value: string): string {
  const description = value.trim();
  if (Array.from(description).length > taskDescriptionMaxLength) {
    throw new Error(`Description must contain at most ${taskDescriptionMaxLength} characters`);
  }
  return description;
}

function readBrowserTasks(): Task[] {
  try {
    const existing = localStorage.getItem(browserStoreKey);
    if (existing) {
      return (JSON.parse(existing) as Task[]).map((task) => ({
        ...task,
        description: typeof task.description === "string" ? task.description : "",
      }));
    }
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

function ensureInProgressCapacity(tasks: Task[], excludeId?: string): void {
  const active = tasks.filter((task) => (
    task.id !== excludeId
    && task.bucket === "in_progress"
    && !task.completedAt
    && !task.deletedAt
  ));
  if (active.length >= inProgressTaskLimit) {
    throw new Error("In Progress can only contain three active tasks");
  }
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
      let bucket = input.bucket ?? "inbox";
      if (dueToday && bucket === "inbox") bucket = "today";
      if (bucket === "in_progress") ensureInProgressCapacity(tasks);
      const priority = input.priority ?? "low";
      const task: Task = {
        id: crypto.randomUUID(),
        title: input.title.trim(),
        description: "",
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
      const description = patch.description === undefined
        ? undefined
        : normalizeBrowserDescription(patch.description);
      const next = {
        ...current,
        ...patch,
        ...(description === undefined ? {} : { description }),
        updatedAt: new Date().toISOString(),
      };
      if (patch.dueDate && patch.dueDate <= localDateString() && current.bucket === "inbox") next.bucket = "today";
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
      if (bucket === "in_progress" && current.bucket !== bucket) {
        ensureInProgressCapacity(tasks, current.id);
      }
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
      if (current.bucket === "in_progress") ensureInProgressCapacity(tasks, current.id);
      const dueToday = Boolean(current.dueDate && current.dueDate <= localDateString());
      const next = {
        ...current,
        completedAt: null,
        bucket: dueToday && current.bucket === "inbox" ? "today" as const : current.bucket,
        updatedAt: new Date().toISOString(),
      };
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
      if (current.bucket === "in_progress") ensureInProgressCapacity(tasks, current.id);
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
    async getSyncStatus() {
      return "not-connected";
    },
    async subscribeSyncStatus(listener) {
      listener("not-connected");
      return () => undefined;
    },
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
    async getLlmSettings() {
      return {
        openai: { configured: false, source: null },
        anthropic: { configured: false, source: null },
        pendingJobs: 0,
        failedJobs: 0,
      };
    },
    async saveLlmSettings() {
      throw new Error("AI task de-duplication is available in the desktop app.");
    },
    async listDedupeSuggestions() {
      return [];
    },
    async dismissDedupeSuggestion() {},
    async resolveDedupeSuggestion() {
      return {
        status: "resolved",
        revision: 0,
        survivor: null,
        deletedTaskId: null,
        syncRequired: false,
      };
    },
    async processPendingDedupe() {},
    async runDedupeScan() {
      throw new Error("AI task de-duplication is available in the desktop app.");
    },
    async subscribeDedupeSuggestions() {
      return () => undefined;
    },
    async subscribeLlmCredentialsRequired() {
      return () => undefined;
    },
    async hideCurrentWindow() {
      window.blur();
    },
    async startWorkMode() {
      throw new Error("Work mode is available in the Todou desktop app.");
    },
    async loadWorkModeSession() {
      return null;
    },
    async checkpointWorkModeSession(session) {
      return session;
    },
    async subscribeWorkModeSession() {
      return () => undefined;
    },
    async getSystemActivitySample() {
      return { idleMs: null, awakeTimeMs: null };
    },
    async stopWorkMode() {},
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
    getSyncStatus: () => invoke<SyncStatus>("sync_status"),
    async subscribeSyncStatus(listener) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<SyncStatus>("todou://sync-status", (event) => listener(event.payload));
    },
    async registerQuickEntryShortcut(shortcut) {
      await invoke<void>("register_quick_entry_shortcut", { accelerator: shortcut });
    },
    async subscribe(listener) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen("todou://tasks-changed", listener);
    },
    getLlmSettings: () => invokeResult<LlmSettingsStatus>("get_llm_settings"),
    saveLlmSettings: (input) => invokeResult<LlmSettingsStatus>("save_llm_settings", { input }),
    listDedupeSuggestions: () => invokeResult<DedupeSuggestion[]>("list_dedupe_suggestions"),
    async dismissDedupeSuggestion(id) {
      await invokeResult<unknown>("dismiss_dedupe_suggestion", { id });
    },
    async resolveDedupeSuggestion(id, action) {
      return invokeResult<DedupeResolutionOutcome>("resolve_dedupe_suggestion", { id, action });
    },
    async processPendingDedupe() {
      await invokeResult<unknown>("process_pending_dedupe");
    },
    runDedupeScan: () => invokeResult<ManualDedupeScanOutcome>("run_dedupe_scan"),
    async subscribeDedupeSuggestions(listener) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen("todou://dedupe-suggestions-changed", listener);
    },
    async subscribeLlmCredentialsRequired(listener) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen("todou://llm-credentials-required", listener);
    },
    async hideCurrentWindow() {
      await invoke<void>("hide_quick_entry");
    },
    startWorkMode: () => invokeResult<WorkSessionSnapshot>("start_work_mode"),
    loadWorkModeSession: () => invokeResult<WorkSessionSnapshot | null>("load_work_mode_session"),
    checkpointWorkModeSession: (session) => invokeResult<WorkSessionSnapshot>("checkpoint_work_mode_session", { session }),
    async subscribeWorkModeSession(listener) {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<WorkSessionSnapshot | null>("todou://work-mode-session-changed", (event) => listener(event.payload));
    },
    getSystemActivitySample: () => invoke<SystemActivitySample>("get_system_activity_sample"),
    async stopWorkMode() {
      await invoke<void>("stop_work_mode");
    },
  };
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export const taskClient: TaskClient = isTauriRuntime() ? tauriClient() : browserClient();

export type WindowKind = "main" | "quick-entry" | "work-mode";

export async function resolveWindowKind(): Promise<WindowKind> {
  const params = new URLSearchParams(window.location.search);
  if (params.get("window") === "quick-entry" || params.has("quick-entry")) return "quick-entry";
  if (params.get("window") === "work-mode") return "work-mode";
  if (!isTauriRuntime()) return "main";
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const label = getCurrentWindow().label;
    if (label.includes("quick")) return "quick-entry";
    if (label.includes("work")) return "work-mode";
    return "main";
  } catch {
    return "main";
  }
}
