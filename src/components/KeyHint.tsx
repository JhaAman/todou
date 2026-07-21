import { displayShortcut } from "../lib/shortcuts";

export function KeyHint({ shortcut, className = "" }: { shortcut: string; className?: string }) {
  return <kbd className={`key-hint ${className}`}>{displayShortcut(shortcut)}</kbd>;
}
