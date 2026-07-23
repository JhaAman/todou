CREATE TABLE tasks_next (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    bucket TEXT NOT NULL CHECK (bucket IN ('in_progress', 'today', 'inbox')),
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

INSERT INTO tasks_next (
    id, title, bucket, priority, area, due_date, estimate_minutes, order_key,
    completed_at, deleted_at, created_at, updated_at, title_clock, schedule_clock,
    priority_clock, area_clock, estimate_clock, order_clock, completion_clock, deletion_clock
)
SELECT
    id, title, bucket, priority, area, due_date, estimate_minutes, order_key,
    completed_at, deleted_at, created_at, updated_at, title_clock, schedule_clock,
    priority_clock, area_clock, estimate_clock, order_clock, completion_clock, deletion_clock
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_next RENAME TO tasks;

CREATE INDEX tasks_active_order
    ON tasks(bucket, priority, order_key COLLATE BINARY, id)
    WHERE deleted_at IS NULL AND completed_at IS NULL;

CREATE INDEX tasks_logbook
    ON tasks(completed_at DESC, id)
    WHERE deleted_at IS NULL AND completed_at IS NOT NULL;
