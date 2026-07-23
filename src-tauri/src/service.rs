use crate::{
    domain::{
        parse_due_date, validate_due_date, validate_estimate, Area, BootstrapPayload, Bucket,
        CreateTaskInput, ExportSnapshot, ExportTask, MergeSummary, NullablePatch, OutboxMutation,
        Priority, RegisterMap, RemotePage, Revisioned, StampedValue, SyncCursor, Task, TaskClocks,
        TaskFilter, UpdateTaskPatch, PROTOCOL_VERSION,
    },
    error::{AppError, AppResult, ErrorCode},
    hlc::{self, ClockSource, Hlc, HlcState},
    order_key,
};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    str::FromStr,
    sync::Arc,
    time::Duration as StdDuration,
};
use uuid::Uuid;

const MIGRATION_1: &str = include_str!("../migrations/0001_initial.sql");
const MIGRATION_2: &str = include_str!("../migrations/0002_add_in_progress_bucket.sql");
const IN_PROGRESS_TASK_LIMIT: i64 = 3;
const TASK_COLUMNS: &str = "id, title, bucket, priority, area, due_date, estimate_minutes, \
    order_key, completed_at, deleted_at, created_at, updated_at, title_clock, schedule_clock, \
    priority_clock, area_clock, estimate_clock, order_clock, completion_clock, deletion_clock";
const REGISTER_NAMES: [&str; 8] = [
    "title",
    "schedule",
    "priority",
    "area",
    "estimate",
    "order",
    "completion",
    "deletion",
];

#[derive(Clone)]
pub struct TaskService {
    inner: Arc<Inner>,
}

struct Inner {
    connection: Mutex<Connection>,
    clock: Arc<dyn ClockSource>,
}

impl TaskService {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        Self::open_with_clock(path, hlc::system_clock())
    }

    pub fn open_with_clock(path: impl AsRef<Path>, clock: Arc<dyn ClockSource>) -> AppResult<Self> {
        if let Some(parent) = path.as_ref().parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path).map_err(AppError::from)?;
        Self::from_connection(connection, clock)
    }

    pub fn in_memory_with_clock(clock: Arc<dyn ClockSource>) -> AppResult<Self> {
        let connection = Connection::open_in_memory().map_err(AppError::from)?;
        Self::from_connection(connection, clock)
    }

    fn from_connection(mut connection: Connection, clock: Arc<dyn ClockSource>) -> AppResult<Self> {
        connection
            .busy_timeout(StdDuration::from_secs(5))
            .map_err(AppError::from)?;
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(AppError::from)?;
        run_migrations(&mut connection, clock.now_millis())?;
        ensure_device_id(&connection)?;
        Ok(Self {
            inner: Arc::new(Inner {
                connection: Mutex::new(connection),
                clock,
            }),
        })
    }

    pub fn revision(&self) -> AppResult<u64> {
        let connection = self.inner.connection.lock();
        read_revision(&connection)
    }

    pub fn cursor(&self) -> AppResult<SyncCursor> {
        let connection = self.inner.connection.lock();
        read_cursor(&connection)
    }

    pub fn create_task(&self, input: CreateTaskInput) -> AppResult<Revisioned<Task>> {
        let title = crate::domain::normalize_title(&input.title)?;
        validate_due_date(input.due_date.as_deref())?;
        validate_estimate(input.estimate_minutes)?;
        let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        validate_uuid(&id, "id")?;

        let local_date = self.inner.clock.local_date();
        let mut bucket = input.bucket;
        if bucket == Bucket::Inbox
            && input
                .due_date
                .as_deref()
                .map(parse_due_date)
                .transpose()?
                .is_some_and(|date| date <= local_date)
        {
            bucket = Bucket::Today;
        }

        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        if load_task(&transaction, &id)?.is_some() {
            return Err(AppError::invalid_input("task id already exists"));
        }
        if bucket == Bucket::InProgress {
            ensure_in_progress_capacity(&transaction, None)?;
        }
        let order_key = next_tier_key(&transaction, bucket, input.priority, None)?;
        let stamp = next_stamp(&transaction, now_ms)?;
        let task = Task {
            id,
            title,
            bucket,
            priority: input.priority,
            area: input.area,
            due_date: input.due_date,
            estimate_minutes: input.estimate_minutes,
            order_key,
            completed_at: None,
            deleted_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            clocks: TaskClocks::all(stamp),
        };
        task.validate()?;
        insert_task(&transaction, &task)?;
        enqueue_registers(&transaction, &task, &REGISTER_NAMES, &now)?;
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(task, revision))
    }

    pub fn update_task(&self, id: &str, patch: UpdateTaskPatch) -> AppResult<Revisioned<Task>> {
        validate_uuid(id, "id")?;
        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let local_date = self.inner.clock.local_date();
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let mut task = require_visible_task(&transaction, id)?;
        let previous_bucket = task.bucket;
        let previous_priority = task.priority;
        let mut changed = BTreeSet::new();

        if let Some(title) = patch.title {
            let title = crate::domain::normalize_title(&title)?;
            if task.title != title {
                task.title = title;
                changed.insert("title");
            }
        }
        if let Some(priority) = patch.priority {
            if task.priority != priority {
                task.priority = priority;
                changed.insert("priority");
            }
        }
        if let Some(area) = patch.area {
            if task.area != area {
                task.area = area;
                changed.insert("area");
            }
        }
        match patch.due_date {
            NullablePatch::Missing => {}
            NullablePatch::Null => {
                if task.due_date.take().is_some() {
                    changed.insert("schedule");
                }
            }
            NullablePatch::Value(due_date) => {
                let date = parse_due_date(&due_date)?;
                if task.due_date.as_deref() != Some(due_date.as_str()) {
                    task.due_date = Some(due_date);
                    changed.insert("schedule");
                }
                if date <= local_date && task.bucket == Bucket::Inbox {
                    task.bucket = Bucket::Today;
                    changed.insert("schedule");
                }
            }
        }
        match patch.estimate_minutes {
            NullablePatch::Missing => {}
            NullablePatch::Null => {
                if task.estimate_minutes.take().is_some() {
                    changed.insert("estimate");
                }
            }
            NullablePatch::Value(minutes) => {
                validate_estimate(Some(minutes))?;
                if task.estimate_minutes != Some(minutes) {
                    task.estimate_minutes = Some(minutes);
                    changed.insert("estimate");
                }
            }
        }

        if task.bucket != previous_bucket || task.priority != previous_priority {
            task.order_key = next_tier_key(
                &transaction,
                task.bucket,
                task.priority,
                Some(task.id.as_str()),
            )?;
            changed.insert("order");
        }
        if changed.is_empty() {
            let revision = read_revision(&transaction)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(Revisioned::new(task, revision));
        }

        let stamp = next_stamp(&transaction, now_ms)?;
        apply_clock(&mut task.clocks, &changed, &stamp);
        task.updated_at = now.clone();
        task.validate()?;
        update_task_row(&transaction, &task)?;
        let changed_names = changed.into_iter().collect::<Vec<_>>();
        enqueue_registers(&transaction, &task, &changed_names, &now)?;
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(task, revision))
    }

    pub fn move_task(&self, id: &str, bucket: Bucket) -> AppResult<Revisioned<Task>> {
        validate_uuid(id, "id")?;
        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let mut task = require_active_task(&transaction, id)?;
        let bucket_changed = task.bucket != bucket;
        let due_cleared = bucket == Bucket::Inbox && task.due_date.take().is_some();
        if !bucket_changed && !due_cleared {
            let revision = read_revision(&transaction)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(Revisioned::new(task, revision));
        }

        if bucket_changed && bucket == Bucket::InProgress {
            ensure_in_progress_capacity(&transaction, Some(task.id.as_str()))?;
        }

        task.bucket = bucket;
        let mut changed = BTreeSet::from(["schedule"]);
        if bucket_changed {
            task.order_key = next_tier_key(
                &transaction,
                task.bucket,
                task.priority,
                Some(task.id.as_str()),
            )?;
            changed.insert("order");
        }
        let stamp = next_stamp(&transaction, now_ms)?;
        apply_clock(&mut task.clocks, &changed, &stamp);
        task.updated_at = now.clone();
        update_task_row(&transaction, &task)?;
        let changed_names = changed.into_iter().collect::<Vec<_>>();
        enqueue_registers(&transaction, &task, &changed_names, &now)?;
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(task, revision))
    }

    pub fn reorder_task(
        &self,
        id: &str,
        before_id: Option<&str>,
        after_id: Option<&str>,
    ) -> AppResult<Revisioned<Vec<Task>>> {
        validate_uuid(id, "id")?;
        if let Some(value) = before_id {
            validate_uuid(value, "beforeId")?;
        }
        if let Some(value) = after_id {
            validate_uuid(value, "afterId")?;
        }
        if before_id == Some(id) || after_id == Some(id) || before_id == after_id {
            return Err(AppError::new(
                ErrorCode::InvalidAnchor,
                "reorder anchors cannot reference the moving task or each other",
            ));
        }

        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let mut task = require_active_task(&transaction, id)?;
        let tier = load_active_tier(&transaction, task.bucket, task.priority, Some(id))?;
        let (lower, upper) = validate_anchors(&tier, before_id, after_id)?;
        task.order_key = order_key::between(
            lower.map(|value| value.order_key.as_str()),
            upper.map(|value| value.order_key.as_str()),
        )?;
        let stamp = next_stamp(&transaction, now_ms)?;
        task.clocks.order = stamp;
        task.updated_at = now.clone();
        update_task_row(&transaction, &task)?;
        enqueue_registers(&transaction, &task, &["order"], &now)?;
        let revision = bump_revision(&transaction)?;
        let mut result = load_active_tier(&transaction, task.bucket, task.priority, None)?;
        transaction.commit().map_err(AppError::from)?;
        sort_active(&mut result);
        Ok(Revisioned::new(result, revision))
    }

    pub fn complete_task(&self, id: &str) -> AppResult<Revisioned<Task>> {
        self.set_completion(id, true)
    }

    pub fn restore_task(&self, id: &str) -> AppResult<Revisioned<Task>> {
        self.set_completion(id, false)
    }

    fn set_completion(&self, id: &str, complete: bool) -> AppResult<Revisioned<Task>> {
        validate_uuid(id, "id")?;
        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let local_date = self.inner.clock.local_date();
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let mut task = require_visible_task(&transaction, id)?;
        if complete == task.completed_at.is_some() {
            return Err(AppError::new(
                ErrorCode::InvalidTransition,
                if complete {
                    "task is already complete"
                } else {
                    "task is not complete"
                },
            ));
        }

        let mut changed = BTreeSet::from(["completion"]);
        if !complete && task.bucket == Bucket::InProgress {
            ensure_in_progress_capacity(&transaction, Some(task.id.as_str()))?;
        }
        task.completed_at = complete.then(|| now.clone());
        if !complete
            && task.bucket == Bucket::Inbox
            && task
                .due_date
                .as_deref()
                .map(parse_due_date)
                .transpose()?
                .is_some_and(|date| date <= local_date)
        {
            task.bucket = Bucket::Today;
            task.order_key = next_tier_key(
                &transaction,
                task.bucket,
                task.priority,
                Some(task.id.as_str()),
            )?;
            changed.insert("schedule");
            changed.insert("order");
        }
        let stamp = next_stamp(&transaction, now_ms)?;
        apply_clock(&mut task.clocks, &changed, &stamp);
        task.updated_at = now.clone();
        update_task_row(&transaction, &task)?;
        let changed_names = changed.into_iter().collect::<Vec<_>>();
        enqueue_registers(&transaction, &task, &changed_names, &now)?;
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(task, revision))
    }

    pub fn delete_task(&self, id: &str) -> AppResult<Revisioned<()>> {
        self.set_deletion(id, true)
            .map(|result| Revisioned::new((), result.revision))
    }

    pub fn undo_delete(&self, id: &str) -> AppResult<Revisioned<Task>> {
        self.set_deletion(id, false)
    }

    fn set_deletion(&self, id: &str, delete: bool) -> AppResult<Revisioned<Task>> {
        validate_uuid(id, "id")?;
        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let mut task = load_task(&transaction, id)?.ok_or_else(|| AppError::not_found(id))?;
        if delete == task.deleted_at.is_some() {
            return Err(AppError::new(
                if delete {
                    ErrorCode::Deleted
                } else {
                    ErrorCode::InvalidTransition
                },
                if delete {
                    "task is already deleted"
                } else {
                    "task is not deleted"
                },
            ));
        }
        if !delete && task.bucket == Bucket::InProgress {
            ensure_in_progress_capacity(&transaction, Some(task.id.as_str()))?;
        }
        task.deleted_at = delete.then(|| now.clone());
        let stamp = next_stamp(&transaction, now_ms)?;
        task.clocks.deletion = stamp;
        task.updated_at = now.clone();
        update_task_row(&transaction, &task)?;
        enqueue_registers(&transaction, &task, &["deletion"], &now)?;
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(task, revision))
    }

    pub fn rollover_due(&self, local_date: &str) -> AppResult<Revisioned<Vec<Task>>> {
        let local_date = parse_due_date(local_date)?;
        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let mut due = Vec::new();
        for task in load_all_tasks(&transaction)? {
            if task.is_active() && task.bucket == Bucket::Inbox {
                if let Some(date) = task.due_date.as_deref().map(parse_due_date).transpose()? {
                    if date <= local_date {
                        due.push(task);
                    }
                }
            }
        }
        due.sort_by(|left, right| left.id.cmp(&right.id));

        let mut moved = Vec::with_capacity(due.len());
        for mut task in due {
            task.bucket = Bucket::Today;
            task.order_key = next_tier_key(
                &transaction,
                Bucket::Today,
                task.priority,
                Some(task.id.as_str()),
            )?;
            let stamp = next_stamp(&transaction, now_ms)?;
            task.clocks.schedule = stamp.clone();
            task.clocks.order = stamp;
            task.updated_at = now.clone();
            update_task_row(&transaction, &task)?;
            enqueue_registers(&transaction, &task, &["schedule", "order"], &now)?;
            moved.push(task);
        }

        let revision = if moved.is_empty() {
            read_revision(&transaction)?
        } else {
            bump_revision(&transaction)?
        };
        transaction.commit().map_err(AppError::from)?;
        sort_active(&mut moved);
        Ok(Revisioned::new(moved, revision))
    }

    pub fn rollover_current_date(&self) -> AppResult<Revisioned<Vec<Task>>> {
        self.rollover_due(&self.inner.clock.local_date().format("%Y-%m-%d").to_string())
    }

    pub fn get_task(&self, id: &str) -> AppResult<Revisioned<Task>> {
        validate_uuid(id, "id")?;
        let connection = self.inner.connection.lock();
        let task = require_visible_task(&connection, id)?;
        Ok(Revisioned::new(task, read_revision(&connection)?))
    }

    pub fn list_tasks(&self, filter: TaskFilter) -> AppResult<Revisioned<Vec<Task>>> {
        validate_due_date(filter.due_date.as_deref())?;
        let connection = self.inner.connection.lock();
        let needle = filter
            .text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let needle = needle.map(|value| value.to_lowercase());
        let mut tasks = load_all_tasks(&connection)?
            .into_iter()
            .filter(|task| filter.include_deleted || task.deleted_at.is_none())
            .filter(|task| {
                filter
                    .completed
                    .is_none_or(|completed| task.completed_at.is_some() == completed)
            })
            .filter(|task| filter.bucket.is_none_or(|value| task.bucket == value))
            .filter(|task| filter.priority.is_none_or(|value| task.priority == value))
            .filter(|task| filter.area.is_none_or(|value| task.area == value))
            .filter(|task| {
                filter
                    .due_date
                    .as_ref()
                    .is_none_or(|value| task.due_date.as_ref() == Some(value))
            })
            .filter(|task| {
                needle
                    .as_ref()
                    .is_none_or(|value| task.title.to_lowercase().contains(value))
            })
            .collect::<Vec<_>>();
        match filter.completed {
            Some(true) => sort_logbook(&mut tasks),
            Some(false) => sort_active(&mut tasks),
            None => tasks.sort_by(mixed_cmp),
        }
        Ok(Revisioned::new(tasks, read_revision(&connection)?))
    }

    pub fn search_tasks(
        &self,
        query: &str,
        include_completed: bool,
    ) -> AppResult<Revisioned<Vec<Task>>> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Revisioned::new(Vec::new(), self.revision()?));
        }
        let connection = self.inner.connection.lock();
        let mut tasks = load_all_tasks(&connection)?
            .into_iter()
            .filter(|task| task.deleted_at.is_none())
            .filter(|task| include_completed || task.completed_at.is_none())
            .filter(|task| task.title.to_lowercase().contains(&query))
            .collect::<Vec<_>>();
        tasks.sort_by(|left, right| {
            match (left.completed_at.is_some(), right.completed_at.is_some()) {
                (false, false) => active_cmp(left, right),
                (true, true) => logbook_cmp(left, right),
                (false, true) => Ordering::Less,
                (true, false) => Ordering::Greater,
            }
        });
        Ok(Revisioned::new(tasks, read_revision(&connection)?))
    }

    pub fn export_tasks(&self) -> AppResult<Revisioned<ExportSnapshot>> {
        let connection = self.inner.connection.lock();
        let mut tasks = load_all_tasks(&connection)?
            .into_iter()
            .filter(|task| task.deleted_at.is_none())
            .collect::<Vec<_>>();
        tasks.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then(left.id.cmp(&right.id))
        });
        let preferences = load_preferences(&connection)?
            .into_iter()
            .filter(|(key, _)| !is_sensitive_preference(key))
            .collect();
        let snapshot = ExportSnapshot {
            schema_version: 1,
            exported_at: hlc::timestamp(self.inner.clock.now_millis())?,
            tasks: tasks.into_iter().map(ExportTask::from).collect(),
            preferences,
        };
        Ok(Revisioned::new(snapshot, read_revision(&connection)?))
    }

    pub fn get_preferences(&self) -> AppResult<Revisioned<BTreeMap<String, Value>>> {
        let connection = self.inner.connection.lock();
        Ok(Revisioned::new(
            load_preferences(&connection)?,
            read_revision(&connection)?,
        ))
    }

    pub fn sync_preferences(&self) -> AppResult<(Option<String>, Option<String>)> {
        let connection = self.inner.connection.lock();
        let url = preference_string(&connection, "supabaseUrl")?;
        let key = preference_string(&connection, "supabasePublishableKey")?;
        Ok((url, key))
    }

    pub fn set_sync_settings(
        &self,
        url: &str,
        publishable_key: &str,
    ) -> AppResult<Revisioned<Value>> {
        let url = url.trim();
        let publishable_key = publishable_key.trim();
        if url.is_empty() != publishable_key.is_empty() {
            return Err(AppError::invalid_input(
                "Supabase URL and publishable key are both required",
            ));
        }
        let url_value = Value::String(url.to_owned());
        let key_value = Value::String(publishable_key.to_owned());
        let encoded_url = serde_json::to_string(&url_value)?;
        let encoded_key = serde_json::to_string(&key_value)?;
        if encoded_url.len() > 256 * 1024 || encoded_key.len() > 256 * 1024 {
            return Err(AppError::invalid_input("preference value is too large"));
        }

        let next_url = (!url.is_empty()).then(|| url.to_owned());
        let next_key = (!publishable_key.is_empty()).then(|| publishable_key.to_owned());
        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let changed = preference_string(&transaction, "supabaseUrl")? != next_url
            || preference_string(&transaction, "supabasePublishableKey")? != next_key;
        for (key, encoded) in [
            ("supabaseUrl", encoded_url),
            ("supabasePublishableKey", encoded_key),
        ] {
            transaction
                .execute(
                    "INSERT INTO preferences(key, value_json, updated_at) VALUES (?1, ?2, ?3) \
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                    params![key, encoded, now],
                )
                .map_err(AppError::from)?;
        }
        if changed {
            transaction
                .execute(
                    "DELETE FROM metadata WHERE key IN ('sync_epoch', 'last_successful_sync', 'last_sync_error')",
                    [],
                )
                .map_err(AppError::from)?;
            metadata_set(&transaction, "sync_seq", "0")?;
        }
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(
            json!({ "url": url, "publishableKey": publishable_key }),
            revision,
        ))
    }

    pub fn mark_sync_success(&self) -> AppResult<()> {
        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        metadata_set(&transaction, "last_successful_sync", &now)?;
        transaction
            .execute("DELETE FROM metadata WHERE key = 'last_sync_error'", [])
            .map_err(AppError::from)?;
        transaction.commit().map_err(AppError::from)
    }

    pub fn mark_sync_failure(&self, message: &str) -> AppResult<()> {
        let message = message.chars().take(500).collect::<String>();
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        metadata_set(&transaction, "last_sync_error", &message)?;
        transaction.commit().map_err(AppError::from)
    }

    pub fn clear_sync_failure(&self) -> AppResult<()> {
        let connection = self.inner.connection.lock();
        connection
            .execute("DELETE FROM metadata WHERE key = 'last_sync_error'", [])
            .map_err(AppError::from)?;
        Ok(())
    }

    pub fn set_preference(&self, key: &str, value: Value) -> AppResult<Revisioned<Value>> {
        validate_preference_key(key)?;
        let encoded = serde_json::to_string(&value)?;
        if encoded.len() > 256 * 1024 {
            return Err(AppError::invalid_input("preference value is too large"));
        }
        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        transaction
            .execute(
                "INSERT INTO preferences(key, value_json, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![key, encoded, now],
            )
            .map_err(AppError::from)?;
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(value, revision))
    }

    pub fn next_outbox(&self, limit: u32) -> AppResult<Revisioned<Vec<OutboxMutation>>> {
        if !(1..=500).contains(&limit) {
            return Err(AppError::invalid_input(
                "outbox limit must be between 1 and 500",
            ));
        }
        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let connection = self.inner.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT protocol_version, local_sequence, operation_id, device_id, task_id, \
                 registers_json, created_at, attempt_count, next_attempt_at FROM outbox \
                 WHERE status = 'pending' AND next_attempt_at <= ?1 \
                 ORDER BY local_sequence LIMIT ?2",
            )
            .map_err(AppError::from)?;
        let rows = statement
            .query_map(params![now, limit], |row| {
                let registers_json: String = row.get(5)?;
                let registers = serde_json::from_str(&registers_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        registers_json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(OutboxMutation {
                    protocol_version: row.get::<_, i64>(0)? as u32,
                    local_sequence: row.get::<_, i64>(1)? as u64,
                    operation_id: row.get(2)?,
                    device_id: row.get(3)?,
                    task_id: row.get(4)?,
                    registers,
                    created_at: row.get(6)?,
                    attempt_count: row.get::<_, i64>(7)? as u32,
                    next_attempt_at: row.get(8)?,
                })
            })
            .map_err(AppError::from)?;
        let mutations = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(Revisioned::new(mutations, read_revision(&connection)?))
    }

    pub fn record_outbox_failure(
        &self,
        operation_id: &str,
        message: &str,
        retryable: bool,
    ) -> AppResult<()> {
        validate_uuid(operation_id, "operationId")?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let attempts: u32 = transaction
            .query_row(
                "SELECT attempt_count FROM outbox WHERE operation_id = ?1",
                [operation_id],
                |row| row.get::<_, i64>(0).map(|value| value as u32),
            )
            .optional()
            .map_err(AppError::from)?
            .ok_or_else(|| {
                AppError::new(ErrorCode::IdempotencyMismatch, "outbox operation not found")
            })?;
        let delay_seconds = (1_u64 << attempts.min(8)).min(300);
        let next_ms = self
            .inner
            .clock
            .now_millis()
            .saturating_add((delay_seconds as i64) * 1_000);
        let next = hlc::timestamp(next_ms)?;
        let sanitized = message.chars().take(500).collect::<String>();
        transaction
            .execute(
                "UPDATE outbox SET attempt_count = attempt_count + 1, next_attempt_at = ?2, \
                 last_error = ?3, status = ?4 WHERE operation_id = ?1",
                params![
                    operation_id,
                    next,
                    sanitized,
                    if retryable { "pending" } else { "quarantined" }
                ],
            )
            .map_err(AppError::from)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(())
    }

    pub fn promote_legacy_outbox_mutation(&self, operation_id: &str) -> AppResult<()> {
        validate_uuid(operation_id, "operationId")?;
        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let changed = transaction
            .execute(
                "UPDATE outbox
                    SET protocol_version = ?2, attempt_count = 0, next_attempt_at = ?3, last_error = NULL
                  WHERE operation_id = ?1 AND status = 'pending' AND protocol_version = 1",
                params![operation_id, PROTOCOL_VERSION, now],
            )
            .map_err(AppError::from)?;
        if changed != 1 {
            return Err(AppError::new(
                ErrorCode::ProtocolMismatch,
                "legacy outbox mutation is unavailable for protocol upgrade",
            ));
        }
        transaction.commit().map_err(AppError::from)
    }

    pub fn ack_outbox(&self, operation_id: &str, remote_task: Task) -> AppResult<Revisioned<Task>> {
        validate_uuid(operation_id, "operationId")?;
        validate_remote_task(&remote_task)?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let expected_task_id: String = transaction
            .query_row(
                "SELECT task_id FROM outbox WHERE operation_id = ?1",
                [operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(AppError::from)?
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::IdempotencyMismatch,
                    "acknowledgement does not match a pending operation",
                )
            })?;
        if expected_task_id != remote_task.id {
            return Err(AppError::new(
                ErrorCode::IdempotencyMismatch,
                "acknowledgement task does not match the pending operation",
            )
            .with_details(json!({
                "expectedTaskId": expected_task_id,
                "actualTaskId": remote_task.id,
            })));
        }
        let outcome = merge_remote_task(&transaction, &remote_task)?;
        transaction
            .execute("DELETE FROM outbox WHERE operation_id = ?1", [operation_id])
            .map_err(AppError::from)?;
        let revision = if outcome == MergeOutcome::Unchanged {
            read_revision(&transaction)?
        } else {
            bump_revision(&transaction)?
        };
        let task = load_task(&transaction, &remote_task.id)?
            .ok_or_else(|| AppError::not_found(&remote_task.id))?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Revisioned::new(task, revision))
    }

    pub fn apply_remote_page(&self, page: RemotePage) -> AppResult<MergeSummary> {
        validate_protocol(page.protocol_version)?;
        validate_uuid(&page.epoch, "epoch")?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let cursor = read_cursor(&transaction)?;
        match cursor.epoch.as_deref() {
            None => {
                return Err(AppError::new(
                    ErrorCode::ProtocolMismatch,
                    "sync cursor is not bootstrapped",
                )
                .with_details(json!({ "requiresBootstrap": true })));
            }
            Some(epoch) if epoch != page.epoch => {
                return Err(AppError::new(
                    ErrorCode::ProtocolMismatch,
                    "remote feed epoch changed",
                )
                .with_details(json!({
                    "requiresBootstrap": true,
                    "localEpoch": epoch,
                    "remoteEpoch": page.epoch,
                })));
            }
            Some(_) => {}
        }

        let mut expected = cursor.sequence.saturating_add(1);
        for change in &page.changes {
            if change.seq != expected {
                return Err(AppError::new(
                    ErrorCode::ProtocolMismatch,
                    "remote feed page is not contiguous",
                )
                .with_details(json!({ "expectedSeq": expected, "actualSeq": change.seq })));
            }
            validate_remote_task(&change.task)?;
            expected = expected.checked_add(1).ok_or_else(|| {
                AppError::new(ErrorCode::ProtocolMismatch, "remote sequence overflow")
            })?;
        }

        let mut summary = MergeSummary::default();
        for change in &page.changes {
            summary.record(merge_remote_task(&transaction, &change.task)?);
        }
        if let Some(last) = page.changes.last() {
            write_cursor(&transaction, &page.epoch, last.seq)?;
        }
        summary.revision = if summary.inserted + summary.updated > 0 {
            bump_revision(&transaction)?
        } else {
            read_revision(&transaction)?
        };
        transaction.commit().map_err(AppError::from)?;
        Ok(summary)
    }

    pub fn bootstrap_remote(&self, payload: BootstrapPayload) -> AppResult<MergeSummary> {
        validate_protocol(payload.protocol_version)?;
        validate_uuid(&payload.epoch, "epoch")?;
        let mut remote_ids = BTreeSet::new();
        for task in &payload.tasks {
            validate_remote_task(task)?;
            if !remote_ids.insert(task.id.clone()) {
                return Err(AppError::new(
                    ErrorCode::ProtocolMismatch,
                    "bootstrap contains duplicate task ids",
                ));
            }
        }

        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let mut summary = MergeSummary::default();
        for remote in &payload.tasks {
            let local = load_task(&transaction, &remote.id)?;
            let repair_names = local
                .as_ref()
                .map(|task| locally_newer_registers(task, remote))
                .unwrap_or_default();
            summary.record(merge_remote_task(&transaction, remote)?);
            if !repair_names.is_empty() {
                let merged = load_task(&transaction, &remote.id)?
                    .ok_or_else(|| AppError::not_found(&remote.id))?;
                enqueue_registers(&transaction, &merged, &repair_names, &now)?;
                summary.repair_operations += 1;
            }
        }

        for local in load_all_tasks(&transaction)? {
            if !remote_ids.contains(&local.id) {
                enqueue_registers(&transaction, &local, &REGISTER_NAMES, &now)?;
                summary.repair_operations += 1;
            }
        }
        write_cursor(&transaction, &payload.epoch, payload.watermark)?;
        summary.revision = if summary.inserted + summary.updated > 0 {
            bump_revision(&transaction)?
        } else {
            read_revision(&transaction)?
        };
        transaction.commit().map_err(AppError::from)?;
        Ok(summary)
    }

    pub fn sync_diagnostics(&self) -> AppResult<Revisioned<Value>> {
        let connection = self.inner.connection.lock();
        let pending = connection
            .query_row(
                "SELECT count(*) FROM outbox WHERE status = 'pending'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(AppError::from)? as u64;
        let quarantined = connection
            .query_row(
                "SELECT count(*) FROM outbox WHERE status = 'quarantined'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(AppError::from)? as u64;
        let cursor = read_cursor(&connection)?;
        let last_success = metadata_get(&connection, "last_successful_sync")?;
        let last_error = metadata_get(&connection, "last_sync_error")?;
        Ok(Revisioned::new(
            json!({
                "pendingOutbox": pending,
                "quarantinedOutbox": quarantined,
                "cursor": cursor,
                "lastSuccessfulSync": last_success,
                "lastError": last_error,
            }),
            read_revision(&connection)?,
        ))
    }
}

impl MergeSummary {
    fn record(&mut self, outcome: MergeOutcome) {
        match outcome {
            MergeOutcome::Inserted => self.inserted += 1,
            MergeOutcome::Updated => self.updated += 1,
            MergeOutcome::Unchanged => self.unchanged += 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeOutcome {
    Inserted,
    Updated,
    Unchanged,
}

fn run_migrations(connection: &mut Connection, now_ms: i64) -> AppResult<()> {
    let version = if connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppError::from)?
        .is_some()
    {
        connection
            .query_row(
                "SELECT coalesce(max(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .map_err(AppError::from)?
    } else {
        0
    };
    if version > 2 {
        return Err(AppError::new(
            ErrorCode::ProtocolMismatch,
            "local database was created by a newer Todou version",
        ));
    }

    if version < 1 {
        apply_migration(connection, MIGRATION_1, 1, now_ms)?;
    }
    if version < 2 {
        connection
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(AppError::from)?;
        let migration = apply_migration(connection, MIGRATION_2, 2, now_ms);
        let foreign_keys = connection.execute_batch("PRAGMA foreign_keys = ON;");
        migration?;
        foreign_keys.map_err(AppError::from)?;
    }
    Ok(())
}

fn apply_migration(
    connection: &mut Connection,
    migration: &str,
    version: i64,
    now_ms: i64,
) -> AppResult<()> {
    let transaction = connection.transaction().map_err(AppError::from)?;
    transaction
        .execute_batch(migration)
        .map_err(AppError::from)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![version, hlc::timestamp(now_ms)?],
        )
        .map_err(AppError::from)?;
    transaction.commit().map_err(AppError::from)
}

fn ensure_device_id(connection: &Connection) -> AppResult<String> {
    if let Some(value) = metadata_get(connection, "device_id")? {
        if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::storage("stored device id is corrupt"));
        }
        return Ok(value);
    }
    let value = Uuid::new_v4().simple().to_string();
    connection
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('device_id', ?1)",
            [&value],
        )
        .map_err(AppError::from)?;
    Ok(value)
}

fn validate_uuid(value: &str, field: &str) -> AppResult<()> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| AppError::invalid_input(format!("{field} must be a UUID")))
}

fn validate_protocol(version: u32) -> AppResult<()> {
    if version != PROTOCOL_VERSION {
        return Err(AppError::new(
            ErrorCode::ProtocolMismatch,
            format!("unsupported sync protocol version {version}"),
        )
        .with_details(json!({ "supportedVersion": PROTOCOL_VERSION })));
    }
    Ok(())
}

fn validate_remote_task(task: &Task) -> AppResult<()> {
    validate_uuid(&task.id, "task.id")?;
    task.validate().map_err(|error| {
        AppError::new(
            ErrorCode::ProtocolMismatch,
            format!("remote task {} is invalid: {}", task.id, error.message),
        )
    })
}

fn validate_preference_key(key: &str) -> AppResult<()> {
    if key.is_empty()
        || key.len() > 100
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(AppError::invalid_input("invalid preference key"));
    }
    Ok(())
}

fn is_sensitive_preference(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("supabase")
        || key.ends_with("api_key")
        || key.ends_with("apikey")
        || key.ends_with("publishable_key")
        || key.ends_with("publishablekey")
}

fn metadata_get(connection: &Connection, key: &str) -> AppResult<Option<String>> {
    connection
        .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(AppError::from)
}

fn metadata_set(transaction: &Transaction<'_>, key: &str, value: &str) -> AppResult<()> {
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(AppError::from)?;
    Ok(())
}

fn read_revision(connection: &Connection) -> AppResult<u64> {
    metadata_get(connection, "local_revision")?
        .ok_or_else(|| AppError::storage("local revision is missing"))?
        .parse()
        .map_err(|_| AppError::storage("local revision is corrupt"))
}

fn bump_revision(transaction: &Transaction<'_>) -> AppResult<u64> {
    let next = read_revision(transaction)?
        .checked_add(1)
        .ok_or_else(|| AppError::storage("local revision overflow"))?;
    metadata_set(transaction, "local_revision", &next.to_string())?;
    Ok(next)
}

fn read_cursor(connection: &Connection) -> AppResult<SyncCursor> {
    let sequence = metadata_get(connection, "sync_seq")?
        .unwrap_or_else(|| "0".to_owned())
        .parse()
        .map_err(|_| AppError::storage("sync cursor is corrupt"))?;
    Ok(SyncCursor {
        epoch: metadata_get(connection, "sync_epoch")?,
        sequence,
    })
}

fn write_cursor(transaction: &Transaction<'_>, epoch: &str, sequence: u64) -> AppResult<()> {
    metadata_set(transaction, "sync_epoch", epoch)?;
    metadata_set(transaction, "sync_seq", &sequence.to_string())
}

fn next_stamp(transaction: &Transaction<'_>, now_ms: i64) -> AppResult<String> {
    let device_id = metadata_get(transaction, "device_id")?
        .ok_or_else(|| AppError::storage("device id is missing"))?;
    let mut state = read_hlc_state(transaction)?;
    let stamp = state.next(now_ms, &device_id)?.encode()?;
    write_hlc_state(transaction, state)?;
    Ok(stamp)
}

fn observe_remote_clocks(transaction: &Transaction<'_>, clocks: &TaskClocks) -> AppResult<()> {
    let mut state = read_hlc_state(transaction)?;
    for stamp in clocks.stamps() {
        state.observe(&Hlc::parse(stamp).map_err(|_| {
            AppError::new(ErrorCode::ProtocolMismatch, "remote HLC stamp is invalid")
        })?);
    }
    write_hlc_state(transaction, state)
}

fn read_hlc_state(connection: &Connection) -> AppResult<HlcState> {
    let wall_ms = metadata_get(connection, "hlc_wall_ms")?
        .ok_or_else(|| AppError::storage("HLC wall state is missing"))?
        .parse()
        .map_err(|_| AppError::storage("HLC wall state is corrupt"))?;
    let counter = metadata_get(connection, "hlc_counter")?
        .ok_or_else(|| AppError::storage("HLC counter state is missing"))?
        .parse()
        .map_err(|_| AppError::storage("HLC counter state is corrupt"))?;
    Ok(HlcState { wall_ms, counter })
}

fn write_hlc_state(transaction: &Transaction<'_>, state: HlcState) -> AppResult<()> {
    metadata_set(transaction, "hlc_wall_ms", &state.wall_ms.to_string())?;
    metadata_set(transaction, "hlc_counter", &state.counter.to_string())
}

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let bucket = parse_db_enum::<Bucket>(row.get::<_, String>(2)?, 2)?;
    let priority = parse_db_enum::<Priority>(row.get::<_, String>(3)?, 3)?;
    let area = parse_db_enum::<Area>(row.get::<_, String>(4)?, 4)?;
    let estimate = row
        .get::<_, Option<i64>>(6)?
        .map(|value| {
            u16::try_from(value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        bucket,
        priority,
        area,
        due_date: row.get(5)?,
        estimate_minutes: estimate,
        order_key: row.get(7)?,
        completed_at: row.get(8)?,
        deleted_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        clocks: TaskClocks {
            title: row.get(12)?,
            schedule: row.get(13)?,
            priority: row.get(14)?,
            area: row.get(15)?,
            estimate: row.get(16)?,
            order: row.get(17)?,
            completion: row.get(18)?,
            deletion: row.get(19)?,
        },
    })
}

fn parse_db_enum<T>(value: String, index: usize) -> rusqlite::Result<T>
where
    T: FromStr<Err = AppError>,
{
    value.parse().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn load_task(connection: &Connection, id: &str) -> AppResult<Option<Task>> {
    connection
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"),
            [id],
            row_to_task,
        )
        .optional()
        .map_err(AppError::from)
}

fn load_all_tasks(connection: &Connection) -> AppResult<Vec<Task>> {
    let mut statement = connection
        .prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks"))
        .map_err(AppError::from)?;
    let rows = statement
        .query_map([], row_to_task)
        .map_err(AppError::from)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn require_visible_task(connection: &Connection, id: &str) -> AppResult<Task> {
    let task = load_task(connection, id)?.ok_or_else(|| AppError::not_found(id))?;
    if task.deleted_at.is_some() {
        return Err(AppError::new(ErrorCode::Deleted, "Task is deleted")
            .with_details(json!({ "taskId": id })));
    }
    Ok(task)
}

fn require_active_task(connection: &Connection, id: &str) -> AppResult<Task> {
    let task = require_visible_task(connection, id)?;
    if task.completed_at.is_some() {
        return Err(AppError::new(
            ErrorCode::InvalidTransition,
            "Complete tasks must be restored before they can be moved or reordered",
        ));
    }
    Ok(task)
}

fn insert_task(transaction: &Transaction<'_>, task: &Task) -> AppResult<()> {
    transaction
        .execute(
            "INSERT INTO tasks(
                id, title, bucket, priority, area, due_date, estimate_minutes, order_key,
                completed_at, deleted_at, created_at, updated_at, title_clock, schedule_clock,
                priority_clock, area_clock, estimate_clock, order_clock, completion_clock,
                deletion_clock
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
            )",
            task_params(task),
        )
        .map_err(AppError::from)?;
    Ok(())
}

fn update_task_row(transaction: &Transaction<'_>, task: &Task) -> AppResult<()> {
    let changed = transaction
        .execute(
            "UPDATE tasks SET
                title = ?2, bucket = ?3, priority = ?4, area = ?5, due_date = ?6,
                estimate_minutes = ?7, order_key = ?8, completed_at = ?9, deleted_at = ?10,
                created_at = ?11, updated_at = ?12, title_clock = ?13, schedule_clock = ?14,
                priority_clock = ?15, area_clock = ?16, estimate_clock = ?17, order_clock = ?18,
                completion_clock = ?19, deletion_clock = ?20
             WHERE id = ?1",
            task_params(task),
        )
        .map_err(AppError::from)?;
    if changed != 1 {
        return Err(AppError::storage(
            "task update did not affect exactly one row",
        ));
    }
    Ok(())
}

fn task_params(task: &Task) -> [rusqlite::types::Value; 20] {
    use rusqlite::types::Value as SqlValue;
    [
        SqlValue::Text(task.id.clone()),
        SqlValue::Text(task.title.clone()),
        SqlValue::Text(task.bucket.as_str().to_owned()),
        SqlValue::Text(task.priority.as_str().to_owned()),
        SqlValue::Text(task.area.as_str().to_owned()),
        task.due_date.clone().map_or(SqlValue::Null, SqlValue::Text),
        task.estimate_minutes
            .map_or(SqlValue::Null, |value| SqlValue::Integer(value.into())),
        SqlValue::Text(task.order_key.clone()),
        task.completed_at
            .clone()
            .map_or(SqlValue::Null, SqlValue::Text),
        task.deleted_at
            .clone()
            .map_or(SqlValue::Null, SqlValue::Text),
        SqlValue::Text(task.created_at.clone()),
        SqlValue::Text(task.updated_at.clone()),
        SqlValue::Text(task.clocks.title.clone()),
        SqlValue::Text(task.clocks.schedule.clone()),
        SqlValue::Text(task.clocks.priority.clone()),
        SqlValue::Text(task.clocks.area.clone()),
        SqlValue::Text(task.clocks.estimate.clone()),
        SqlValue::Text(task.clocks.order.clone()),
        SqlValue::Text(task.clocks.completion.clone()),
        SqlValue::Text(task.clocks.deletion.clone()),
    ]
}

fn next_tier_key(
    connection: &Connection,
    bucket: Bucket,
    priority: Priority,
    exclude_id: Option<&str>,
) -> AppResult<String> {
    let last = connection
        .query_row(
            "SELECT order_key FROM tasks
             WHERE bucket = ?1 AND priority = ?2 AND completed_at IS NULL AND deleted_at IS NULL
               AND (?3 IS NULL OR id != ?3)
             ORDER BY order_key COLLATE BINARY DESC, id DESC LIMIT 1",
            params![bucket.as_str(), priority.as_str(), exclude_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppError::from)?;
    order_key::between(last.as_deref(), None)
}

fn ensure_in_progress_capacity(connection: &Connection, exclude_id: Option<&str>) -> AppResult<()> {
    let count = connection
        .query_row(
            "SELECT count(*) FROM tasks
             WHERE bucket = 'in_progress' AND completed_at IS NULL AND deleted_at IS NULL
               AND (?1 IS NULL OR id != ?1)",
            [exclude_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(AppError::from)?;
    if count >= IN_PROGRESS_TASK_LIMIT {
        return Err(AppError::new(
            ErrorCode::InvalidTransition,
            "In Progress can only contain three active tasks",
        ));
    }
    Ok(())
}

fn load_active_tier(
    connection: &Connection,
    bucket: Bucket,
    priority: Priority,
    exclude_id: Option<&str>,
) -> AppResult<Vec<Task>> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks
             WHERE bucket = ?1 AND priority = ?2 AND completed_at IS NULL AND deleted_at IS NULL
               AND (?3 IS NULL OR id != ?3)
             ORDER BY order_key COLLATE BINARY, id"
        ))
        .map_err(AppError::from)?;
    let rows = statement
        .query_map(
            params![bucket.as_str(), priority.as_str(), exclude_id],
            row_to_task,
        )
        .map_err(AppError::from)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn validate_anchors<'a>(
    tier: &'a [Task],
    before_id: Option<&str>,
    after_id: Option<&str>,
) -> AppResult<(Option<&'a Task>, Option<&'a Task>)> {
    let before_index = before_id.and_then(|id| tier.iter().position(|task| task.id == id));
    let after_index = after_id.and_then(|id| tier.iter().position(|task| task.id == id));
    if before_id.is_some() && before_index.is_none() || after_id.is_some() && after_index.is_none()
    {
        return Err(AppError::new(
            ErrorCode::InvalidAnchor,
            "reorder anchor is missing or belongs to a different tier",
        ));
    }

    match (after_index, before_index) {
        (Some(after), Some(before)) if before == after + 1 => {
            Ok((tier.get(after), tier.get(before)))
        }
        (None, Some(0)) => Ok((None, tier.first())),
        (Some(after), None) if after + 1 == tier.len() => Ok((tier.get(after), None)),
        (None, None) if tier.is_empty() => Ok((None, None)),
        _ => Err(AppError::new(
            ErrorCode::InvalidAnchor,
            "reorder anchors are stale; refresh the tier and try again",
        )),
    }
}

fn apply_clock(clocks: &mut TaskClocks, changed: &BTreeSet<&str>, stamp: &str) {
    for name in changed {
        match *name {
            "title" => clocks.title = stamp.to_owned(),
            "schedule" => clocks.schedule = stamp.to_owned(),
            "priority" => clocks.priority = stamp.to_owned(),
            "area" => clocks.area = stamp.to_owned(),
            "estimate" => clocks.estimate = stamp.to_owned(),
            "order" => clocks.order = stamp.to_owned(),
            "completion" => clocks.completion = stamp.to_owned(),
            "deletion" => clocks.deletion = stamp.to_owned(),
            _ => unreachable!("register names are internal constants"),
        }
    }
}

fn enqueue_registers(
    transaction: &Transaction<'_>,
    task: &Task,
    names: &[&str],
    now: &str,
) -> AppResult<String> {
    let operation_id = Uuid::new_v4().to_string();
    let device_id = metadata_get(transaction, "device_id")?
        .ok_or_else(|| AppError::storage("device id is missing"))?;
    let registers = register_map(task, names)?;
    let registers_json = serde_json::to_string(&registers)?;
    transaction
        .execute(
            "INSERT INTO outbox(
                protocol_version, operation_id, device_id, task_id, registers_json,
                created_at, next_attempt_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                PROTOCOL_VERSION,
                operation_id,
                device_id,
                task.id,
                registers_json,
                now
            ],
        )
        .map_err(AppError::from)?;
    Ok(operation_id)
}

fn register_map(task: &Task, names: &[&str]) -> AppResult<RegisterMap> {
    let mut registers = RegisterMap::new();
    for name in names {
        let (stamp, value) = match *name {
            "title" => (&task.clocks.title, json!(task.title)),
            "schedule" => (
                &task.clocks.schedule,
                json!({ "bucket": task.bucket, "due_date": task.due_date }),
            ),
            "priority" => (&task.clocks.priority, json!(task.priority)),
            "area" => (&task.clocks.area, json!(task.area)),
            "estimate" => (&task.clocks.estimate, json!(task.estimate_minutes)),
            "order" => (&task.clocks.order, json!(task.order_key)),
            "completion" => (&task.clocks.completion, json!(task.completed_at)),
            "deletion" => (&task.clocks.deletion, json!(task.deleted_at)),
            other => {
                return Err(AppError::new(
                    ErrorCode::ProtocolMismatch,
                    format!("unknown task register '{other}'"),
                ))
            }
        };
        registers.insert(
            (*name).to_owned(),
            StampedValue {
                stamp: stamp.clone(),
                value,
            },
        );
    }
    Ok(registers)
}

fn merge_remote_task(transaction: &Transaction<'_>, remote: &Task) -> AppResult<MergeOutcome> {
    validate_remote_task(remote)?;
    observe_remote_clocks(transaction, &remote.clocks)?;
    let Some(mut local) = load_task(transaction, &remote.id)? else {
        insert_task(transaction, remote)?;
        return Ok(MergeOutcome::Inserted);
    };
    let original = local.clone();

    merge_register(
        "title",
        &local.clocks.title,
        &remote.clocks.title,
        &local.title,
        &remote.title,
    )?;
    if remote.clocks.title > local.clocks.title {
        local.title = remote.title.clone();
        local.clocks.title = remote.clocks.title.clone();
    }
    merge_register(
        "schedule",
        &local.clocks.schedule,
        &remote.clocks.schedule,
        &(local.bucket, local.due_date.clone()),
        &(remote.bucket, remote.due_date.clone()),
    )?;
    if remote.clocks.schedule > local.clocks.schedule {
        local.bucket = remote.bucket;
        local.due_date = remote.due_date.clone();
        local.clocks.schedule = remote.clocks.schedule.clone();
    }
    merge_register(
        "priority",
        &local.clocks.priority,
        &remote.clocks.priority,
        &local.priority,
        &remote.priority,
    )?;
    if remote.clocks.priority > local.clocks.priority {
        local.priority = remote.priority;
        local.clocks.priority = remote.clocks.priority.clone();
    }
    merge_register(
        "area",
        &local.clocks.area,
        &remote.clocks.area,
        &local.area,
        &remote.area,
    )?;
    if remote.clocks.area > local.clocks.area {
        local.area = remote.area;
        local.clocks.area = remote.clocks.area.clone();
    }
    merge_register(
        "estimate",
        &local.clocks.estimate,
        &remote.clocks.estimate,
        &local.estimate_minutes,
        &remote.estimate_minutes,
    )?;
    if remote.clocks.estimate > local.clocks.estimate {
        local.estimate_minutes = remote.estimate_minutes;
        local.clocks.estimate = remote.clocks.estimate.clone();
    }
    merge_register(
        "order",
        &local.clocks.order,
        &remote.clocks.order,
        &local.order_key,
        &remote.order_key,
    )?;
    if remote.clocks.order > local.clocks.order {
        local.order_key = remote.order_key.clone();
        local.clocks.order = remote.clocks.order.clone();
    }
    merge_register(
        "completion",
        &local.clocks.completion,
        &remote.clocks.completion,
        &local.completed_at,
        &remote.completed_at,
    )?;
    if remote.clocks.completion > local.clocks.completion {
        local.completed_at = remote.completed_at.clone();
        local.clocks.completion = remote.clocks.completion.clone();
    }
    merge_register(
        "deletion",
        &local.clocks.deletion,
        &remote.clocks.deletion,
        &local.deleted_at,
        &remote.deleted_at,
    )?;
    if remote.clocks.deletion > local.clocks.deletion {
        local.deleted_at = remote.deleted_at.clone();
        local.clocks.deletion = remote.clocks.deletion.clone();
    }

    local.created_at = remote.created_at.clone();
    local.updated_at = local.updated_at.max(remote.updated_at.clone());
    local.validate()?;
    if local == original {
        Ok(MergeOutcome::Unchanged)
    } else {
        update_task_row(transaction, &local)?;
        Ok(MergeOutcome::Updated)
    }
}

fn merge_register<T: PartialEq>(
    name: &str,
    local_stamp: &str,
    remote_stamp: &str,
    local_value: &T,
    remote_value: &T,
) -> AppResult<()> {
    if local_stamp == remote_stamp && local_value != remote_value {
        return Err(AppError::new(
            ErrorCode::ProtocolMismatch,
            format!("register '{name}' has two values for the same HLC stamp"),
        ));
    }
    Ok(())
}

fn locally_newer_registers(local: &Task, remote: &Task) -> Vec<&'static str> {
    let pairs = [
        (
            "title",
            local.clocks.title.as_str(),
            remote.clocks.title.as_str(),
        ),
        (
            "schedule",
            local.clocks.schedule.as_str(),
            remote.clocks.schedule.as_str(),
        ),
        (
            "priority",
            local.clocks.priority.as_str(),
            remote.clocks.priority.as_str(),
        ),
        (
            "area",
            local.clocks.area.as_str(),
            remote.clocks.area.as_str(),
        ),
        (
            "estimate",
            local.clocks.estimate.as_str(),
            remote.clocks.estimate.as_str(),
        ),
        (
            "order",
            local.clocks.order.as_str(),
            remote.clocks.order.as_str(),
        ),
        (
            "completion",
            local.clocks.completion.as_str(),
            remote.clocks.completion.as_str(),
        ),
        (
            "deletion",
            local.clocks.deletion.as_str(),
            remote.clocks.deletion.as_str(),
        ),
    ];
    pairs
        .into_iter()
        .filter_map(|(name, local, remote)| (local > remote).then_some(name))
        .collect()
}

fn load_preferences(connection: &Connection) -> AppResult<BTreeMap<String, Value>> {
    let mut statement = connection
        .prepare("SELECT key, value_json FROM preferences ORDER BY key")
        .map_err(AppError::from)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppError::from)?;
    let mut preferences = BTreeMap::new();
    for row in rows {
        let (key, encoded) = row.map_err(AppError::from)?;
        let value = serde_json::from_str(&encoded)
            .map_err(|_| AppError::storage(format!("preference '{key}' is corrupt")))?;
        preferences.insert(key, value);
    }
    Ok(preferences)
}

fn preference_string(connection: &Connection, key: &str) -> AppResult<Option<String>> {
    let encoded = connection
        .query_row(
            "SELECT value_json FROM preferences WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppError::from)?;
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    match serde_json::from_str::<Value>(&encoded)
        .map_err(|_| AppError::storage(format!("preference '{key}' is corrupt")))?
    {
        Value::String(value) => {
            let value = value.trim();
            Ok((!value.is_empty()).then(|| value.to_owned()))
        }
        _ => Err(AppError::invalid_input(format!(
            "preference '{key}' must be a string"
        ))),
    }
}

fn active_cmp(left: &Task, right: &Task) -> Ordering {
    left.bucket
        .sort_rank()
        .cmp(&right.bucket.sort_rank())
        .then(left.priority.sort_rank().cmp(&right.priority.sort_rank()))
        .then_with(|| left.order_key.as_bytes().cmp(right.order_key.as_bytes()))
        .then_with(|| left.id.cmp(&right.id))
}

fn sort_active(tasks: &mut [Task]) {
    tasks.sort_by(active_cmp);
}

fn logbook_cmp(left: &Task, right: &Task) -> Ordering {
    right
        .completed_at
        .cmp(&left.completed_at)
        .then_with(|| left.id.cmp(&right.id))
}

fn sort_logbook(tasks: &mut [Task]) {
    tasks.sort_by(logbook_cmp);
}

fn mixed_cmp(left: &Task, right: &Task) -> Ordering {
    match (left.completed_at.is_some(), right.completed_at.is_some()) {
        (false, false) => active_cmp(left, right),
        (true, true) => logbook_cmp(left, right),
        (false, true) => Ordering::Less,
        (true, false) => Ordering::Greater,
    }
}
