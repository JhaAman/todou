import { Dialog } from "@base-ui/react/dialog";
import { Database, KeyRound, Link2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  normalizeSyncSettings,
  type SyncConnectionCheck,
  type SyncDiagnostics,
  type SyncSettings,
} from "../../lib/syncSettings";

interface SyncSettingsDialogProps {
  open: boolean;
  settings: SyncSettings;
  runtime: "browser" | "tauri";
  onOpenChange: (open: boolean) => void;
  onSave: (settings: SyncSettings) => Promise<void>;
  onTestConnection: (settings: SyncSettings) => Promise<SyncConnectionCheck>;
  onLoadDiagnostics: () => Promise<SyncDiagnostics>;
}

export function SyncSettingsDialog({
  open,
  settings,
  runtime,
  onOpenChange,
  onSave,
  onTestConnection,
  onLoadDiagnostics,
}: SyncSettingsDialogProps) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [connectionCheck, setConnectionCheck] = useState<SyncConnectionCheck | null>(null);
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const connectionTestGeneration = useRef(0);
  const nativeDiagnostics = diagnostics?.runtime === "tauri" ? diagnostics : null;
  const hasSyncIssue = Boolean(nativeDiagnostics?.lastError) || Boolean(nativeDiagnostics?.quarantinedOutbox);
  const syncHealth = hasSyncIssue
    ? "Sync issue"
    : nativeDiagnostics?.lastSuccessfulSync
      ? "Last sync succeeded"
      : "Not synced yet";

  useEffect(() => {
    connectionTestGeneration.current += 1;
    setTesting(false);
    if (!open) return;
    setDraft(settings);
    setError(null);
    setTestError(null);
    setConnectionCheck(null);
    setDiagnostics(null);
    setDiagnosticsError(null);
    if (runtime !== "tauri") return;
    let cancelled = false;
    setDiagnosticsLoading(true);
    void onLoadDiagnostics()
      .then((value) => {
        if (!cancelled) setDiagnostics(value);
      })
      .catch((reason) => {
        if (!cancelled) setDiagnosticsError(reason instanceof Error ? reason.message : "Could not load sync status.");
      })
      .finally(() => {
        if (!cancelled) setDiagnosticsLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, settings, runtime, onLoadDiagnostics]);

  const updateDraft = (next: SyncSettings) => {
    connectionTestGeneration.current += 1;
    setDraft(next);
    setTesting(false);
    setConnectionCheck(null);
    setTestError(null);
  };

  const testConnection = async () => {
    const generation = connectionTestGeneration.current + 1;
    connectionTestGeneration.current = generation;
    try {
      const normalized = normalizeSyncSettings(draft);
      setTesting(true);
      setTestError(null);
      setConnectionCheck(null);
      const result = await onTestConnection(normalized);
      if (connectionTestGeneration.current === generation) setConnectionCheck(result);
    } catch (reason) {
      if (connectionTestGeneration.current === generation) {
        setTestError(reason instanceof Error ? reason.message : "Could not test the Supabase connection.");
      }
    } finally {
      if (connectionTestGeneration.current === generation) setTesting(false);
    }
  };

  const save = async () => {
    try {
      const normalized = normalizeSyncSettings(draft);
      setSaving(true);
      setError(null);
      await onSave(normalized);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save connection settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-backdrop" />
        <Dialog.Viewport className="settings-viewport">
          <Dialog.Popup className="settings-dialog">
            <header className="settings-header">
              <span className="settings-icon"><Database size={17} /></span>
              <div>
                <Dialog.Title>Supabase connection</Dialog.Title>
                <Dialog.Description>Stored only on this Mac. Leave both fields empty to keep Todou offline-only.</Dialog.Description>
              </div>
              <Dialog.Close className="icon-button" aria-label="Close settings"><X size={16} /></Dialog.Close>
            </header>

            <div className="settings-fields">
              <label>
                <span><Link2 size={14} />Project URL</span>
                <input
                  autoFocus
                  type="url"
                  value={draft.url}
                  onChange={(event) => updateDraft({ ...draft, url: event.target.value })}
                  placeholder="http://127.0.0.1:54321"
                  spellCheck={false}
                />
              </label>
              <label>
                <span><KeyRound size={14} />Publishable key</span>
                <input
                  type="password"
                  value={draft.publishableKey}
                  onChange={(event) => updateDraft({ ...draft, publishableKey: event.target.value })}
                  placeholder="sb_publishable_…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p className="settings-note">Todou writes locally first. Saving these credentials does not verify the connection.</p>

              <section className="settings-status" aria-labelledby="sync-status-title">
                <div className="settings-status-header">
                  <strong id="sync-status-title">Connection status</strong>
                  <button type="button" onClick={() => void testConnection()} disabled={testing || saving}>
                    {testing ? "Testing…" : "Test connection"}
                  </button>
                </div>

                {runtime === "browser" && (
                  <p className="settings-runtime-note">Browser preview can test reachability but does not sync tasks. Use the desktop app to run the sync worker.</p>
                )}
                {runtime === "tauri" && (
                  <p className="settings-runtime-note">Desktop sync status is for the currently saved settings.</p>
                )}

                {connectionCheck && (
                  <p className="settings-check-success" role="status">
                    {connectionCheck.target === "local" ? "Local" : "Hosted"} Supabase is reachable. Protocol {connectionCheck.protocolVersion} · {connectionCheck.taskCount} {connectionCheck.taskCount === 1 ? "task" : "tasks"} · watermark {connectionCheck.watermark}.
                  </p>
                )}
                {testError && <p className="settings-error" role="alert">{testError}</p>}

                {runtime === "tauri" && diagnosticsLoading && <p className="settings-runtime-note" aria-live="polite">Loading desktop sync status…</p>}
                {nativeDiagnostics && (
                  <div className="settings-diagnostics" aria-live="polite">
                    <p className={`settings-sync-health ${hasSyncIssue ? "is-issue" : ""}`} role="status">
                      <strong>{syncHealth}</strong>
                      <span>{hasSyncIssue ? "The sync worker needs attention." : nativeDiagnostics.lastSuccessfulSync ? "The most recent completed sync succeeded." : "Waiting for the first successful sync."}</span>
                    </p>
                    <div><span>{nativeDiagnostics.pendingOutbox} pending</span><span>{nativeDiagnostics.quarantinedOutbox} quarantined</span></div>
                    <p>Cursor: {nativeDiagnostics.cursor.epoch ? `${nativeDiagnostics.cursor.epoch} · ${nativeDiagnostics.cursor.sequence}` : `not established · ${nativeDiagnostics.cursor.sequence}`}</p>
                    <p>Last success: {nativeDiagnostics.lastSuccessfulSync ?? "Never"}</p>
                    {nativeDiagnostics.lastError && <p className="settings-sync-error" role="alert">{nativeDiagnostics.lastError}</p>}
                  </div>
                )}
                {diagnosticsError && <p className="settings-error" role="alert">{diagnosticsError}</p>}
              </section>
              {error && <p className="settings-error" role="alert">{error}</p>}
            </div>

            <footer className="settings-actions">
              <button className="settings-disable" onClick={() => updateDraft({ url: "", publishableKey: "" })}>Clear connection</button>
              <span />
              <Dialog.Close className="settings-cancel">Cancel</Dialog.Close>
              <button className="settings-save" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
