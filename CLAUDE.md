# Todou engineering notes

## Architecture

- The resident Tauri process is the only SQLite writer. React uses Tauri IPC; the MCP stdio bridge uses the owner-only Unix socket at `~/Library/Application Support/com.magicproduct.todou/todou.sock`.
- Every task mutation commits the materialized row, HLC-stamped outbox registers, and local revision in one SQLite transaction.
- Rust owns HTTPS push/pull/bootstrap correctness. `supabase-js` subscribes to `public.sync_changes` only to wake that worker. Realtime delivery is never a cursor or source of truth.
- Supabase RPC acknowledgements merge registers and clear one outbox row but never advance the feed cursor. Applying an ordered pull page and advancing its cursor is one local transaction.
- Task deletion is a hidden synchronized tombstone. Never physically delete remote task rows or add a trash UI without redesigning offline garbage collection.

## Invariants

- `today` and `inbox` are exclusive. Moving to Inbox clears `dueDate`; setting a due date on or before the local date moves the task to Today.
- Sort by bucket, then high before low, then bytewise `orderKey`, then UUID. Do not add a list-wide order-key rebalance.
- `{bucket, due_date}` is the single remote `schedule` register. PostgreSQL JSON uses `due_date`; public Rust/TypeScript task objects serialize as `dueDate`.
- Preferences and Supabase credentials stay device-local. Hosted access uses only a publishable/anonymous key, never a service-role key.
- Tauri commands may be bare values or `Revisioned<T>` during internal refactors; the frontend compatibility unwrapping currently accepts both. The Unix socket always returns `{id, ok, result, revision}`.

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
The dev-app production build sets `CI=true` so Tauri skips its temporary Finder-based DMG styling pass; regular `bun run build` keeps the styled DMG.

## Change guidance

- Keep the package versions exact. Before installing or upgrading any package, verify that release is at least 48 hours old.
- Preserve app identifier `com.magicproduct.todou`; it determines both the native data directory and MCP socket path.
- Test domain behavior through the real temporary SQLite service and Supabase RPCs. Do not mock away transactions, HLC merge, cursor movement, or idempotency.
- Keep sync state out of the primary UI. Diagnostics may be exposed only through Settings/commands.
