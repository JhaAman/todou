import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SyncConnectionCheck } from "../../lib/syncSettings";
import { SyncSettingsDialog } from "./SyncSettingsDialog";

const settings = { url: "http://127.0.0.1:54321", publishableKey: "local-key" };

function renderDialog(overrides = {}) {
  const props = {
    open: true,
    settings,
    runtime: "browser" as const,
    onOpenChange: vi.fn(),
    onSave: vi.fn(async () => undefined),
    onTestConnection: vi.fn(async () => ({
      target: "local" as const,
      protocolVersion: 2,
      epoch: "local-epoch",
      watermark: 4,
      taskCount: 2,
    })),
    onLoadDiagnostics: vi.fn(async () => ({ runtime: "browser" as const, syncAvailable: false as const })),
    ...overrides,
  };
  return { props, ...render(<SyncSettingsDialog {...props} />) };
}

describe("sync settings dialog", () => {
  it("tests browser reachability without claiming the preview syncs", async () => {
    const { props } = renderDialog();
    expect(screen.getByText(/browser preview can test reachability but does not sync/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(props.onTestConnection).toHaveBeenCalledWith(settings));
    expect(screen.getByRole("status")).toHaveTextContent(/local Supabase is reachable/i);
    expect(screen.getByRole("status")).toHaveTextContent(/2 tasks/i);
  });

  it("discards an in-flight reachability result after the draft changes", async () => {
    let resolveTest: ((value: SyncConnectionCheck) => void) | undefined;
    const pending = new Promise<SyncConnectionCheck>((resolve) => { resolveTest = resolve; });
    renderDialog({ onTestConnection: vi.fn(() => pending) });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    fireEvent.change(screen.getByLabelText(/Project URL/i), { target: { value: "http://localhost:54321" } });
    await act(async () => {
      resolveTest?.({ target: "local", protocolVersion: 2, epoch: "old-epoch", watermark: 4, taskCount: 2 });
      await pending;
    });

    expect(screen.queryByText(/Supabase is reachable/i)).not.toBeInTheDocument();
  });

  it("shows native pending, quarantined, cursor, success, and error diagnostics", async () => {
    renderDialog({
      runtime: "tauri" as const,
      onLoadDiagnostics: vi.fn(async () => ({
        runtime: "tauri" as const,
        syncAvailable: true as const,
        pendingOutbox: 3,
        quarantinedOutbox: 1,
        cursor: { epoch: "sync-epoch", sequence: 17 },
        lastSuccessfulSync: "1721430000000-0-device",
        lastError: "Remote request timed out",
      })),
    });

    expect(await screen.findByText("3 pending")).toBeInTheDocument();
    expect(screen.getByText("1 quarantined")).toBeInTheDocument();
    expect(screen.getByText(/sync-epoch · 17/)).toBeInTheDocument();
    expect(screen.getByText(/1721430000000-0-device/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Remote request timed out");
    expect(screen.getByRole("status")).toHaveTextContent("Sync issue");
  });

  it("treats quarantined changes as a sync issue without a stored error", async () => {
    renderDialog({
      runtime: "tauri" as const,
      onLoadDiagnostics: vi.fn(async () => ({
        runtime: "tauri" as const,
        syncAvailable: true as const,
        pendingOutbox: 0,
        quarantinedOutbox: 2,
        cursor: { epoch: "sync-epoch", sequence: 17 },
        lastSuccessfulSync: "1721430000000-0-device",
        lastError: null,
      })),
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Sync issue");
    expect(screen.getByText("2 quarantined")).toBeInTheDocument();
  });

  it("describes a prior successful worker run without claiming a current connection", async () => {
    renderDialog({
      runtime: "tauri" as const,
      onLoadDiagnostics: vi.fn(async () => ({
        runtime: "tauri" as const,
        syncAvailable: true as const,
        pendingOutbox: 0,
        quarantinedOutbox: 0,
        cursor: { epoch: "sync-epoch", sequence: 17 },
        lastSuccessfulSync: "1721430000000-0-device",
        lastError: null,
      })),
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Last sync succeeded");
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });
});
