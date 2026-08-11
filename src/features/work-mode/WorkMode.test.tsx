import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskClient } from "../../lib/taskClient";
import type { Task } from "../../lib/types";
import { WorkMode, type WorkModeClient } from "./WorkMode";

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title,
    description: "",
    bucket: "in_progress",
    priority: "high",
    area: "work",
    dueDate: null,
    estimateMinutes: 30,
    orderKey: id,
    completedAt: null,
    deletedAt: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

type FakeWorkModeClient = WorkModeClient & Pick<TaskClient, "reorderTask"> & {
  emitActive: (active: boolean) => void;
  emitTasks: () => void;
};

function fakeClient(tasks: Task[]): FakeWorkModeClient {
  let activeListener: ((active: boolean) => void) | null = null;
  let taskListener: (() => void) | null = null;
  const client: FakeWorkModeClient = {
    listTasks: vi.fn(async () => tasks),
    reorderTask: vi.fn(async () => tasks),
    completeTask: vi.fn(async (id) => {
      const index = tasks.findIndex((candidate) => candidate.id === id);
      const current = tasks[index];
      if (!current) throw new Error("Task not found");
      const completed = { ...current, completedAt: new Date().toISOString() };
      tasks.splice(index, 1);
      taskListener?.();
      return completed;
    }),
    subscribe: vi.fn(async (listener) => {
      taskListener = listener;
      return () => {
        taskListener = null;
      };
    }),
    loadWorkModeActive: vi.fn(async () => true),
    subscribeWorkModeActive: vi.fn(async (listener) => {
      activeListener = listener;
      return () => {
        activeListener = null;
      };
    }),
    stopWorkMode: vi.fn(async () => {
      activeListener?.(false);
    }),
    emitActive: (active) => activeListener?.(active),
    emitTasks: () => taskListener?.(),
  };
  return client;
}

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => { values.set(type, value); },
  } as unknown as DataTransfer;
}

describe("work mode", () => {
  it("shows every ordered In Progress task", async () => {
    const client = fakeClient([
      task("third", "Ship the release", { priority: "high", orderKey: "C" }),
      task("first", "Write the launch brief", { priority: "low", orderKey: "A" }),
      task("second", "Review the metrics", { priority: "high", orderKey: "B" }),
    ]);

    render(<WorkMode client={client} />);

    expect(await screen.findByText("Write the launch brief")).toBeInTheDocument();
    expect(screen.getByText("Review the metrics")).toBeInTheDocument();
    expect(screen.getByText("Ship the release")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: /^Mark .* done$/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
        "Mark Write the launch brief done",
        "Mark Review the metrics done",
        "Mark Ship the release done",
      ]);
  });

  it("reorders tasks by dragging across priority values", async () => {
    const client = fakeClient([
      task("first", "Write the launch brief", { priority: "low", orderKey: "A" }),
      task("second", "Review the metrics", { priority: "high", orderKey: "B" }),
      task("third", "Ship the release", { priority: "low", orderKey: "C" }),
    ]);
    render(<WorkMode client={client} />);
    const source = (await screen.findByText("Write the launch brief")).closest("li");
    const target = screen.getByText("Ship the release").closest("li");
    if (!source || !target) throw new Error("Expected Work Mode task rows");
    expect(source).toHaveAttribute("draggable", "true");
    expect(screen.getByRole("img", { name: "Drag Write the launch brief to reorder" })).toBeInTheDocument();
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
    } as DOMRect);
    const transfer = dataTransfer();

    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(target, { clientY: 75, dataTransfer: transfer });
    fireEvent.dragLeave(target, { relatedTarget: screen.getByText("Ship the release"), dataTransfer: transfer });
    fireEvent.drop(target, { clientY: 75, dataTransfer: transfer });

    await waitFor(() => expect(client.reorderTask).toHaveBeenCalledWith(
      "first",
      undefined,
      "third",
    ));
  });

  it("never displays more than the three-task limit", async () => {
    const client = fakeClient([
      task("first", "Write the launch brief", { orderKey: "A" }),
      task("second", "Review the metrics", { orderKey: "B" }),
      task("third", "Ship the release", { orderKey: "C" }),
      task("fourth", "Plan the follow-up", { orderKey: "D" }),
    ]);

    render(<WorkMode client={client} />);

    expect(await screen.findByText("Write the launch brief")).toBeInTheDocument();
    expect(screen.getByText("Ship the release")).toBeInTheDocument();
    expect(screen.queryByText("Plan the follow-up")).not.toBeInTheDocument();
  });

  it("does not show a countdown or timer controls", async () => {
    const client = fakeClient([task("first", "Write the launch brief")]);

    render(<WorkMode client={client} />);

    expect(await screen.findByText("Write the launch brief")).toBeInTheDocument();
    expect(screen.queryByText("30:00")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause timer" })).not.toBeInTheDocument();
  });

  it("does not let an older Stop response clear a newly active Work Mode", async () => {
    const tasks = [
      task("first", "Write the launch brief"),
      task("second", "Start the next project"),
    ];
    const client = fakeClient(tasks);
    vi.mocked(client.stopWorkMode).mockImplementation(async () => {
      client.emitActive(false);
      tasks.shift();
      client.emitActive(true);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    render(<WorkMode client={client} />);
    await screen.findByText("Write the launch brief");

    fireEvent.click(screen.getByRole("button", { name: "Stop work mode" }));

    expect(await screen.findByText("Start the next project")).toBeInTheDocument();
    expect(screen.queryByText("Starting work mode…")).not.toBeInTheDocument();
  });

  it("removes whichever task is marked Done", async () => {
    const client = fakeClient([
      task("first", "Write the launch brief"),
      task("second", "Review the metrics"),
      task("third", "Ship the release"),
    ]);
    render(<WorkMode client={client} />);
    await screen.findByText("Write the launch brief");

    fireEvent.click(screen.getByRole("button", { name: "Mark Review the metrics done" }));

    await waitFor(() => expect(screen.queryByText("Review the metrics")).not.toBeInTheDocument());
    expect(screen.getByText("Write the launch brief")).toBeInTheDocument();
    expect(screen.getByText("Ship the release")).toBeInTheDocument();
  });

  it("can start again after finishing every task", async () => {
    const tasks = [task("first", "Finish the launch brief")];
    const client = fakeClient(tasks);
    vi.mocked(client.completeTask).mockImplementation(async (id) => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const current = tasks.find((candidate) => candidate.id === id);
      if (!current) throw new Error("Task not found");
      tasks.splice(0, 1);
      client.emitTasks();
      return { ...current, completedAt: new Date().toISOString() };
    });
    render(<WorkMode client={client} />);
    await screen.findByText("Finish the launch brief");

    fireEvent.click(screen.getByRole("button", { name: "Mark Finish the launch brief done" }));
    expect(await screen.findByText("All done")).toBeInTheDocument();
    await waitFor(() => expect(client.stopWorkMode).toHaveBeenCalled(), {
      timeout: 2_500,
    });

    tasks.push(task("second", "Start the next project"));
    client.emitActive(true);

    expect(await screen.findByText("Start the next project")).toBeInTheDocument();
    expect(screen.queryByText("All done")).not.toBeInTheDocument();
  });
});
