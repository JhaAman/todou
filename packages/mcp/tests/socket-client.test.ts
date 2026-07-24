import { mkdtemp, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { launchTodou, TodouLocalClient } from "../src/socket-client";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess =
    await importOriginal<typeof import("node:child_process")>();
  return {
    ...childProcess,
    default: { ...childProcess, spawn: spawnMock },
    spawn: spawnMock,
  };
});

type Request = {
  id: string;
  method: string;
  params: unknown;
};

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  delete process.env.TODOU_APP_BUNDLE_PATH;
  delete process.env.TODOU_APP_PATH;
  vi.restoreAllMocks();
  spawnMock.mockReset();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function listen(
  respond: (request: Request) => unknown,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "todou-mcp-test-"));
  const socketPath = join(directory, "todou.sock");
  directories.push(directory);

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      const request = JSON.parse(buffer.slice(0, newline)) as Request;
      socket.write(`${JSON.stringify(respond(request))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  servers.push(server);
  return socketPath;
}

describe("TodouLocalClient", () => {
  it("delegates a configured app executable launch to its exact bundle", () => {
    process.env.TODOU_APP_PATH =
      "/Applications/Todou.app/Contents/MacOS/todou";
    const child = { once: vi.fn(), unref: vi.fn() };
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    launchTodou();

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/open",
      [
        "-gj",
        "/Applications/Todou.app",
        "--args",
        "--background",
      ],
      { detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("does not substitute another app for an invalid configured path", () => {
    process.env.TODOU_APP_PATH = "/tmp/todou";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    launchTodou();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("sends one JSON-line request and preserves the revision envelope", async () => {
    let received: Request | undefined;
    const socketPath = await listen((request) => {
      received = request;
      return {
        id: request.id,
        ok: true,
        result: { id: "task-1", dueDate: null },
        revision: 12,
      };
    });

    const response = await new TodouLocalClient(socketPath).call(
      "getTask",
      { id: "task-1" },
    );

    expect(received).toMatchObject({
      method: "getTask",
      params: { id: "task-1" },
    });
    expect(response).toEqual({
      result: { id: "task-1", dueDate: null },
      revision: 12,
    });
  });

  it("turns a failed local response into a stable Todou error", async () => {
    const socketPath = await listen((request) => ({
      id: request.id,
      ok: false,
      error: {
        code: "not_found",
        message: "Task not found",
        details: { taskId: "missing" },
      },
    }));

    const request = new TodouLocalClient(socketPath).call("getTask", {
      id: "missing",
    });

    await expect(request).rejects.toMatchObject({
      name: "TodouLocalError",
      code: "not_found",
      message: "Task not found",
      details: { taskId: "missing" },
    });
  });

  it("rejects a success response without a valid revision", async () => {
    const socketPath = await listen((request) => ({
      id: request.id,
      ok: true,
      result: { id: "task-1" },
    }));

    const request = new TodouLocalClient(socketPath).call("getTask", {
      id: "task-1",
    });

    await expect(request).rejects.toMatchObject({
      name: "TodouLocalError",
      code: "protocol_mismatch",
      message: "Todou returned an invalid local revision.",
    });
  });
});
