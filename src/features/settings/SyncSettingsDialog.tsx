import { Dialog } from "@base-ui/react/dialog";
import { Database, KeyRound, Link2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { normalizeSyncSettings, type SyncSettings } from "../../lib/syncSettings";

interface SyncSettingsDialogProps {
  open: boolean;
  settings: SyncSettings;
  onOpenChange: (open: boolean) => void;
  onSave: (settings: SyncSettings) => Promise<void>;
}

export function SyncSettingsDialog({ open, settings, onOpenChange, onSave }: SyncSettingsDialogProps) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setError(null);
  }, [open, settings]);

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
                  onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                  placeholder="http://127.0.0.1:54321"
                  spellCheck={false}
                />
              </label>
              <label>
                <span><KeyRound size={14} />Publishable key</span>
                <input
                  type="password"
                  value={draft.publishableKey}
                  onChange={(event) => setDraft((current) => ({ ...current, publishableKey: event.target.value }))}
                  placeholder="sb_publishable_…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p className="settings-note">Todou writes locally first. This connection only lets the background worker reconcile with your other Mac.</p>
              {error && <p className="settings-error" role="alert">{error}</p>}
            </div>

            <footer className="settings-actions">
              <button className="settings-disable" onClick={() => setDraft({ url: "", publishableKey: "" })}>Clear connection</button>
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
