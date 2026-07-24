# Todou

Todou is a local-first, keyboard-driven task manager for macOS. Every action commits to SQLite first, so capture and editing stay instant without a network connection. A resident background worker later reconciles the same list through Supabase; Realtime WebSocket events are used as low-latency wake-ups, while a durable cursor feed repairs anything missed during sleep or offline use.

## What is included

- Combined Home view with a three-task In Progress lane above Today and Inbox, high priority first, and canonical drag ordering.
- Work/personal accents, date-only due dates, small optional estimates, natural-language capture, Logbook, restore, delete, and `Cmd+Z` undo.
- `Cmd+K` commands and editable shortcuts, `Cmd+P` search, eight live-preview dark themes, and a system-wide `Ctrl+Space` quick-entry window.
- Close-to-tray behavior, launch at login, background sync, and one-file JSON export.
- A local MCP server that reads and changes the same SQLite-backed task service.
- Local Supabase schema, idempotent merge RPCs, ordered change feed, bootstrap, and pgTAP contract tests.

## Install the production app

On an Apple-silicon Mac with the Xcode command-line tools, Bun 1.3.14+, and Rust 1.85+ installed, copy this one command:

```sh
git clone https://github.com/JhaAman/todou.git && cd todou && ./scripts/install-macos-app.sh
```

It builds and installs the production app in `~/Applications/Todou.app`, opens it, and configures Git so future worktrees install dependencies automatically. It does not start the development server or local Supabase. To update the installed app later, run these commands from the clone:

```sh
git switch main
git pull --ff-only
./scripts/install-macos-app.sh
```

On first launch, open `Cmd+K` → **Connection settings** and enter the hosted project URL and publishable key. Never use a service-role key or put either value in Git.

> **Security:** the current hosted sync schema has no per-user authorization. Do not use it for sensitive data or share its connection details until authentication and owner-scoped access controls are added.

## Develop

Requirements: Apple-silicon macOS, Bun 1.3.14+, Rust 1.85+, Docker Desktop, and the Xcode command-line tools.

```sh
bun install --frozen-lockfile
bun run supabase:start
bun run dev
```

Tauri starts Vite with hot reload. Todou remains usable if Supabase is stopped or unconfigured.

To connect the local stack, run `bunx supabase status -o env`, then open `Cmd+K` → **Connection settings** and paste:

- `API_URL` as the project URL.
- `ANON_KEY` as the publishable key.

The connection is device-local and is excluded from JSON exports. The same dialog accepts a hosted Supabase project URL and publishable key later.

Useful checks:

```sh
bun run typecheck
bun run test
bun run test:rust
bun run supabase:test
bun run build:web
```

The typecheck and test commands install the exact locked Bun dependencies automatically. `bun run test:rust` also builds its required MCP resource first.

Reset the local remote database and reapply all migrations with `bun run supabase:reset`.

## Hosted Supabase

Create or select a Supabase project, link it with the Supabase CLI, and apply the checked-in migration:

```sh
bunx supabase link --project-ref YOUR_PROJECT_REF
bunx supabase db push
```

Todou intentionally uses a publishable/anonymous key without login for this private single-user deployment. Never put a service-role key in the app.

## MCP

For development, configure a coding agent to launch the TypeScript stdio server:

```json
{
  "mcpServers": {
    "todou": {
      "command": "bun",
      "args": ["/absolute/path/to/todou/packages/mcp/src/index.ts"]
    }
  }
}
```

Or build a standalone Apple-silicon executable with `bun run mcp:build` and use `packages/mcp/dist/todou-mcp` as the command. Packaged apps include the same bridge, so an installed build can be registered with Codex using:

```sh
codex mcp add todou -- /Applications/Todou.app/Contents/Resources/todou-mcp
```

The bridge connects only to Todou's owner-only Unix socket. If Todou is not running, it asks macOS to launch the app in background mode and retries for five seconds.

Available tools cover natural-language quick add, structured create/list/get/update, move, reorder, complete, reopen, delete, and export.

## Package

```sh
bun run build
```

The unsigned DMG is emitted under `src-tauri/target/release/bundle/dmg/`. Code signing, notarization, Intel Macs, and the App Store are intentionally out of scope.

In the development app, `Cmd+K` → **Build production app** runs the same build and opens the resulting DMG. This command is not available in production builds.

Local data lives under `~/Library/Application Support/com.magicproduct.todou/`. Deleting the SQLite database there deletes the local cache and any unsynced work.

## Sync model

A local mutation atomically updates the task, appends a durable outbox operation, and advances a local revision. The Supabase RPC deduplicates mutation UUIDs and merges each task field using persisted hybrid logical clocks. Push acknowledgements never move the pull cursor. Only ordered feed pages do, and snapshot bootstrap repairs an epoch reset or a newly connected device.

That distinction is why Todou stays correct after offline edits: Realtime makes online updates fast, but it is never treated as the only copy of an event.
