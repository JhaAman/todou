# Todou engineering notes

## Architecture

- The resident Tauri process is the only SQLite writer. React uses Tauri IPC; the MCP stdio bridge uses the owner-only Unix socket at `~/Library/Application Support/com.magicproduct.todou/todou.sock`.
- The root `marketplace.json` indexes the small cross-agent bundle under `plugin/todou`. Its MCP launcher must target the installed production app, support both `~/Applications` and `/Applications`, and use `${PLUGIN_ROOT}` so the `plugins` CLI can translate paths for each agent.
- The MCP bridge must delegate GUI startup to LaunchServices; directly executing the app binary from an agent sandbox makes AppKit abort during registration.
- Every task mutation commits the materialized row, HLC-stamped outbox registers, and local revision in one SQLite transaction.
- Rust owns HTTPS push/pull/bootstrap correctness. `supabase-js` subscribes to `public.sync_changes` only to wake that worker. Realtime delivery is never a cursor or source of truth.
- Supabase RPC acknowledgements merge registers and clear one outbox row but never advance the feed cursor. Applying an ordered pull page and advancing its cursor is one local transaction.
- Task deletion is a hidden synchronized tombstone. Never physically delete remote task rows or add a trash UI without redesigning offline garbage collection.

## Invariants

- `in_progress`, `today`, and `inbox` are exclusive. In Progress holds at most three active tasks. Moving to Inbox clears `dueDate`; setting a due date on or before the local date moves an Inbox task to Today.
- New task creation ignores the invoking view: non-In Progress tasks start in Inbox unless due on or before the local date; `/today` and Quick Entry's Today control save today's date.
- Sort by bucket, then high before low, then bytewise `orderKey`, then UUID. Do not add a list-wide order-key rebalance.
- `{bucket, due_date}` is the single remote `schedule` register. PostgreSQL JSON uses `due_date`; public Rust/TypeScript task objects serialize as `dueDate`.
- Preferences and Supabase credentials stay device-local. Hosted access uses only a publishable/anonymous key, never a service-role key.
- OpenAI/Anthropic keys are write-only renderer inputs stored unencrypted in private SQLite metadata. They never sync or export; the shared app identifier makes the same values available to installed and dev builds on this Mac.
- Every local task create enqueues a device-local LLM dedupe job in the same transaction. Main-window entry wakes it immediately; Quick Entry and MCP jobs drain on the next main-window focus. Remote sync imports never enqueue.
- Manual dedupe scans wait behind automatic drains, enqueue only missing active-task jobs, and replace stale suggestions for the same task pair.
- Tauri commands may be bare values or `Revisioned<T>` during internal refactors; the frontend compatibility unwrapping currently accepts both. The Unix socket always returns `{id, ok, result, revision}`.
- On macOS, keep the main window's `dragDropEnabled` false so WKWebView receives Todou's HTML5 task-drag events.
- Work Mode uses the hidden `work-mode` webview plus device-local `work_mode_state_v2` metadata. Rust owns active-state persistence and window/focus integration, including geometry in logical macOS points.
- Work Mode shows all active In Progress tasks in canonical order, up to the three-task limit.

## Commands

```sh
bun run dev                 # Tauri + Vite HMR
bun run typecheck
bun run test
bun run test:rust
bun run supabase:test
bun run build:web
bun run build               # unsigned DMG
bun run mcp:build
```

The MCP Unix-socket tests need permission to bind a temporary socket; a restricted sandbox can fail them with `EPERM` even when the implementation is correct.
The Tauri dev hook builds `packages/mcp/dist/todou-mcp` before starting Vite because Tauri validates bundle resources in dev mode.
The dev-app production build uses `scripts/install-macos-app.sh` to install the app directly and clean up mounted Todou installer volumes; regular `bun run build` keeps the styled DMG.

## Change guidance

- Keep the package versions exact. Before installing or upgrading any package, verify that release is at least 48 hours old.
- Preserve app identifier `com.magicproduct.todou`; it determines both the native data directory and MCP socket path.
- Test domain behavior through the real temporary SQLite service and Supabase RPCs. Do not mock away transactions, HLC merge, cursor movement, or idempotency.
- Supabase identifies applied migrations by timestamp; never reuse a migration timestamp across branches.
- Hosted Supabase migrations are manual; apply checked-in migrations before shipping a client that requires their advertised sync capability.
- Keep sync diagnostics compact in the primary UI. The sidebar status may show a lightweight summary; configuration and full diagnostics belong in Settings/commands.
