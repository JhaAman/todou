export type Bucket = "today" | "inbox";
export type Priority = "high" | "low";
export type Area = "personal" | "work";

export interface Task {
  id: string;
  title: string;
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
  Pick<Task, "title" | "priority" | "area" | "dueDate" | "estimateMinutes">
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
  | "moveToday"
  | "moveInbox"
  | "togglePriority"
  | "toggleArea"
  | "delete"
  | "undo"
  | "quickEntry";

export type ThemeId =
  | "superhuman"
  | "catppuccin"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "gruvbox"
  | "one-dark"
  | "solarized";

export interface UndoAction {
  id: string;
  label: string;
  run: () => Promise<void>;
}
