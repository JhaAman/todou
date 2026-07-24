import { cp, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const pluginsVersion = "1.3.4";
const repoRoot = resolve(import.meta.dir, "..");
const tempRoot = await mkdtemp(join(tmpdir(), "todou-plugin-validation-"));
const sourceRoot = join(tempRoot, "source");

type JsonObject = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  assert(exitCode === 0, `${command.join(" ")} exited with ${exitCode}`);
}

async function output(command: string[], cwd = repoRoot) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  assert(exitCode === 0, `${command.join(" ")} exited with ${exitCode}`);
  return stdout.trim();
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function commitFixture(message: string) {
  await run(["git", "add", "."], { cwd: sourceRoot });
  await run(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Todou CI",
      "-c",
      "user.email=todou-ci@example.invalid",
      "commit",
      "-m",
      message,
    ],
    { cwd: sourceRoot },
  );
  return output(["git", "rev-parse", "HEAD"], sourceRoot);
}

async function install(target: "codex" | "claude-code", home: string) {
  await run(
    [
      "npx",
      "--yes",
      `plugins@${pluginsVersion}`,
      "add",
      sourceRoot,
      "--target",
      target,
      "--scope",
      "user",
      "--yes",
    ],
    {
      env: {
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        npm_config_update_notifier: "false",
      },
    },
  );
}

async function prepareFakeProductionApp(home: string) {
  const bridge = join(home, "Applications", "Todou.app", "Contents", "Resources", "todou-mcp");
  await mkdir(dirname(bridge), { recursive: true });
  await writeFile(bridge, `#!/usr/bin/env bash\nexec bun "${join(repoRoot, "packages/mcp/src/index.ts")}"\n`);
  await chmod(bridge, 0o755);
}

async function checkMcp(launcher: string, home: string) {
  await prepareFakeProductionApp(home);
  const process = Bun.spawn(["/bin/bash", launcher], {
    env: { ...globalThis.process.env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  let buffer = "";
  const pending = new Map<number, (message: JsonObject) => void>();
  let nextId = 0;
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();

  const readLoop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as JsonObject;
          const id = message.id;
          if (typeof id === "number") {
            pending.get(id)?.(message);
            pending.delete(id);
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  })();

  const request = (method: string, params: JsonObject) =>
    new Promise<JsonObject>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, resolve);
      process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, 10_000);
    });

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "todou-plugin-validation", version: "1.0.0" },
    });
    const initializeResult = initialized.result as JsonObject | undefined;
    const serverInfo = initializeResult?.serverInfo as JsonObject | undefined;
    assert(serverInfo?.name === "todou", "Installed launcher did not initialize the Todou MCP server");
    process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

    const listed = await request("tools/list", {});
    const toolsResult = listed.result as JsonObject | undefined;
    const tools = toolsResult?.tools as JsonObject[] | undefined;
    const names = new Set(tools?.map((tool) => tool.name));
    for (const name of ["list_tasks", "create_task", "delete_task"]) {
      assert(names.has(name), `Installed launcher is missing ${name}`);
    }
  } finally {
    process.kill();
    await readLoop;
  }
}

try {
  const marketplace = await readJson(join(repoRoot, "marketplace.json"));
  const marketplacePlugins = marketplace.plugins as JsonObject[] | undefined;
  assert(marketplacePlugins?.[0]?.version === undefined, "Marketplace plugin version must use the Git commit SHA");

  const manifest = await readJson(join(repoRoot, "plugin", "todou", ".plugin", "plugin.json"));
  assert(manifest.version === undefined, "Plugin manifest version must use the Git commit SHA");

  await mkdir(sourceRoot, { recursive: true });
  await cp(join(repoRoot, "marketplace.json"), join(sourceRoot, "marketplace.json"));
  await cp(join(repoRoot, "plugin"), join(sourceRoot, "plugin"), { recursive: true });
  await run(["git", "init", "-b", "main"], { cwd: sourceRoot });
  const firstCommit = await commitFixture("test: initial plugin");

  await run(
    ["npx", "--yes", `plugins@${pluginsVersion}`, "discover", sourceRoot],
    {
      env: {
        HOME: join(tempRoot, "discover-home"),
        XDG_CACHE_HOME: join(tempRoot, "discover-home", ".cache"),
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        npm_config_update_notifier: "false",
      },
    },
  );

  const codexHome = join(tempRoot, "codex-home");
  const claudeHome = join(tempRoot, "claude-home");
  await install("codex", codexHome);
  await install("claude-code", claudeHome);

  await writeFile(join(sourceRoot, "plugin", "todou", ".update-probe"), "second commit\n");
  const secondCommit = await commitFixture("test: update plugin");
  assert(firstCommit !== secondCommit, "Update fixture did not produce a new Git commit");
  await install("codex", codexHome);
  await install("claude-code", claudeHome);

  const codexCache = join(codexHome, ".codex", "plugins", "cache", "todou", "todou", secondCommit);
  const codexConfig = await readFile(join(codexHome, ".codex", "config.toml"), "utf8");
  assert(codexConfig.includes('[plugins."todou@plugins-cli"]'), "Codex did not enable the installed plugin");
  const codexMcp = await readJson(join(codexCache, ".mcp.json"));
  assert(JSON.stringify(codexMcp).includes("${CODEX_PLUGIN_ROOT}"), "Codex plugin root was not translated");

  const knownMarketplaces = await readJson(join(claudeHome, ".claude", "plugins", "known_marketplaces.json"));
  const todouMarketplace = knownMarketplaces.todou as JsonObject | undefined;
  assert(todouMarketplace?.autoUpdate === true, "Claude Code marketplace auto-update was not enabled");
  const installedPlugins = await readJson(join(claudeHome, ".claude", "plugins", "installed_plugins.json"));
  const claudeEntries = (installedPlugins.plugins as JsonObject | undefined)?.["todou@todou"] as
    | JsonObject[]
    | undefined;
  assert(claudeEntries?.[0]?.gitCommitSha === secondCommit, "Claude Code did not install the updated Git commit");
  const claudeCache = claudeEntries[0]?.installPath;
  assert(typeof claudeCache === "string", "Claude Code plugin cache path is missing");
  const claudeMcp = await readJson(join(claudeCache, ".mcp.json"));
  assert(JSON.stringify(claudeMcp).includes("${CLAUDE_PLUGIN_ROOT}"), "Claude plugin root was not translated");

  await checkMcp(join(codexCache, "scripts", "run-production-mcp.sh"), codexHome);
  await checkMcp(join(claudeCache, "scripts", "run-production-mcp.sh"), claudeHome);
  console.log("Plugin discovery, Codex/Claude install-update, and MCP initialize/tools-list passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
