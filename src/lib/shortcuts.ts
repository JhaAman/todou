import type { ShortcutAction } from "./types";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export const defaultShortcuts: Record<ShortcutAction, string> = {
  newTask: "Meta+N",
  commandPalette: "Meta+K",
  search: "Meta+P",
  complete: "Meta+Enter",
  moveToday: "Meta+Shift+T",
  moveInbox: "Meta+Shift+I",
  togglePriority: "Meta+Shift+P",
  toggleArea: "Meta+Shift+A",
  delete: "Meta+Backspace",
  undo: "Meta+Z",
  quickEntry: "Ctrl+Shift+Space",
};

export const shortcutLabels: Record<ShortcutAction, string> = {
  quickEntry: "Quick entry (system-wide)",
  newTask: "New task",
  commandPalette: "Command palette",
  search: "Search tasks",
  complete: "Complete selected task",
  moveToday: "Move to Today",
  moveInbox: "Move to Inbox",
  togglePriority: "Toggle priority",
  toggleArea: "Toggle work / personal",
  delete: "Delete selected task",
  undo: "Undo last action",
};

const modifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];

const interactiveTargetSelector = [
  "a[href]",
  "button",
  "input",
  "select",
  "summary",
  "textarea",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='textbox']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split("+").filter(Boolean);
  const modifiers = parts
    .filter((part) => modifierOrder.includes(part))
    .sort((a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b));
  const key = parts.find((part) => !modifierOrder.includes(part));
  return [...modifiers, ...(key ? [key] : [])].join("+");
}

export function shortcutsEqual(first: string, second: string): boolean {
  return normalizeShortcut(first) === normalizeShortcut(second);
}

export function shortcutFromEvent(event: KeyboardEvent | ReactKeyboardEvent): string | null {
  const key = event.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return null;

  const parts = [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Meta",
  ].filter(Boolean) as string[];
  const normalizedKey = key === " " ? "Space" : key.length === 1 ? key.toLocaleUpperCase() : key;
  return [...parts.sort((a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b)), normalizedKey].join("+");
}

export function shortcutMatches(event: KeyboardEvent | ReactKeyboardEvent, shortcut: string): boolean {
  const eventShortcut = shortcutFromEvent(event);
  return eventShortcut !== null && eventShortcut === normalizeShortcut(shortcut);
}

export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(interactiveTargetSelector));
}

export function displayShortcut(shortcut: string): string {
  return shortcut
    .replaceAll("Meta", "⌘")
    .replaceAll("Ctrl", "⌃")
    .replaceAll("Alt", "⌥")
    .replaceAll("Shift", "⇧")
    .replaceAll("+", "");
}
