import { Dialog } from "@base-ui/react/dialog";
import { BrainCircuit, KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  LlmSettingsStatus,
  ProviderCredentialStatus,
  SaveLlmSettingsInput,
} from "../../lib/taskClient";

interface AiSettingsDialogProps {
  open: boolean;
  runtime: "browser" | "tauri";
  status: LlmSettingsStatus;
  onOpenChange: (open: boolean) => void;
  onSave: (input: SaveLlmSettingsInput) => Promise<LlmSettingsStatus>;
}

interface KeyDraft {
  value: string;
  clear: boolean;
}

function statusLabel(status: ProviderCredentialStatus): string {
  if (status.source === "saved") return "Saved on this Mac";
  if (status.source === "environment") return "From environment";
  return "Not configured";
}

export function AiSettingsDialog({
  open,
  runtime,
  status,
  onOpenChange,
  onSave,
}: AiSettingsDialogProps) {
  const [openai, setOpenai] = useState<KeyDraft>({ value: "", clear: false });
  const [anthropic, setAnthropic] = useState<KeyDraft>({ value: "", clear: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOpenai({ value: "", clear: false });
    setAnthropic({ value: "", clear: false });
    setSaving(false);
    setError(null);
  }, [open]);

  const save = async () => {
    const input: SaveLlmSettingsInput = {};
    if (openai.clear) input.openaiApiKey = null;
    else if (openai.value.trim()) input.openaiApiKey = openai.value.trim();
    if (anthropic.clear) input.anthropicApiKey = null;
    else if (anthropic.value.trim()) input.anthropicApiKey = anthropic.value.trim();

    setSaving(true);
    setError(null);
    try {
      await onSave(input);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save AI settings.");
    } finally {
      setSaving(false);
    }
  };

  const native = runtime === "tauri";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-backdrop" />
        <Dialog.Viewport className="settings-viewport">
          <Dialog.Popup className="settings-dialog ai-settings-dialog">
            <header className="settings-header">
              <span className="settings-icon"><BrainCircuit size={17} /></span>
              <div>
                <Dialog.Title>AI task de-duplication</Dialog.Title>
                <Dialog.Description>
                  Add OpenAI, Anthropic, or both. Keys are shared by every Todou build on this Mac.
                </Dialog.Description>
              </div>
              <Dialog.Close className="icon-button" aria-label="Close AI settings"><X size={16} /></Dialog.Close>
            </header>

            <div className="settings-fields">
              {!native && (
                <p className="ai-native-only" role="note">
                  The desktop app is required for AI task de-duplication. Browser preview never stores API keys.
                </p>
              )}

              <section className="ai-provider" aria-labelledby="openai-provider-title">
                <div className="ai-provider-heading">
                  <div>
                    <strong id="openai-provider-title">OpenAI</strong>
                    <span className={`ai-provider-status ${status.openai.configured ? "is-configured" : ""}`}>
                      {statusLabel(status.openai)}
                    </span>
                  </div>
                  {native && status.openai.source === "saved" && (
                    <button
                      type="button"
                      onClick={() => setOpenai((current) => ({
                        value: "",
                        clear: !current.clear,
                      }))}
                      aria-label={openai.clear ? "Keep saved OpenAI key" : "Clear saved OpenAI key"}
                    >
                      {openai.clear ? "Keep saved key" : "Clear saved key"}
                    </button>
                  )}
                </div>
                <label>
                  <span><KeyRound size={14} />OpenAI API key</span>
                  <input
                    type="password"
                    value={openai.value}
                    disabled={!native || openai.clear || saving}
                    onChange={(event) => setOpenai({ value: event.target.value, clear: false })}
                    placeholder={openai.clear ? "Saved key will be removed" : status.openai.configured ? "Paste a new key to replace it" : "sk-…"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                {openai.clear && <p className="ai-clear-note">The saved override will be removed. An OPENAI_API_KEY environment value can take over.</p>}
              </section>

              <section className="ai-provider" aria-labelledby="anthropic-provider-title">
                <div className="ai-provider-heading">
                  <div>
                    <strong id="anthropic-provider-title">Anthropic</strong>
                    <span className={`ai-provider-status ${status.anthropic.configured ? "is-configured" : ""}`}>
                      {statusLabel(status.anthropic)}
                    </span>
                  </div>
                  {native && status.anthropic.source === "saved" && (
                    <button
                      type="button"
                      onClick={() => setAnthropic((current) => ({
                        value: "",
                        clear: !current.clear,
                      }))}
                      aria-label={anthropic.clear ? "Keep saved Anthropic key" : "Clear saved Anthropic key"}
                    >
                      {anthropic.clear ? "Keep saved key" : "Clear saved key"}
                    </button>
                  )}
                </div>
                <label>
                  <span><KeyRound size={14} />Anthropic API key</span>
                  <input
                    type="password"
                    value={anthropic.value}
                    disabled={!native || anthropic.clear || saving}
                    onChange={(event) => setAnthropic({ value: event.target.value, clear: false })}
                    placeholder={anthropic.clear ? "Saved key will be removed" : status.anthropic.configured ? "Paste a new key to replace it" : "sk-ant-…"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                {anthropic.clear && <p className="ai-clear-note">The saved override will be removed. An ANTHROPIC_API_KEY environment value can take over.</p>}
              </section>

              <section className="settings-status ai-queue-status" aria-labelledby="ai-queue-title">
                <div className="settings-status-header">
                  <strong id="ai-queue-title">Reconciliation queue</strong>
                </div>
                <div className="ai-queue-counts">
                  <span>{status.pendingJobs} pending</span>
                  <span className={status.failedJobs ? "has-failures" : ""}>{status.failedJobs} need attention</span>
                </div>
                <p className="settings-runtime-note">
                  Queued Quick Entry and MCP tasks are checked when the main app is focused.
                </p>
              </section>

              <p className="settings-note">
                Keys are stored unencrypted in Todou’s device-local database, not Keychain, so macOS will not ask for a password. They never sync.
              </p>
              {error && <p className="settings-error" role="alert">{error}</p>}
            </div>

            <footer className="settings-actions">
              <span />
              <Dialog.Close className="settings-cancel">Cancel</Dialog.Close>
              <button
                type="button"
                className="settings-save"
                onClick={() => void save()}
                disabled={!native || saving}
                aria-label="Save AI settings"
              >
                {saving ? "Validating…" : "Save"}
              </button>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
