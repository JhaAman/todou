import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../lib/types";
import { WorkMode, type WorkModeClient } from "./WorkMode";
import type { WorkSessionSnapshot } from "./workSession";

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

function snapshot(taskId: string): WorkSessionSnapshot {
  return {
    version: 1,
    taskId,
    durationMs: 30 * 60_000,
    remainingMs: 30 * 60_000,
    status: "running",
    checkpointWallTimeMs: Date.now(),
    zeroNotified: false,
  };
}

function fakeClient(tasks: Task[]): WorkModeClient & {
  emitSession: (session: WorkSessionSnapshot | null) => void;
  emitTasks: () => void;
} {
  let sessionListener: ((session: WorkSessionSnapshot | null) => void) | null = null;
  let taskListener: (() => void) | null = null;
  return {
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
    startWorkMode: vi.fn(async () => snapshot(tasks[0]?.id ?? "")),
    loadWorkModeSession: vi.fn(async () => snapshot(tasks[0]?.id ?? "")),
    checkpointWorkModeSession: vi.fn(async (session) => session),
    subscribeWorkModeSession: vi.fn(async (listener) => {
      sessionListener = listener;
      return () => {
        sessionListener = null;
      };
    }),
    getSystemActivitySample: vi.fn(async () => ({
      idleMs: 0,
      awakeTimeMs: 0,
    })),
    stopWorkMode: vi.fn(async () => undefined),
    emitSession: (session) => sessionListener?.(session),
    emitTasks: () => taskListener?.(),
  };
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

  it("persists a manual pause and offers resume", async () => {
    const client = fakeClient([task("first", "Write the launch brief")]);
    render(<WorkMode client={client} />);
    await screen.findByText("Write the launch brief");

    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));

    expect(await screen.findByRole("button", { name: "Resume timer" })).toBeInTheDocument();
    await waitFor(() => {
      expect(client.checkpointWorkModeSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "manual-paused" }),
      );
    });
  });

  it("waits for an in-flight checkpoint before stopping", async () => {
    const client = fakeClient([task("first", "Write the launch brief")]);
    let releaseCheckpoint: (() => void) | undefined;
    vi.mocked(client.checkpointWorkModeSession).mockImplementation(
      (session) => new Promise((resolve) => {
        releaseCheckpoint = () => resolve(session);
      }),
    );
    render(<WorkMode client={client} />);
    await screen.findByText("Write the launch brief");

    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
    await waitFor(() => {
      expect(client.checkpointWorkModeSession).toHaveBeenCalled();
    });

    const stopButton = screen.getByRole("button", { name: "Stop work mode" });
    await waitFor(() => expect(stopButton).toBeEnabled());
    fireEvent.click(stopButton);
    expect(client.stopWorkMode).not.toHaveBeenCalled();

    releaseCheckpoint?.();
    await waitFor(() => {
      expect(client.stopWorkMode).toHaveBeenCalledOnce();
    });
  });

  it("does not let an older Stop response clear a newly started session", async () => {
    const tasks = [
      task("first", "Write the launch brief"),
      task("second", "Start the next project"),
    ];
    const client = fakeClient(tasks);
    vi.mocked(client.stopWorkMode).mockImplementation(async () => {
      client.emitSession(null);
      tasks.shift();
      client.emitSession(snapshot("second"));
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

  it("uses the task that the new native session actually started", async () => {
    const first = task("first", "Write the launch brief");
    const staleNext = task("second", "Review the metrics");
    const actualNext = task("third", "Ship the release");
    const client = fakeClient([first, staleNext]);
    vi.mocked(client.listTasks)
      .mockResolvedValue([actualNext])
      .mockResolvedValueOnce([first, staleNext])
      .mockResolvedValueOnce([staleNext])
      .mockResolvedValueOnce([actualNext]);
    vi.mocked(client.startWorkMode).mockResolvedValue(snapshot(actualNext.id));

    render(<WorkMode client={client} />);
    await screen.findByText(first.title);

    fireEvent.click(screen.getByRole("button", { name: "Mark task done" }));

    expect(await screen.findByText(actualNext.title)).toBeInTheDocument();
    expect(screen.queryByText(staleNext.title)).not.toBeInTheDocument();
  });

  it("can start a fresh session after finishing every task", async () => {
    const tasks = [task("first", "Finish the launch brief")];
    const client = fakeClient(tasks);
    render(<WorkMode client={client} />);
    await screen.findByText("Finish the launch brief");

    fireEvent.click(screen.getByRole("button", { name: "Mark task done" }));
    expect(await screen.findByText("All done")).toBeInTheDocument();
    await waitFor(() => expect(client.stopWorkMode).toHaveBeenCalled(), {
      timeout: 2_500,
    });

    tasks.push(task("second", "Start the next project"));
    client.emitSession(snapshot("second"));

    expect(await screen.findByText("Start the next project")).toBeInTheDocument();
    expect(screen.queryByText("All done")).not.toBeInTheDocument();
  });
});
