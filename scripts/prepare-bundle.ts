for (const script of ["build:web", "mcp:build"]) {
  const command = Bun.spawn(["bun", "run", script], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await command.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
