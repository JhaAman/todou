import { Popover } from "@base-ui/react/popover";
import { useEffect, useState } from "react";
import type { SyncDiagnostics, SyncStatus } from "../lib/syncSettings";

const labels: Record<SyncStatus, string> = {
  "up-to-date": "Up to date",
  updating: "Updating",
  "not-connected": "Not connected",
};

interface SyncStatusBarProps {
  status: SyncStatus;
  configured: boolean;
  runtime: "browser" | "tauri";
  onLoadDiagnostics: () => Promise<SyncDiagnostics>;
  onCheckAgain: () => Promise<void>;
  onOpenSettings: () => void;
}

function statusDescription(
  status: SyncStatus,
  configured: boolean,
  runtime: "browser" | "tauri",
  diagnostics: SyncDiagnostics | null,
): string {
  if (runtime === "browser") return "Sync only runs in the desktop app.";
  if (!configured) return "Supabase isn’t set up on this Mac.";
  if (status === "updating") return "Todou is sending updates and checking for changes.";
  if (status === "up-to-date") return "The latest connection check succeeded.";
  if (diagnostics?.runtime === "tauri" && diagnostics.lastError) {
    return "Todou couldn’t finish the latest sync.";
  }
  return "Todou can’t connect to Supabase right now.";
}

function formattedSyncTime(value: string): { iso: string; label: string } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}

export function SyncStatusBar({
  status,
  configured,
  runtime,
  onLoadDiagnostics,
  onCheckAgain,
  onOpenSettings,
}: SyncStatusBarProps) {
  const [open, setOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkState, setCheckState] = useState<"idle" | "requesting" | "requested">("idle");
  const nativeDiagnostics = diagnostics?.runtime === "tauri" ? diagnostics : null;
  const lastSuccess = nativeDiagnostics?.lastSuccessfulSync
    ? formattedSyncTime(nativeDiagnostics.lastSuccessfulSync)
    : null;
  const label = labels[status];

  useEffect(() => {
    if (!open) {
      setCheckState("idle");
      setActionError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void onLoadDiagnostics()
      .then((value) => {
        if (!cancelled) setDiagnostics(value);
      })
      .catch((reason) => {
        if (!cancelled) {
          setDiagnostics(null);
          setLoadError(reason instanceof Error ? reason.message : "Unknown diagnostic error");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, status, onLoadDiagnostics]);

  const checkAgain = async () => {
    setCheckState("requesting");
    setActionError(null);
    try {
      await onCheckAgain();
      setCheckState("requested");
    } catch (reason) {
      setCheckState("idle");
      setActionError(reason instanceof Error ? reason.message : "Unknown request error");
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={`sync-status-bar is-${status}`}
        aria-label={`Supabase: ${label}`}
        title="View Supabase sync details"
      >
        <span className="sync-status-dot" aria-hidden="true" />
        <span aria-live="polite">{label}</span>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner className="sync-status-positioner" positionMethod="fixed" side="right" align="end" sideOffset={8}>
          <Popover.Popup className="sync-status-popover">
            <div className={`sync-status-summary is-${status}`}>
              <span className="sync-status-dot" aria-hidden="true" />
              <div>
                <Popover.Title>Supabase sync</Popover.Title>
                <Popover.Description>
                  {statusDescription(status, configured, runtime, diagnostics)}
                </Popover.Description>
              </div>
            </div>

            {loading && <p className="sync-diagnostics-note">Loading sync details…</p>}
            {!loading && loadError && (
              <div className="sync-diagnostics-error" role="alert">
                <strong>Couldn’t load sync details.</strong>
                <span>{loadError}</span>
              </div>
            )}
            {actionError && (
              <div className="sync-diagnostics-error" role="alert">
                <strong>Couldn’t request a new check.</strong>
                <span>{actionError}</span>
              </div>
            )}
            {!loading && nativeDiagnostics && (
              <>
                {nativeDiagnostics.lastError && (
                  <div className="sync-diagnostics-error">
                    <strong>Latest issue</strong>
                    <span>{nativeDiagnostics.lastError}</span>
                  </div>
                )}
                {nativeDiagnostics.quarantinedOutbox > 0 && (
                  <p className="sync-diagnostics-warning">
                    {nativeDiagnostics.quarantinedOutbox} {nativeDiagnostics.quarantinedOutbox === 1 ? "update needs" : "updates need"} attention
                  </p>
                )}
                <dl className="sync-diagnostics-grid">
                  <div>
                    <dt>Last successful sync</dt>
                    <dd>
                      {lastSuccess
                        ? <time role="time" dateTime={lastSuccess.iso}>{lastSuccess.label}</time>
                        : nativeDiagnostics.lastSuccessfulSync
                          ? "Unavailable"
                          : "Never"}
                    </dd>
                  </div>
                  <div>
                    <dt>Updates waiting</dt>
                    <dd>{nativeDiagnostics.pendingOutbox}</dd>
                  </div>
                </dl>
                <details className="sync-technical-details">
                  <summary>Technical details</summary>
                  <p>
                    Cursor{" "}
                    <code>
                      {nativeDiagnostics.cursor.epoch
                        ? `${nativeDiagnostics.cursor.epoch} · ${nativeDiagnostics.cursor.sequence}`
                        : `Not established · ${nativeDiagnostics.cursor.sequence}`}
                    </code>
                  </p>
                </details>
              </>
            )}

            <div className="sync-status-actions">
              {runtime === "tauri" && configured && status === "not-connected" && (
                <button type="button" onClick={() => void checkAgain()} disabled={checkState !== "idle"}>
                  {checkState === "requesting"
                    ? "Requesting…"
                    : checkState === "requested"
                      ? "Check requested"
                      : "Check again"}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                Connection settings
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
