import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../lib/types";
import { WorkMode, type WorkModeClient } from "./WorkMode";

function task(id: string, title: string): Task {
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
  };
}

function fakeClient(tasks: Task[]): WorkModeClient & {
  emitActive: (active: boolean) => void;
  emitTasks: () => void;
} {
  let activeListener: ((active: boolean) => void) | null = null;
  let taskListener: (() => void) | null = null;
  const client: WorkModeClient & {
    emitActive: (active: boolean) => void;
    emitTasks: () => void;
  } = {
    listTasks: vi.fn(async () => tasks),
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

describe("work mode", () => {
  it("shows only the first ordered In Progress task", async () => {
    const client = fakeClient([
      task("first", "Write the launch brief"),
      task("second", "Review the metrics"),
    ]);

    render(<WorkMode client={client} />);

    expect(await screen.findByText("Write the launch brief")).toBeInTheDocument();
    expect(screen.queryByText("Review the metrics")).not.toBeInTheDocument();
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

  it("advances to the next ordered task after Done", async () => {
    const client = fakeClient([
      task("first", "Write the launch brief"),
      task("second", "Review the metrics"),
    ]);
    render(<WorkMode client={client} />);
    await screen.findByText("Write the launch brief");

    fireEvent.click(screen.getByRole("button", { name: "Mark task done" }));

    expect(await screen.findByText("Review the metrics")).toBeInTheDocument();
    expect(screen.queryByText("Write the launch brief")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Mark task done" }));
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
