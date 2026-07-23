import type { SyncStatus } from "../lib/syncSettings";

const labels: Record<SyncStatus, string> = {
  "up-to-date": "Up to date",
  updating: "Updating",
  "not-connected": "Not connected",
};

export function SyncStatusBar({ status }: { status: SyncStatus }) {
  const label = labels[status];
  return (
    <div
      className={`sync-status-bar is-${status}`}
      role="status"
      aria-label={`Supabase: ${label}`}
    >
      <span className="sync-status-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
