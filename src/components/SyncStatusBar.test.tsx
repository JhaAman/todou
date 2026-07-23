import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SyncStatusBar } from "./SyncStatusBar";

describe("sync status bar", () => {
  it.each([
    ["up-to-date", "Up to date"],
    ["updating", "Updating"],
    ["not-connected", "Not connected"],
  ] as const)("shows the %s sync state", (status, label) => {
    render(<SyncStatusBar status={status} />);

    expect(screen.getByRole("status", { name: `Supabase: ${label}` })).toHaveTextContent(label);
  });
});
