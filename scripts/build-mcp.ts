import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = join(process.cwd(), "packages/mcp/dist");

async function removeTemporaryBuilds() {
  const entries = await readdir(outputDirectory).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".bun-build"))
      .map((entry) => unlink(join(outputDirectory, entry))),
  );
}

await mkdir(outputDirectory, { recursive: true });
await removeTemporaryBuilds();

const build = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    "packages/mcp/src/index.ts",
    "--outfile",
    "packages/mcp/dist/todou-mcp",
  ],
  {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await build.exited;
await removeTemporaryBuilds();

if (exitCode !== 0) {
  process.exit(exitCode);
}
