import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { defaultShortcuts } from "../../lib/shortcuts";
import type { Task } from "../../lib/types";
import { CommandPalette, type PaletteMode } from "./CommandPalette";

function renderPalette(
  mode: PaletteMode,
  overrides: Partial<ComponentProps<typeof CommandPalette>> = {},
) {
  const props: ComponentProps<typeof CommandPalette> = {
    open: true,
    startMode: mode,
    onOpenChange: vi.fn(),
    onNavigate: vi.fn(),
    onNewTask: vi.fn(),
    onExport: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenAiSettings: vi.fn(),
    onRunDedupeScan: vi.fn(),
    dedupeScanRunning: false,
    selectedTask: null,
    canUndo: false,
    onCompleteSelected: vi.fn(),
    onRestoreSelected: vi.fn(),
    onMoveSelected: vi.fn(),
    onTogglePrioritySelected: vi.fn(),
    onToggleAreaSelected: vi.fn(),
    onDeleteSelected: vi.fn(),
    onUndo: vi.fn(),
    committedTheme: "superhuman",
    onThemePreview: vi.fn(),
    onThemeCommit: vi.fn(),
    shortcuts: defaultShortcuts,
    onShortcutChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CommandPalette {...props} />) };
}

describe("command palette", () => {
  it("previews themes with arrows and restores the original theme on escape", async () => {
    const onThemePreview = vi.fn();
    renderPalette("themes", { onThemePreview });
    await waitFor(() => expect(onThemePreview).toHaveBeenCalledWith("superhuman"));
    onThemePreview.mockClear();

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    await waitFor(() => expect(onThemePreview).toHaveBeenCalledWith("oc-2-light"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onThemePreview).toHaveBeenLastCalledWith("superhuman");
  });

  it("scrolls the keyboard-active theme row into view", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });

    try {
      renderPalette("themes");
      scrollIntoView.mockClear();

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });

      const activeTheme = await screen.findByRole("option", { name: /OC-2 Light/i });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
      expect(scrollIntoView.mock.instances.at(-1)).toBe(activeTheme);
    } finally {
      if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("opens connection settings through a real command", () => {
    const onOpenChange = vi.fn();
    const onOpenSettings = vi.fn();
    renderPalette("commands", { onOpenChange, onOpenSettings });

    fireEvent.click(screen.getByRole("option", { name: /Connection settings/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("opens AI settings through a real command", () => {
    const onOpenChange = vi.fn();
    const onOpenAiSettings = vi.fn();
    renderPalette("commands", { onOpenChange, onOpenAiSettings });

    fireEvent.click(screen.getByRole("option", { name: /AI de-duplication settings/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenAiSettings).toHaveBeenCalledOnce();
  });

  it("runs an on-demand duplicate scan through a real command", () => {
    const onOpenChange = vi.fn();
    const onRunDedupeScan = vi.fn();
    renderPalette("commands", { onOpenChange, onRunDedupeScan });

    fireEvent.click(screen.getByRole("option", { name: /Check all tasks for duplicates/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRunDedupeScan).toHaveBeenCalledOnce();
  });

  it("offers the development installer command only when its native callback exists", () => {
    const onBuildInstaller = vi.fn();
    const { unmount } = renderPalette("commands", { onBuildInstaller });

    const buildCommand = screen.getByRole("option", { name: /Build production app/i });
    expect(buildCommand).toHaveTextContent("Install directly without leaving a mounted DMG");
    fireEvent.click(buildCommand);
    expect(onBuildInstaller).toHaveBeenCalledOnce();

    unmount();
    renderPalette("commands");
    expect(screen.queryByRole("option", { name: /Build production app/i })).not.toBeInTheDocument();
  });

  it("runs contextual task workflows, not just navigation", () => {
    const onCompleteSelected = vi.fn();
    const selectedTask: Task = {
      id: "task-1",
      title: "Ship the build",
      description: "",
      bucket: "today",
      priority: "high",
      area: "work",
      dueDate: null,
      estimateMinutes: 25,
      orderKey: "V",
      completedAt: null,
      deletedAt: null,
      createdAt: "2026-07-20T20:00:00.000Z",
      updatedAt: "2026-07-20T20:00:00.000Z",
    };
    renderPalette("commands", { selectedTask, onCompleteSelected });

    fireEvent.click(screen.getByRole("option", { name: /Complete selected task/i }));
    expect(onCompleteSelected).toHaveBeenCalledOnce();
  });

  it("does not offer invalid list moves for a completed task", () => {
    const selectedTask: Task = {
      id: "task-2",
      title: "Archived task",
      description: "",
      bucket: "today",
      priority: "low",
      area: "personal",
      dueDate: null,
      estimateMinutes: null,
      orderKey: "V",
      completedAt: "2026-07-20T21:00:00.000Z",
      deletedAt: null,
      createdAt: "2026-07-20T20:00:00.000Z",
      updatedAt: "2026-07-20T21:00:00.000Z",
    };
    renderPalette("commands", { selectedTask });

    expect(screen.getByRole("option", { name: /Restore selected task/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Move selected task to Today/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Move selected task to Inbox/i })).not.toBeInTheDocument();
  });
});
