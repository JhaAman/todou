import type { OpenCodeThemeFamilyId, OpenCodeThemeMode } from "./opencodeThemePalettes";

export type Bucket = "in_progress" | "today" | "inbox";
export type Priority = "high" | "low";
export type Area = "personal" | "work";
export const taskDescriptionMaxLength = 10_000;

export interface Task {
  id: string;
  title: string;
  description: string;
  bucket: Bucket;
  priority: Priority;
  area: Area;
  dueDate: string | null;
  estimateMinutes: number | null;
  orderKey: string;
  completedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  bucket?: Bucket;
  priority?: Priority;
  area?: Area;
  dueDate?: string | null;
  estimateMinutes?: number | null;
}

export type EditableTaskPatch = Partial<
  Pick<Task, "title" | "description" | "priority" | "area" | "dueDate" | "estimateMinutes">
>;

export type TaskFilter = {
  bucket?: Bucket;
  priority?: Priority;
  area?: Area;
  completed?: boolean;
  query?: string;
};

export type View = "home" | "today" | "inbox" | "logbook" | "search";

export interface AppPreferences {
  themeId: ThemeId;
  lastArea: Area;
  shortcuts: Record<ShortcutAction, string>;
}

export type ShortcutAction =
  | "newTask"
  | "commandPalette"
  | "search"
  | "complete"
  | "moveInProgress"
  | "moveToday"
  | "moveInbox"
  | "togglePriority"
  | "toggleArea"
  | "delete"
  | "undo"
  | "quickEntry";

export type ThemeId =
  | "superhuman"
  | `graphite-${OpenCodeThemeMode}`
  | `${OpenCodeThemeFamilyId}-${OpenCodeThemeMode}`;

export interface UndoAction {
  id: string;
  label: string;
  run: () => Promise<void>;
}
