import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NativeSyncDiagnostics } from "../lib/syncSettings";
import { SyncStatusBar } from "./SyncStatusBar";

const diagnostics: NativeSyncDiagnostics = {
  runtime: "tauri",
  syncAvailable: true,
  pendingOutbox: 3,
  quarantinedOutbox: 0,
  cursor: { epoch: "sync-epoch", sequence: 17 },
  lastSuccessfulSync: "2026-07-23T18:30:00.000Z",
  lastError: "Remote request timed out",
};

function renderStatus(overrides = {}) {
  const props = {
    status: "not-connected" as const,
    configured: true,
    runtime: "tauri" as const,
    onLoadDiagnostics: vi.fn(async () => diagnostics),
    onCheckAgain: vi.fn(async () => undefined),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<SyncStatusBar {...props} />) };
}

describe("sync status bar", () => {
  it.each([
    ["up-to-date", "Up to date"],
    ["updating", "Updating"],
    ["not-connected", "Not connected"],
  ] as const)("keeps the compact %s state", (status, label) => {
    renderStatus({ status });

    expect(screen.getByRole("button", { name: `Supabase: ${label}` })).toHaveTextContent(label);
  });

  it("shows the latest useful native diagnostics", async () => {
    renderStatus();

    fireEvent.click(screen.getByRole("button", { name: "Supabase: Not connected" }));

    const popover = await screen.findByRole("dialog", { name: "Supabase sync" });
    expect(within(popover).getByText("Todou couldn’t finish the latest sync.")).toBeInTheDocument();
    expect(within(popover).getByText("Remote request timed out")).toBeInTheDocument();
    expect(within(popover).getByText("3", { selector: "dd" })).toBeInTheDocument();
    expect(within(popover).getByText("sync-epoch · 17")).toBeInTheDocument();
    expect(within(popover).getByRole("time")).toHaveAttribute("datetime", "2026-07-23T18:30:00.000Z");
  });

  it("warns about rejected updates even when the worker is up to date", async () => {
    renderStatus({
      status: "up-to-date",
      onLoadDiagnostics: vi.fn(async () => ({
        ...diagnostics,
        pendingOutbox: 0,
        quarantinedOutbox: 2,
        lastError: null,
      })),
    });

    fireEvent.click(screen.getByRole("button", { name: "Supabase: Up to date" }));

    expect(await screen.findByText("2 updates need attention")).toBeInTheDocument();
  });

  it("requests a fresh worker check without claiming recovery", async () => {
    const { props } = renderStatus();
    fireEvent.click(screen.getByRole("button", { name: "Supabase: Not connected" }));

    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));

    await waitFor(() => expect(props.onCheckAgain).toHaveBeenCalledOnce());
    expect(screen.getByText("Check requested")).toBeInTheDocument();
  });

  it("routes unconfigured users to connection settings", async () => {
    const { props } = renderStatus({ configured: false });
    fireEvent.click(screen.getByRole("button", { name: "Supabase: Not connected" }));

    expect(await screen.findByText("Supabase isn’t set up on this Mac.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));

    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("does not offer a dead retry action in browser preview", async () => {
    renderStatus({
      runtime: "browser",
      onLoadDiagnostics: vi.fn(async () => ({ runtime: "browser", syncAvailable: false })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Supabase: Not connected" }));

    expect(await screen.findByText("Sync only runs in the desktop app.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });

  it("explains when diagnostic details cannot be loaded", async () => {
    renderStatus({
      onLoadDiagnostics: vi.fn(async () => {
        throw new Error("Native command unavailable");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Supabase: Not connected" }));

    expect(await screen.findByText("Couldn’t load sync details.")).toBeInTheDocument();
    expect(screen.getByText("Native command unavailable")).toBeInTheDocument();
  });
});
