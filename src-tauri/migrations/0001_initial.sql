PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    bucket TEXT NOT NULL CHECK (bucket IN ('today', 'inbox')),
    priority TEXT NOT NULL CHECK (priority IN ('high', 'low')),
    area TEXT NOT NULL CHECK (area IN ('personal', 'work')),
    due_date TEXT,
    estimate_minutes INTEGER,
    order_key TEXT COLLATE BINARY NOT NULL,
    completed_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title_clock TEXT COLLATE BINARY NOT NULL,
    schedule_clock TEXT COLLATE BINARY NOT NULL,
    priority_clock TEXT COLLATE BINARY NOT NULL,
    area_clock TEXT COLLATE BINARY NOT NULL,
    estimate_clock TEXT COLLATE BINARY NOT NULL,
    order_clock TEXT COLLATE BINARY NOT NULL,
    completion_clock TEXT COLLATE BINARY NOT NULL,
    deletion_clock TEXT COLLATE BINARY NOT NULL,
    CHECK (length(trim(title)) BETWEEN 1 AND 500),
    CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    CHECK (estimate_minutes IS NULL OR estimate_minutes BETWEEN 1 AND 1440)
);

CREATE INDEX IF NOT EXISTS tasks_active_order
    ON tasks(bucket, priority, order_key COLLATE BINARY, id)
    WHERE deleted_at IS NULL AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_logbook
    ON tasks(completed_at DESC, id)
    WHERE deleted_at IS NULL AND completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS outbox (
    local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol_version INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    registers_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'quarantined')),
    created_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS outbox_ready
    ON outbox(status, next_attempt_at, local_sequence);

CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO metadata(key, value) VALUES
    ('local_revision', '0'),
    ('hlc_wall_ms', '0'),
    ('hlc_counter', '0'),
    ('sync_seq', '0');
