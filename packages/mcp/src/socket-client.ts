import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

export type LocalError = {
  code: string;
  message: string;
  details?: unknown;
};

type LocalWireResponse<T> =
  | { id: string; ok: true; result: T; revision: number }
  | { id: string; ok: false; error: LocalError };

export type LocalResult<T> = {
  result: T;
  revision: number;
};

export class TodouLocalError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(error: LocalError) {
    super(error.message);
    this.name = "TodouLocalError";
    this.code = error.code;
    this.details = error.details;
  }
}

function defaultSocketPath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "com.magicproduct.todou",
    "todou.sock",
  );
}

function configuredAppBundlePath(): string | undefined {
  const configuredPath =
    process.env.TODOU_APP_BUNDLE_PATH ?? process.env.TODOU_APP_PATH;
  if (!configuredPath) return undefined;
  if (/\.app$/i.test(configuredPath)) return configuredPath;
  return configuredPath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/i)?.[1];
}

export function launchTodou(): void {
  const appBundle = configuredAppBundlePath();
  if (!appBundle) {
    console.error(
      "Todou could not be launched: configure TODOU_APP_BUNDLE_PATH with the installed .app path",
    );
    return;
  }
  const child = spawn(
    "/usr/bin/open",
    ["-gj", appBundle, "--args", "--background"],
    { detached: true, stdio: "ignore" },
  );

  child.once("error", (error) => {
    console.error(`Todou launch failed: ${error.message}`);
  });
  child.once("exit", (code) => {
    if (code) console.error(`Todou launch failed: open exited with ${code}`);
  });
  child.unref();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sendLocalRequest<T>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<LocalResult<T>> {
  const requestId = randomUUID();

  return new Promise<LocalResult<T>>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;

    const finish = (error?: Error, result?: LocalResult<T>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result as LocalResult<T>);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => {
      finish(new TodouLocalError({
        code: "todou_unavailable",
        message: "Todou did not answer the local request within five seconds.",
      }));
    });

    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      finish(new TodouLocalError({
        code: "todou_unavailable",
        message: "Todou closed the local connection before returning a response.",
      }));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;

      try {
        const response = JSON.parse(buffer.slice(0, newline)) as LocalWireResponse<T>;
        if (response.id !== requestId) {
          finish(new TodouLocalError({
            code: "protocol_mismatch",
            message: "Todou returned a mismatched local request id.",
          }));
        } else if (!response.ok) {
          finish(new TodouLocalError(response.error));
        } else if (!Number.isSafeInteger(response.revision) || response.revision < 0) {
          finish(new TodouLocalError({
            code: "protocol_mismatch",
            message: "Todou returned an invalid local revision.",
          }));
        } else {
          finish(undefined, {
            result: response.result,
            revision: response.revision,
          });
        }
      } catch (error) {
        finish(
          error instanceof TodouLocalError
            ? error
            : new TodouLocalError({
                code: "protocol_mismatch",
                message: "Todou returned a malformed local response.",
                details: error instanceof Error ? error.message : String(error),
              }),
        );
      }
    });
  });
}

function canRetry(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ECONNREFUSED"].includes(String(error.code)),
  );
}

export class TodouLocalClient {
  readonly socketPath: string;

  constructor(socketPath = process.env.TODOU_SOCKET_PATH ?? defaultSocketPath()) {
    this.socketPath = socketPath;
  }

  async call<T>(method: string, params: unknown = {}): Promise<LocalResult<T>> {
    try {
      return await sendLocalRequest<T>(this.socketPath, method, params);
    } catch (error) {
      if (!canRetry(error)) throw error;
    }

    launchTodou();
    const deadline = Date.now() + 5_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      await delay(100);
      try {
        return await sendLocalRequest<T>(this.socketPath, method, params);
      } catch (error) {
        lastError = error;
        if (!canRetry(error)) throw error;
      }
    }

    throw new TodouLocalError({
      code: "todou_unavailable",
      message: "Todou could not be started or reached through its local socket.",
      details: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }
}
