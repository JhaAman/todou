import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { taskClient } from "./lib/taskClient";
import type { Task } from "./lib/types";

const taskStoreKey = "todou.browser.tasks.v1";
const taskSeedKey = "todou.browser.seeded.v1";

function task(overrides: Partial<Task> & Pick<Task, "id" | "title" | "bucket">): Task {
  return {
    priority: "low",
    area: "work",
    description: "",
    dueDate: null,
    estimateMinutes: null,
    orderKey: "000001",
    completedAt: null,
    deletedAt: null,
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
    ...overrides,
  };
}

async function renderApp(tasks: Task[]) {
  localStorage.setItem(taskSeedKey, "true");
  localStorage.setItem(taskStoreKey, JSON.stringify(tasks));
  render(<App />);
  await waitFor(() => expect(screen.queryByLabelText("Loading tasks")).not.toBeInTheDocument());
}

function taskRow(title: string): HTMLElement {
  const row = screen.getByText(title, { selector: ".task-title" }).closest<HTMLElement>("[role='listitem']");
  if (!row) throw new Error(`Could not find task row for ${title}`);
  return row;
}

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => { values.set(type, value); },
  } as unknown as DataTransfer;
}

function drag(source: HTMLElement, destination: HTMLElement, clientY = 0) {
  const transfer = dataTransfer();
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent.dragOver(destination, { clientY, dataTransfer: transfer });
  fireEvent.drop(destination, { clientY, dataTransfer: transfer });
}

function storedTask(id: string): Task | undefined {
  const tasks = JSON.parse(localStorage.getItem(taskStoreKey) ?? "[]") as Task[];
  return tasks.find((candidate) => candidate.id === id);
}

describe("task drag and drop", () => {
  beforeEach(() => localStorage.clear());

  it("moves a Today task into an empty Inbox and clears its due date", async () => {
    await renderApp([
      task({ id: "today-task", title: "Move to Inbox", bucket: "today", dueDate: "2026-07-21" }),
    ]);

    const inbox = screen.getByRole("region", { name: "Inbox" });
    drag(taskRow("Move to Inbox"), inbox);

    await waitFor(() => expect(within(inbox).getByText("Move to Inbox")).toBeInTheDocument());
    expect(storedTask("today-task")).toMatchObject({ bucket: "inbox", dueDate: null });
  });

  it("moves an Inbox task into an empty Today section", async () => {
    await renderApp([
      task({ id: "inbox-task", title: "Move to Today", bucket: "inbox", dueDate: "2026-07-30" }),
    ]);

    const today = screen.getByRole("region", { name: "Today" });
    drag(taskRow("Move to Today"), today);

    await waitFor(() => expect(within(today).getByText("Move to Today")).toBeInTheDocument());
    expect(storedTask("inbox-task")).toMatchObject({ bucket: "today", dueDate: "2026-07-30" });
  });

  it("moves an Inbox task to Today when it is dropped on a Today task", async () => {
    await renderApp([
      task({ id: "today-task", title: "Already Today", bucket: "today" }),
      task({ id: "inbox-task", title: "Move to Today", bucket: "inbox", dueDate: "2026-07-30" }),
    ]);
    const moveTask = vi.spyOn(taskClient, "moveTask");
    const destination = taskRow("Already Today");
    vi.spyOn(destination, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
    } as DOMRect);

    drag(taskRow("Move to Today"), destination, 75);

    const today = screen.getByRole("region", { name: "Today" });
    await waitFor(() => expect(within(today).getByText("Move to Today")).toBeInTheDocument());
    expect(storedTask("inbox-task")).toMatchObject({ bucket: "today", dueDate: "2026-07-30" });
    expect(moveTask).toHaveBeenCalledOnce();
  });

  it("uses a non-positional affordance when a task is dragged across buckets", async () => {
    await renderApp([
      task({ id: "today-target", title: "Today target", bucket: "today" }),
      task({ id: "inbox-source", title: "Inbox source", bucket: "inbox" }),
    ]);
    const source = taskRow("Inbox source");
    const destination = taskRow("Today target");
    const transfer = dataTransfer();
    vi.spyOn(destination, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
    } as DOMRect);

    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(destination, { clientY: 75, dataTransfer: transfer });

    expect(destination).toHaveClass("is-task-drop-target");
    expect(destination).not.toHaveClass("drop-before", "drop-after");
    fireEvent.dragEnd(source, { dataTransfer: transfer });
  });

  it("moves a task to Today through the persistent sidebar target", async () => {
    await renderApp([
      task({ id: "sidebar-today", title: "Sidebar to Today", bucket: "inbox", dueDate: "2026-07-30" }),
    ]);

    drag(taskRow("Sidebar to Today"), screen.getByRole("button", { name: /^Today/ }));

    await waitFor(() => expect(storedTask("sidebar-today")).toMatchObject({
      bucket: "today",
      dueDate: "2026-07-30",
    }));
  });

  it("moves a task to Inbox through the persistent sidebar target", async () => {
    await renderApp([
      task({ id: "sidebar-inbox", title: "Sidebar to Inbox", bucket: "today", dueDate: "2026-07-21" }),
    ]);

    drag(taskRow("Sidebar to Inbox"), screen.getByRole("button", { name: /^Inbox/ }));

    await waitFor(() => expect(storedTask("sidebar-inbox")).toMatchObject({
      bucket: "inbox",
      dueDate: null,
    }));
  });

  it("clears the sidebar drop affordance when a drag is cancelled", async () => {
    await renderApp([
      task({ id: "cancel-drag", title: "Cancel drag", bucket: "inbox" }),
    ]);
    const source = taskRow("Cancel drag");
    const destination = screen.getByRole("button", { name: /^Today/ });
    const transfer = dataTransfer();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(destination, { dataTransfer: transfer });
    expect(destination).toHaveClass("is-task-drop-target");

    fireEvent.dragEnd(source, { dataTransfer: transfer });

    expect(destination).not.toHaveClass("is-task-drop-target");
  });

  it("keeps row-to-row ordering within a bucket", async () => {
    await renderApp([
      task({ id: "first", title: "First", bucket: "today", orderKey: "000001" }),
      task({ id: "second", title: "Second", bucket: "today", orderKey: "000002" }),
    ]);
    const destination = taskRow("Second");
    vi.spyOn(destination, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
    } as DOMRect);

    drag(taskRow("First"), destination, 75);

    const today = screen.getByRole("region", { name: "Today" });
    await waitFor(() => {
      const rows = within(today).getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("Second");
      expect(rows[1]).toHaveTextContent("First");
    });
  });

  it("moves a task into In Progress while it has room", async () => {
    await renderApp([
      task({ id: "first", title: "First in progress", bucket: "in_progress" }),
      task({ id: "second", title: "Second in progress", bucket: "in_progress" }),
      task({ id: "inbox-task", title: "Start this", bucket: "inbox" }),
    ]);

    const inProgress = screen.getByRole("region", { name: "In Progress" });
    const transfer = dataTransfer();
    fireEvent.dragStart(taskRow("Start this"), { dataTransfer: transfer });
    const getData = vi.spyOn(transfer, "getData").mockReturnValue("");
    fireEvent.dragOver(inProgress, { dataTransfer: transfer });

    expect(inProgress).toHaveClass("is-task-drop-target");

    getData.mockRestore();
    fireEvent.drop(inProgress, { dataTransfer: transfer });

    await waitFor(() => expect(within(inProgress).getByText("Start this")).toBeInTheDocument());
    expect(storedTask("inbox-task")).toMatchObject({ bucket: "in_progress" });
  });

  it("rejects a fourth task dropped into In Progress", async () => {
    await renderApp([
      task({ id: "first", title: "First in progress", bucket: "in_progress" }),
      task({ id: "second", title: "Second in progress", bucket: "in_progress" }),
      task({ id: "third", title: "Third in progress", bucket: "in_progress" }),
      task({ id: "inbox-task", title: "Too many", bucket: "inbox" }),
    ]);
    const inProgress = screen.getByRole("region", { name: "In Progress" });
    const moveTask = vi.spyOn(taskClient, "moveTask");
    const transfer = dataTransfer();

    fireEvent.dragStart(taskRow("Too many"), { dataTransfer: transfer });
    fireEvent.dragOver(inProgress, { dataTransfer: transfer });

    expect(inProgress).toHaveClass("is-task-drop-invalid");

    fireEvent.drop(inProgress, { dataTransfer: transfer });

    expect(storedTask("inbox-task")).toMatchObject({ bucket: "inbox" });
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("rejects a fourth task dropped directly onto an In Progress task", async () => {
    await renderApp([
      task({ id: "first", title: "First in progress", bucket: "in_progress" }),
      task({ id: "second", title: "Second in progress", bucket: "in_progress" }),
      task({ id: "third", title: "Third in progress", bucket: "in_progress" }),
      task({ id: "inbox-task", title: "Too many", bucket: "inbox" }),
    ]);
    const destination = taskRow("First in progress");
    const moveTask = vi.spyOn(taskClient, "moveTask");
    vi.spyOn(destination, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
    } as DOMRect);
    const transfer = dataTransfer();

    fireEvent.dragStart(taskRow("Too many"), { dataTransfer: transfer });
    const getData = vi.spyOn(transfer, "getData").mockReturnValue("");
    fireEvent.dragOver(destination, { clientY: 75, dataTransfer: transfer });

    expect(destination).toHaveClass("is-task-drop-invalid");
    expect(destination).not.toHaveClass("is-task-drop-target");

    getData.mockRestore();
    fireEvent.drop(destination, { clientY: 75, dataTransfer: transfer });

    expect(storedTask("inbox-task")).toMatchObject({ bucket: "inbox" });
    expect(moveTask).not.toHaveBeenCalled();
  });
});

describe("task move keyboard shortcuts", () => {
  beforeEach(() => localStorage.clear());

  it("selects the following Inbox task after moving the selected task to Today", async () => {
    await renderApp([
      task({ id: "first-inbox", title: "Move first", bucket: "inbox", orderKey: "000001" }),
      task({ id: "second-inbox", title: "Keep going", bucket: "inbox", orderKey: "000002" }),
    ]);

    fireEvent.click(taskRow("Move first"));
    fireEvent.keyDown(document.body, { key: "t", metaKey: true, shiftKey: true });

    await waitFor(() => expect(storedTask("first-inbox")).toMatchObject({ bucket: "today" }));
    expect(taskRow("Keep going")).toHaveAttribute("aria-current", "true");
    expect(taskRow("Move first")).not.toHaveAttribute("aria-current", "true");
  });

  it("selects the preceding Today task when the selected source task is last", async () => {
    await renderApp([
      task({ id: "first-today", title: "Keep going", bucket: "today", orderKey: "000001" }),
      task({ id: "last-today", title: "Move last", bucket: "today", orderKey: "000002" }),
      task({ id: "inbox-task", title: "Already Inbox", bucket: "inbox", orderKey: "000001" }),
    ]);

    fireEvent.click(taskRow("Move last"));
    fireEvent.keyDown(document.body, { key: "i", metaKey: true, shiftKey: true });

    await waitFor(() => expect(storedTask("last-today")).toMatchObject({ bucket: "inbox" }));
    expect(taskRow("Keep going")).toHaveAttribute("aria-current", "true");
    expect(taskRow("Already Inbox")).not.toHaveAttribute("aria-current", "true");
    expect(taskRow("Move last")).not.toHaveAttribute("aria-current", "true");
  });

  it("restores the moved task selection when the keyboard move fails", async () => {
    await renderApp([
      task({ id: "first-inbox", title: "Move first", bucket: "inbox", orderKey: "000001" }),
      task({ id: "second-inbox", title: "Keep going", bucket: "inbox", orderKey: "000002" }),
    ]);
    vi.spyOn(taskClient, "moveTask").mockRejectedValueOnce(new Error("Move failed"));

    fireEvent.click(taskRow("Move first"));
    fireEvent.keyDown(document.body, { key: "t", metaKey: true, shiftKey: true });

    await waitFor(() => expect(taskRow("Move first")).toHaveAttribute("aria-current", "true"));
    expect(storedTask("first-inbox")).toMatchObject({ bucket: "inbox" });
  });
});

describe("new task keyboard shortcuts", () => {
  beforeEach(() => localStorage.clear());

  it("opens the task composer with unmodified Space when no task is selected", async () => {
    await renderApp([]);

    fireEvent.keyDown(document.body, { key: " ", code: "Space" });

    expect(screen.getByRole("form", { name: /Add task to/i })).toBeInTheDocument();
  });

  it("does not use Space while an interactive control has focus", async () => {
    await renderApp([]);
    const search = screen.getByRole("button", { name: "Search" });
    search.focus();

    fireEvent.keyDown(search, { key: " ", code: "Space" });

    expect(screen.queryByRole("form", { name: /Add task to/i })).not.toBeInTheDocument();
  });

  it("does not use Space while a task is selected", async () => {
    await renderApp([task({ id: "selected", title: "Selected task", bucket: "today" })]);
    fireEvent.click(taskRow("Selected task"));

    fireEvent.keyDown(document.body, { key: " ", code: "Space" });

    expect(screen.queryByRole("form", { name: /Add task to/i })).not.toBeInTheDocument();
  });

  it("keeps the configured Command-N shortcut working", async () => {
    await renderApp([]);

    fireEvent.keyDown(document.body, { key: "n", metaKey: true });

    expect(screen.getByRole("form", { name: /Add task to/i })).toBeInTheDocument();
  });

  it.each([
    { modifier: "Control", init: { ctrlKey: true } },
    { modifier: "Alt", init: { altKey: true } },
    { modifier: "Shift", init: { shiftKey: true } },
    { modifier: "Command", init: { metaKey: true } },
  ])("does not use $modifier-Space as the ambient new-task shortcut", async ({ init }) => {
    await renderApp([]);

    fireEvent.keyDown(document.body, { key: " ", code: "Space", ...init });

    expect(screen.queryByRole("form", { name: /Add task to/i })).not.toBeInTheDocument();
  });
});

describe("search navigation", () => {
  beforeEach(() => localStorage.clear());

  it("returns to the previous view when Escape is pressed after opening search with Command-P", async () => {
    await renderApp([
      task({ id: "inbox-task", title: "Plan next week", bucket: "inbox" }),
    ]);
    fireEvent.click(within(screen.getByLabelText("Primary navigation")).getByRole("button", { name: /^Inbox/ }));

    fireEvent.keyDown(document.body, { key: "p", metaKey: true });

    const search = await screen.findByRole("textbox", { name: "Search" });
    fireEvent.keyDown(search, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });
});

describe("sync settings", () => {
  beforeEach(() => localStorage.clear());

  it("confirms that settings were saved without claiming the connection was verified", async () => {
    await renderApp([]);
    fireEvent.click(within(screen.getByLabelText("Primary navigation")).getByRole("button", { name: "Commands" }));
    fireEvent.click(await screen.findByRole("option", { name: /Connection settings/i }));
    fireEvent.change(screen.getByLabelText(/Project URL/i), { target: { value: "https://example.supabase.co" } });
    fireEvent.change(screen.getByLabelText(/Publishable key/i), { target: { value: "publishable-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Supabase settings saved")).toBeInTheDocument();
    expect(screen.queryByText("Supabase connection saved")).not.toBeInTheDocument();
  });
});
