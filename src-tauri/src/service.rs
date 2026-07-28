use crate::{
    domain::{
        parse_due_date, validate_due_date, validate_estimate, Area, BootstrapPayload, Bucket,
        CreateTaskInput, ExportSnapshot, ExportTask, MergeSummary, NullablePatch, OutboxMutation,
        Priority, RegisterMap, RemotePage, Revisioned, StampedValue, SyncCursor, Task, TaskClocks,
        TaskFilter, UpdateTaskPatch, PROTOCOL_VERSION,
    },
    error::{AppError, AppResult, ErrorCode},
    hlc::{self, ClockSource, Hlc, HlcState},
    llm::{MergedTaskDraft, Provider, ProviderCredentials, MAX_LOGBOOK_CONTEXT_TASKS},
    order_key,
};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
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
const MIGRATION_2: &str = include_str!("../migrations/0002_task_descriptions.sql");
const MIGRATION_3: &str = include_str!("../migrations/0003_add_in_progress_bucket.sql");
const IN_PROGRESS_TASK_LIMIT: i64 = 3;
const TASK_COLUMNS: &str = "id, title, bucket, priority, area, due_date, estimate_minutes, \
    order_key, completed_at, deleted_at, created_at, updated_at, title_clock, schedule_clock, \
    priority_clock, area_clock, estimate_clock, order_clock, completion_clock, deletion_clock, \
    description, description_clock";
const REGISTER_NAMES: [&str; 9] = [
    "title",
    "description",
    "schedule",
    "priority",
    "area",
    "estimate",
    "order",
    "completion",
    "deletion",
];
const DEDUPE_JOB_PREFIX: &str = "dedupe.job.";
const DEDUPE_SUGGESTION_PREFIX: &str = "dedupe.suggestion.";
const DEDUPE_FAILED_PREFIX: &str = "dedupe.failed.";
const OPENAI_KEY_METADATA: &str = "llm.openai_api_key";
const ANTHROPIC_KEY_METADATA: &str = "llm.anthropic_api_key";
const MAX_DEDUPE_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeJob {
    pub task_id: String,
    pub enqueued_at: String,
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeTaskSnapshot {
    pub task: Task,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeContext {
    pub job: DedupeJob,
    pub new_task: DedupeTaskSnapshot,
    pub candidate_fingerprint: String,
    pub active_candidates: Vec<DedupeTaskSnapshot>,
    pub logbook_context: Vec<DedupeTaskSnapshot>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DedupeCounts {
    pub pending: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LlmCredentialSource {
    Saved,
    Environment,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LlmCredentialStatus {
    pub configured: bool,
    pub source: Option<LlmCredentialSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LlmCredentialsStatus {
    pub openai: LlmCredentialStatus,
    pub anthropic: LlmCredentialStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeSuggestion {
    pub id: String,
    pub created_at: String,
    pub new_task: Task,
    pub existing_task: Task,
    pub new_task_fingerprint: String,
    pub existing_task_fingerprint: String,
    pub merged_task: MergedTaskDraft,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DedupeResolutionAction {
    DeleteNew,
    DeleteExisting,
    Merge,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DedupeResolutionStatus {
    Resolved,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DedupeResolutionOutcome {
    pub status: DedupeResolutionStatus,
    pub revision: u64,
    pub survivor: Option<Task>,
    pub deleted_task_id: Option<String>,
    pub sync_required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DedupeFailureDisposition {
    Retrying,
    Parked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailedDedupeJob {
    task_id: String,
    enqueued_at: String,
    attempts: u32,
    category: String,
}

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
            description: String::new(),
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
        let job = DedupeJob {
            task_id: task.id.clone(),
            enqueued_at: now.clone(),
            attempts: 0,
        };
        metadata_set(
            &transaction,
            &dedupe_job_key(&task.id),
            &serde_json::to_string(&job)?,
        )?;
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
        if let Some(description) = patch.description {
            let description = crate::domain::normalize_description(&description)?;
            if task.description != description {
                task.description = description;
                changed.insert("description");
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

    pub(crate) fn get_local_metadata_value(&self, key: &str) -> AppResult<Option<Value>> {
        let connection = self.inner.connection.lock();
        metadata_get(&connection, key)?
            .map(|encoded| serde_json::from_str(&encoded).map_err(AppError::from))
            .transpose()
    }

    pub(crate) fn set_local_metadata_value(
        &self,
        key: &str,
        value: Option<Value>,
    ) -> AppResult<()> {
        let encoded = value
            .map(|value| serde_json::to_string(&value))
            .transpose()?;
        if encoded
            .as_ref()
            .is_some_and(|value| value.len() > 256 * 1024)
        {
            return Err(AppError::invalid_input("metadata value is too large"));
        }

        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        if let Some(encoded) = encoded {
            metadata_set(&transaction, key, &encoded)?;
        } else {
            transaction
                .execute("DELETE FROM metadata WHERE key = ?1", [key])
                .map_err(AppError::from)?;
        }
        transaction.commit().map_err(AppError::from)
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

    pub fn list_pending_dedupe_jobs(&self) -> AppResult<Vec<DedupeJob>> {
        let connection = self.inner.connection.lock();
        let mut jobs = load_metadata_values::<DedupeJob>(&connection, DEDUPE_JOB_PREFIX)?;
        jobs.sort_by(|left, right| {
            left.enqueued_at
                .cmp(&right.enqueued_at)
                .then_with(|| left.task_id.cmp(&right.task_id))
        });
        Ok(jobs)
    }

    pub fn dedupe_counts(&self) -> AppResult<DedupeCounts> {
        let connection = self.inner.connection.lock();
        Ok(DedupeCounts {
            pending: metadata_prefix_count(&connection, DEDUPE_JOB_PREFIX)?,
            failed: metadata_prefix_count(&connection, DEDUPE_FAILED_PREFIX)?,
        })
    }

    pub fn prepare_dedupe_context(&self, task_id: &str) -> AppResult<Option<DedupeContext>> {
        validate_uuid(task_id, "taskId")?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let job_key = dedupe_job_key(task_id);
        let Some(encoded_job) = metadata_get(&transaction, &job_key)? else {
            transaction.commit().map_err(AppError::from)?;
            return Ok(None);
        };
        let job = decode_metadata::<DedupeJob>(&job_key, &encoded_job)?;
        if job.task_id != task_id {
            return Err(AppError::storage("dedupe job task id is corrupt"));
        }
        let Some(new_task) = load_task(&transaction, task_id)? else {
            delete_metadata(&transaction, &job_key)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(None);
        };
        if !new_task.is_active() {
            delete_metadata(&transaction, &job_key)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(None);
        }

        let active_candidates = load_active_dedupe_candidates(&transaction, task_id, &job)?;
        let mut logbook_context = Vec::new();
        for task in load_all_tasks(&transaction)? {
            if task.id == task_id || task.deleted_at.is_some() {
                continue;
            }
            if task.completed_at.is_some() {
                logbook_context.push(task_snapshot(task)?);
            }
        }
        logbook_context.sort_by(|left, right| logbook_cmp(&left.task, &right.task));
        logbook_context.truncate(MAX_LOGBOOK_CONTEXT_TASKS);

        let context = DedupeContext {
            job,
            new_task: task_snapshot(new_task)?,
            candidate_fingerprint: candidate_set_fingerprint(&active_candidates)?,
            active_candidates,
            logbook_context,
        };
        transaction.commit().map_err(AppError::from)?;
        Ok(Some(context))
    }

    pub fn llm_credentials(&self) -> AppResult<ProviderCredentials> {
        let connection = self.inner.connection.lock();
        Ok(ProviderCredentials {
            openai: effective_api_key(&connection, OPENAI_KEY_METADATA, "OPENAI_API_KEY")?,
            anthropic: effective_api_key(&connection, ANTHROPIC_KEY_METADATA, "ANTHROPIC_API_KEY")?,
        })
    }

    pub fn llm_credential_status(&self) -> AppResult<LlmCredentialsStatus> {
        let connection = self.inner.connection.lock();
        Ok(LlmCredentialsStatus {
            openai: credential_status(&connection, OPENAI_KEY_METADATA, "OPENAI_API_KEY")?,
            anthropic: credential_status(&connection, ANTHROPIC_KEY_METADATA, "ANTHROPIC_API_KEY")?,
        })
    }

    pub fn set_llm_api_key(&self, provider: Provider, key: Option<&str>) -> AppResult<()> {
        let metadata_key = match provider {
            Provider::OpenAi => OPENAI_KEY_METADATA,
            Provider::Anthropic => ANTHROPIC_KEY_METADATA,
        };
        let key = key
            .map(str::trim)
            .map(|value| {
                if value.is_empty() {
                    Err(AppError::invalid_input("API key cannot be blank"))
                } else if value.len() > 16 * 1024 {
                    Err(AppError::invalid_input("API key is too large"))
                } else {
                    Ok(value)
                }
            })
            .transpose()?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        match key {
            Some(value) => metadata_set(&transaction, metadata_key, value)?,
            None => delete_metadata(&transaction, metadata_key)?,
        }
        transaction.commit().map_err(AppError::from)
    }

    pub fn commit_dedupe_no_match(
        &self,
        task_id: &str,
        expected_fingerprint: &str,
        expected_candidate_fingerprint: &str,
    ) -> AppResult<bool> {
        validate_uuid(task_id, "taskId")?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let job_key = dedupe_job_key(task_id);
        let Some(encoded_job) = metadata_get(&transaction, &job_key)? else {
            transaction.commit().map_err(AppError::from)?;
            return Ok(false);
        };
        let job = decode_metadata::<DedupeJob>(&job_key, &encoded_job)?;
        if job.task_id != task_id {
            return Err(AppError::storage("dedupe job task id is corrupt"));
        }
        let Some(task) = load_task(&transaction, task_id)? else {
            delete_metadata(&transaction, &job_key)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(true);
        };
        if !task.is_active() {
            delete_metadata(&transaction, &job_key)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(true);
        }
        if task_fingerprint(&task)? != expected_fingerprint {
            transaction.commit().map_err(AppError::from)?;
            return Ok(false);
        }
        let candidates = load_active_dedupe_candidates(&transaction, task_id, &job)?;
        if candidate_set_fingerprint(&candidates)? != expected_candidate_fingerprint {
            transaction.commit().map_err(AppError::from)?;
            return Ok(false);
        }
        delete_metadata(&transaction, &job_key)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(true)
    }

    pub fn commit_dedupe_suggestion(
        &self,
        new_task_id: &str,
        expected_new_fingerprint: &str,
        expected_candidate_fingerprint: &str,
        existing_task_id: &str,
        expected_existing_fingerprint: &str,
        mut merged_task: MergedTaskDraft,
    ) -> AppResult<Option<DedupeSuggestion>> {
        validate_uuid(new_task_id, "newTaskId")?;
        validate_uuid(existing_task_id, "existingTaskId")?;
        if new_task_id == existing_task_id {
            return Err(AppError::invalid_input(
                "a task cannot be a duplicate of itself",
            ));
        }
        normalize_merged_draft(&mut merged_task, self.inner.clock.local_date())?;
        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let job_key = dedupe_job_key(new_task_id);
        let Some(encoded_job) = metadata_get(&transaction, &job_key)? else {
            transaction.commit().map_err(AppError::from)?;
            return Ok(None);
        };
        let job = decode_metadata::<DedupeJob>(&job_key, &encoded_job)?;
        if job.task_id != new_task_id {
            return Err(AppError::storage("dedupe job task id is corrupt"));
        }
        let Some(new_task) = load_task(&transaction, new_task_id)? else {
            delete_metadata(&transaction, &job_key)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(None);
        };
        if !new_task.is_active() {
            delete_metadata(&transaction, &job_key)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(None);
        }
        let candidates = load_active_dedupe_candidates(&transaction, new_task_id, &job)?;
        let current_candidate_fingerprint = candidate_set_fingerprint(&candidates)?;
        let existing_task = candidates
            .iter()
            .find(|candidate| candidate.task.id == existing_task_id);
        if task_fingerprint(&new_task)? != expected_new_fingerprint
            || current_candidate_fingerprint != expected_candidate_fingerprint
            || existing_task.map(|candidate| candidate.fingerprint.as_str())
                != Some(expected_existing_fingerprint)
        {
            transaction.commit().map_err(AppError::from)?;
            return Ok(None);
        }
        let existing_task = existing_task
            .expect("candidate fingerprint validation requires an existing task")
            .task
            .clone();

        let suggestion = DedupeSuggestion {
            id: Uuid::new_v4().to_string(),
            created_at: now,
            new_task,
            existing_task,
            new_task_fingerprint: expected_new_fingerprint.to_owned(),
            existing_task_fingerprint: expected_existing_fingerprint.to_owned(),
            merged_task,
        };
        metadata_set(
            &transaction,
            &dedupe_suggestion_key(&suggestion.id),
            &serde_json::to_string(&suggestion)?,
        )?;
        delete_metadata(&transaction, &job_key)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(Some(suggestion))
    }

    pub fn record_dedupe_job_failure(
        &self,
        task_id: &str,
        category: &str,
    ) -> AppResult<DedupeFailureDisposition> {
        validate_uuid(task_id, "taskId")?;
        validate_failure_category(category)?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let job_key = dedupe_job_key(task_id);
        let encoded =
            metadata_get(&transaction, &job_key)?.ok_or_else(|| AppError::not_found(task_id))?;
        let mut job = decode_metadata::<DedupeJob>(&job_key, &encoded)?;
        if job.task_id != task_id {
            return Err(AppError::storage("dedupe job task id is corrupt"));
        }
        job.attempts = job
            .attempts
            .checked_add(1)
            .ok_or_else(|| AppError::storage("dedupe attempt count overflow"))?;
        let disposition = if job.attempts >= MAX_DEDUPE_ATTEMPTS {
            let failed = FailedDedupeJob {
                task_id: job.task_id.clone(),
                enqueued_at: job.enqueued_at,
                attempts: job.attempts,
                category: category.to_owned(),
            };
            metadata_set(
                &transaction,
                &dedupe_failed_key(task_id),
                &serde_json::to_string(&failed)?,
            )?;
            delete_metadata(&transaction, &job_key)?;
            DedupeFailureDisposition::Parked
        } else {
            metadata_set(&transaction, &job_key, &serde_json::to_string(&job)?)?;
            DedupeFailureDisposition::Retrying
        };
        transaction.commit().map_err(AppError::from)?;
        Ok(disposition)
    }

    pub fn retry_failed_dedupe_jobs(&self) -> AppResult<u64> {
        let now = hlc::timestamp(self.inner.clock.now_millis())?;
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let failed = load_metadata_entries::<FailedDedupeJob>(&transaction, DEDUPE_FAILED_PREFIX)?;
        let mut retried = 0_u64;
        for (metadata_key, failed_job) in failed {
            if load_task(&transaction, &failed_job.task_id)?.is_some_and(|task| task.is_active()) {
                let job = DedupeJob {
                    task_id: failed_job.task_id.clone(),
                    enqueued_at: now.clone(),
                    attempts: 0,
                };
                metadata_set(
                    &transaction,
                    &dedupe_job_key(&failed_job.task_id),
                    &serde_json::to_string(&job)?,
                )?;
                retried += 1;
            }
            delete_metadata(&transaction, &metadata_key)?;
        }
        transaction.commit().map_err(AppError::from)?;
        Ok(retried)
    }

    pub fn list_dedupe_suggestions(&self) -> AppResult<Vec<DedupeSuggestion>> {
        let connection = self.inner.connection.lock();
        let mut suggestions =
            load_metadata_values::<DedupeSuggestion>(&connection, DEDUPE_SUGGESTION_PREFIX)?;
        suggestions.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(suggestions)
    }

    pub fn dismiss_dedupe_suggestion(&self, id: &str) -> AppResult<()> {
        validate_uuid(id, "id")?;
        let connection = self.inner.connection.lock();
        connection
            .execute(
                "DELETE FROM metadata WHERE key = ?1",
                [dedupe_suggestion_key(id)],
            )
            .map_err(AppError::from)?;
        Ok(())
    }

    pub fn resolve_dedupe_suggestion(
        &self,
        id: &str,
        action: DedupeResolutionAction,
    ) -> AppResult<DedupeResolutionOutcome> {
        validate_uuid(id, "id")?;
        let now_ms = self.inner.clock.now_millis();
        let now = hlc::timestamp(now_ms)?;
        let local_date = self.inner.clock.local_date();
        let mut connection = self.inner.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(AppError::from)?;
        let suggestion_key = dedupe_suggestion_key(id);
        let encoded = metadata_get(&transaction, &suggestion_key)?.ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "Dedupe suggestion not found")
                .with_details(json!({ "suggestionId": id }))
        })?;
        let mut suggestion = decode_metadata::<DedupeSuggestion>(&suggestion_key, &encoded)?;
        if suggestion.id != id {
            return Err(AppError::storage("dedupe suggestion id is corrupt"));
        }
        normalize_merged_draft(&mut suggestion.merged_task, local_date)?;
        let new_task = load_task(&transaction, &suggestion.new_task.id)?;
        let existing_task = load_task(&transaction, &suggestion.existing_task.id)?;
        let is_fresh = new_task.as_ref().is_some_and(|task| task.is_active())
            && existing_task.as_ref().is_some_and(|task| task.is_active())
            && new_task
                .as_ref()
                .map(task_fingerprint)
                .transpose()?
                .as_deref()
                == Some(suggestion.new_task_fingerprint.as_str())
            && existing_task
                .as_ref()
                .map(task_fingerprint)
                .transpose()?
                .as_deref()
                == Some(suggestion.existing_task_fingerprint.as_str());
        if !is_fresh {
            delete_metadata(&transaction, &suggestion_key)?;
            if new_task.as_ref().is_some_and(|task| task.is_active()) {
                let job = DedupeJob {
                    task_id: suggestion.new_task.id.clone(),
                    enqueued_at: now,
                    attempts: 0,
                };
                metadata_set(
                    &transaction,
                    &dedupe_job_key(&job.task_id),
                    &serde_json::to_string(&job)?,
                )?;
            }
            let revision = read_revision(&transaction)?;
            transaction.commit().map_err(AppError::from)?;
            return Ok(DedupeResolutionOutcome {
                status: DedupeResolutionStatus::Stale,
                revision,
                survivor: None,
                deleted_task_id: None,
                sync_required: false,
            });
        }

        let mut new_task = new_task.expect("freshness requires a new task");
        let mut existing_task = existing_task.expect("freshness requires an existing task");
        let (survivor, deleted_task_id) = match action {
            DedupeResolutionAction::DeleteNew => {
                tombstone_for_dedupe(&transaction, &mut new_task, now_ms, &now)?;
                (existing_task, new_task.id)
            }
            DedupeResolutionAction::DeleteExisting => {
                tombstone_for_dedupe(&transaction, &mut existing_task, now_ms, &now)?;
                (new_task, existing_task.id)
            }
            DedupeResolutionAction::Merge => {
                apply_merged_draft(
                    &transaction,
                    &mut existing_task,
                    &suggestion.merged_task,
                    &new_task.id,
                    now_ms,
                    &now,
                )?;
                tombstone_for_dedupe(&transaction, &mut new_task, now_ms, &now)?;
                (existing_task, new_task.id)
            }
        };
        delete_metadata(&transaction, &suggestion_key)?;
        let revision = bump_revision(&transaction)?;
        transaction.commit().map_err(AppError::from)?;
        Ok(DedupeResolutionOutcome {
            status: DedupeResolutionStatus::Resolved,
            revision,
            survivor: Some(survivor),
            deleted_task_id: Some(deleted_task_id),
            sync_required: true,
        })
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
    let has_migrations = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppError::from)?
        .is_some();
    let version = if has_migrations {
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
    if version > 3 {
        return Err(AppError::new(
            ErrorCode::ProtocolMismatch,
            "local database was created by a newer Todou version",
        ));
    }

    if version < 1 {
        apply_migration(connection, MIGRATION_1, 1, now_ms)?;
    }
    if version < 2 {
        apply_migration(connection, MIGRATION_2, 2, now_ms)?;
    }
    if version == 2 && !tasks_have_description(connection)? {
        // The unmerged In Progress branch used version 2 before descriptions landed.
        apply_legacy_description_migration(connection)?;
    }
    if version < 3 {
        connection
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(AppError::from)?;
        let migration = apply_migration(connection, MIGRATION_3, 3, now_ms);
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

fn apply_legacy_description_migration(connection: &mut Connection) -> AppResult<()> {
    let transaction = connection.transaction().map_err(AppError::from)?;
    transaction
        .execute_batch(MIGRATION_2)
        .map_err(AppError::from)?;
    transaction.commit().map_err(AppError::from)
}

fn tasks_have_description(connection: &Connection) -> AppResult<bool> {
    let mut statement = connection
        .prepare("PRAGMA table_info(tasks)")
        .map_err(AppError::from)?;
    let mut rows = statement.query([]).map_err(AppError::from)?;
    while let Some(row) = rows.next().map_err(AppError::from)? {
        if row.get::<_, String>(1).map_err(AppError::from)? == "description" {
            return Ok(true);
        }
    }
    Ok(false)
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

fn delete_metadata(transaction: &Transaction<'_>, key: &str) -> AppResult<()> {
    transaction
        .execute("DELETE FROM metadata WHERE key = ?1", [key])
        .map_err(AppError::from)?;
    Ok(())
}

fn load_metadata_entries<T>(connection: &Connection, prefix: &str) -> AppResult<Vec<(String, T)>>
where
    T: for<'de> Deserialize<'de>,
{
    let mut statement = connection
        .prepare("SELECT key, value FROM metadata WHERE key GLOB ?1 ORDER BY key")
        .map_err(AppError::from)?;
    let rows = statement
        .query_map([format!("{prefix}*")], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppError::from)?;
    let mut values = Vec::new();
    for row in rows {
        let (key, encoded) = row.map_err(AppError::from)?;
        values.push((key.clone(), decode_metadata(&key, &encoded)?));
    }
    Ok(values)
}

fn load_metadata_values<T>(connection: &Connection, prefix: &str) -> AppResult<Vec<T>>
where
    T: for<'de> Deserialize<'de>,
{
    Ok(load_metadata_entries(connection, prefix)?
        .into_iter()
        .map(|(_, value)| value)
        .collect())
}

fn decode_metadata<T>(key: &str, encoded: &str) -> AppResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(encoded)
        .map_err(|_| AppError::storage(format!("metadata value '{key}' is corrupt")))
}

fn metadata_prefix_count(connection: &Connection, prefix: &str) -> AppResult<u64> {
    let count = connection
        .query_row(
            "SELECT count(*) FROM metadata WHERE key GLOB ?1",
            [format!("{prefix}*")],
            |row| row.get::<_, i64>(0),
        )
        .map_err(AppError::from)?;
    u64::try_from(count).map_err(|_| AppError::storage("metadata count is invalid"))
}

fn dedupe_job_key(task_id: &str) -> String {
    format!("{DEDUPE_JOB_PREFIX}{task_id}")
}

fn dedupe_failed_key(task_id: &str) -> String {
    format!("{DEDUPE_FAILED_PREFIX}{task_id}")
}

fn dedupe_suggestion_key(id: &str) -> String {
    format!("{DEDUPE_SUGGESTION_PREFIX}{id}")
}

fn task_fingerprint(task: &Task) -> AppResult<String> {
    serde_json::to_string(&task.clocks).map_err(AppError::from)
}

fn task_snapshot(task: Task) -> AppResult<DedupeTaskSnapshot> {
    Ok(DedupeTaskSnapshot {
        fingerprint: task_fingerprint(&task)?,
        task,
    })
}

fn dedupe_job_cmp(left: &DedupeJob, right: &DedupeJob) -> Ordering {
    left.enqueued_at
        .cmp(&right.enqueued_at)
        .then_with(|| left.task_id.cmp(&right.task_id))
}

fn load_active_dedupe_candidates(
    connection: &Connection,
    new_task_id: &str,
    current_job: &DedupeJob,
) -> AppResult<Vec<DedupeTaskSnapshot>> {
    let pending_jobs = load_metadata_values::<DedupeJob>(connection, DEDUPE_JOB_PREFIX)?
        .into_iter()
        .map(|job| (job.task_id.clone(), job))
        .collect::<BTreeMap<_, _>>();
    let mut candidates = Vec::new();
    for task in load_all_tasks(connection)? {
        if task.id == new_task_id || !task.is_active() {
            continue;
        }
        let is_eligible = pending_jobs
            .get(&task.id)
            .is_none_or(|candidate_job| dedupe_job_cmp(candidate_job, current_job).is_lt());
        if is_eligible {
            candidates.push(task_snapshot(task)?);
        }
    }
    candidates.sort_by(|left, right| active_cmp(&left.task, &right.task));
    Ok(candidates)
}

fn candidate_set_fingerprint(candidates: &[DedupeTaskSnapshot]) -> AppResult<String> {
    serde_json::to_string(
        &candidates
            .iter()
            .map(|candidate| (&candidate.task.id, &candidate.fingerprint))
            .collect::<Vec<_>>(),
    )
    .map_err(AppError::from)
}

fn usable_key(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn environment_key(name: &str) -> Option<String> {
    usable_key(std::env::var(name).ok())
}

fn effective_api_key(
    connection: &Connection,
    metadata_key: &str,
    environment_name: &str,
) -> AppResult<Option<String>> {
    Ok(usable_key(metadata_get(connection, metadata_key)?)
        .or_else(|| environment_key(environment_name)))
}

fn credential_status(
    connection: &Connection,
    metadata_key: &str,
    environment_name: &str,
) -> AppResult<LlmCredentialStatus> {
    if usable_key(metadata_get(connection, metadata_key)?).is_some() {
        return Ok(LlmCredentialStatus {
            configured: true,
            source: Some(LlmCredentialSource::Saved),
        });
    }
    if environment_key(environment_name).is_some() {
        return Ok(LlmCredentialStatus {
            configured: true,
            source: Some(LlmCredentialSource::Environment),
        });
    }
    Ok(LlmCredentialStatus {
        configured: false,
        source: None,
    })
}

fn validate_failure_category(category: &str) -> AppResult<()> {
    if category.is_empty()
        || category.len() > 64
        || !category
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(AppError::invalid_input(
            "dedupe failure category must be a safe identifier",
        ));
    }
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
        description: row.get(20)?,
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
            description: row.get(21)?,
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
                deletion_clock, description, description_clock
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
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
                completion_clock = ?19, deletion_clock = ?20, description = ?21,
                description_clock = ?22
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

fn normalize_merged_draft(
    draft: &mut MergedTaskDraft,
    local_date: chrono::NaiveDate,
) -> AppResult<()> {
    draft.title = crate::domain::normalize_title(&draft.title)?;
    draft.description = crate::domain::normalize_description(&draft.description)?;
    validate_due_date(draft.due_date.as_deref())?;
    validate_estimate(draft.estimate_minutes)?;
    if draft.bucket == Bucket::Inbox
        && draft
            .due_date
            .as_deref()
            .map(parse_due_date)
            .transpose()?
            .is_some_and(|date| date <= local_date)
    {
        draft.bucket = Bucket::Today;
    }
    Ok(())
}

fn apply_merged_draft(
    transaction: &Transaction<'_>,
    task: &mut Task,
    draft: &MergedTaskDraft,
    released_task_id: &str,
    now_ms: i64,
    now: &str,
) -> AppResult<()> {
    let previous_bucket = task.bucket;
    let previous_priority = task.priority;
    let mut changed = BTreeSet::new();

    if task.title != draft.title {
        task.title = draft.title.clone();
        changed.insert("title");
    }
    if task.description != draft.description {
        task.description = draft.description.clone();
        changed.insert("description");
    }
    if task.bucket != draft.bucket && draft.bucket == Bucket::InProgress {
        ensure_in_progress_capacity_after_dedupe(transaction, task.id.as_str(), released_task_id)?;
    }
    if task.bucket != draft.bucket || task.due_date != draft.due_date {
        task.bucket = draft.bucket;
        task.due_date = draft.due_date.clone();
        changed.insert("schedule");
    }
    if task.priority != draft.priority {
        task.priority = draft.priority;
        changed.insert("priority");
    }
    if task.area != draft.area {
        task.area = draft.area;
        changed.insert("area");
    }
    if task.estimate_minutes != draft.estimate_minutes {
        task.estimate_minutes = draft.estimate_minutes;
        changed.insert("estimate");
    }
    if task.bucket != previous_bucket || task.priority != previous_priority {
        task.order_key = next_tier_key(
            transaction,
            task.bucket,
            task.priority,
            Some(task.id.as_str()),
        )?;
        changed.insert("order");
    }
    if changed.is_empty() {
        return Ok(());
    }

    let stamp = next_stamp(transaction, now_ms)?;
    apply_clock(&mut task.clocks, &changed, &stamp);
    task.updated_at = now.to_owned();
    task.validate()?;
    update_task_row(transaction, task)?;
    let changed_names = changed.into_iter().collect::<Vec<_>>();
    enqueue_registers(transaction, task, &changed_names, now)?;
    Ok(())
}

fn tombstone_for_dedupe(
    transaction: &Transaction<'_>,
    task: &mut Task,
    now_ms: i64,
    now: &str,
) -> AppResult<()> {
    if !task.is_active() {
        return Err(AppError::new(
            ErrorCode::InvalidTransition,
            "dedupe resolution task is no longer active",
        ));
    }
    task.deleted_at = Some(now.to_owned());
    task.updated_at = now.to_owned();
    task.clocks.deletion = next_stamp(transaction, now_ms)?;
    task.validate()?;
    update_task_row(transaction, task)?;
    enqueue_registers(transaction, task, &["deletion"], now)?;
    Ok(())
}

fn task_params(task: &Task) -> [rusqlite::types::Value; 22] {
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
        SqlValue::Text(task.description.clone()),
        SqlValue::Text(task.clocks.description.clone()),
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

fn ensure_in_progress_capacity_after_dedupe(
    connection: &Connection,
    survivor_id: &str,
    released_task_id: &str,
) -> AppResult<()> {
    let count = connection
        .query_row(
            "SELECT count(*) FROM tasks
             WHERE bucket = 'in_progress' AND completed_at IS NULL AND deleted_at IS NULL
               AND id != ?1 AND id != ?2",
            params![survivor_id, released_task_id],
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
            "description" => clocks.description = stamp.to_owned(),
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
            "description" => (&task.clocks.description, json!(task.description)),
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
        "description",
        &local.clocks.description,
        &remote.clocks.description,
        &local.description,
        &remote.description,
    )?;
    if remote.clocks.description > local.clocks.description {
        local.description = remote.description.clone();
        local.clocks.description = remote.clocks.description.clone();
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
            "description",
            local.clocks.description.as_str(),
            remote.clocks.description.as_str(),
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

#[cfg(test)]
mod dedupe_tests {
    use super::{DedupeResolutionAction, DedupeResolutionStatus, LlmCredentialSource, TaskService};
    use crate::{
        domain::{
            Area, BootstrapPayload, Bucket, CreateTaskInput, Priority, TaskFilter, UpdateTaskPatch,
            PROTOCOL_VERSION,
        },
        error::ErrorCode,
        hlc::ClockSource,
        llm::{MergedTaskDraft, Provider},
    };
    use chrono::NaiveDate;
    use serde_json::Value;
    use std::sync::Arc;
    use uuid::Uuid;

    struct FixedClock;

    impl ClockSource for FixedClock {
        fn now_millis(&self) -> i64 {
            1_784_521_200_000
        }

        fn local_date(&self) -> NaiveDate {
            NaiveDate::from_ymd_opt(2026, 7, 20).unwrap()
        }
    }

    fn service() -> TaskService {
        TaskService::in_memory_with_clock(Arc::new(FixedClock)).unwrap()
    }

    fn input(title: &str) -> CreateTaskInput {
        CreateTaskInput {
            id: None,
            title: title.into(),
            bucket: Bucket::Inbox,
            priority: Priority::Low,
            area: Area::Personal,
            due_date: None,
            estimate_minutes: None,
        }
    }

    fn identified_input(title: &str, sequence: u64) -> CreateTaskInput {
        let mut input = input(title);
        input.id = Some(format!("00000000-0000-4000-8000-{sequence:012}"));
        input
    }

    fn merged(title: &str) -> MergedTaskDraft {
        MergedTaskDraft {
            title: title.into(),
            description: "Combined details from both tasks".into(),
            bucket: Bucket::Inbox,
            priority: Priority::High,
            area: Area::Work,
            due_date: Some("2026-07-19".into()),
            estimate_minutes: Some(45),
        }
    }

    fn clear_outbox(service: &TaskService) {
        service
            .inner
            .connection
            .lock()
            .execute("DELETE FROM outbox", [])
            .unwrap();
    }

    fn suggestion(
        service: &TaskService,
        new_task_id: &str,
        existing_task_id: &str,
    ) -> super::DedupeSuggestion {
        suggestion_with_draft(
            service,
            new_task_id,
            existing_task_id,
            merged("Reconciled task"),
        )
    }

    fn suggestion_with_draft(
        service: &TaskService,
        new_task_id: &str,
        existing_task_id: &str,
        draft: MergedTaskDraft,
    ) -> super::DedupeSuggestion {
        let context = service
            .prepare_dedupe_context(new_task_id)
            .unwrap()
            .unwrap();
        let existing = context
            .active_candidates
            .iter()
            .find(|candidate| candidate.task.id == existing_task_id)
            .unwrap();
        service
            .commit_dedupe_suggestion(
                new_task_id,
                &context.new_task.fingerprint,
                &context.candidate_fingerprint,
                existing_task_id,
                &existing.fingerprint,
                draft,
            )
            .unwrap()
            .unwrap()
    }

    #[test]
    fn local_create_enqueues_but_remote_import_does_not() {
        let local = service();
        let created = local.create_task(input("Local task")).unwrap().result;
        let jobs = local.list_pending_dedupe_jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].task_id, created.id);
        assert_eq!(jobs[0].attempts, 0);

        let remote = service();
        remote
            .bootstrap_remote(BootstrapPayload {
                protocol_version: PROTOCOL_VERSION,
                epoch: Uuid::new_v4().to_string(),
                watermark: 1,
                tasks: vec![created],
            })
            .unwrap();
        assert!(remote.list_pending_dedupe_jobs().unwrap().is_empty());
    }

    #[test]
    fn queued_jobs_only_compare_against_stably_older_tasks() {
        let service = service();
        let older = service
            .create_task(identified_input("Older", 1))
            .unwrap()
            .result;
        let newer = service
            .create_task(identified_input("Newer", 2))
            .unwrap()
            .result;

        let jobs = service.list_pending_dedupe_jobs().unwrap();
        assert_eq!(
            jobs.iter()
                .map(|job| job.task_id.as_str())
                .collect::<Vec<_>>(),
            vec![older.id.as_str(), newer.id.as_str()]
        );
        assert!(service
            .prepare_dedupe_context(&older.id)
            .unwrap()
            .unwrap()
            .active_candidates
            .is_empty());
        assert_eq!(
            service
                .prepare_dedupe_context(&newer.id)
                .unwrap()
                .unwrap()
                .active_candidates[0]
                .task
                .id,
            older.id
        );
    }

    #[test]
    fn context_includes_remote_tasks_with_later_creation_clocks() {
        let local = service();
        let new_task = local
            .create_task(identified_input("Local new task", 2))
            .unwrap()
            .result;
        let remote_source = service();
        let mut remote = remote_source
            .create_task(identified_input("Remote existing task", 1))
            .unwrap()
            .result;
        remote.created_at = "2030-01-01T00:00:00.000Z".into();
        local
            .bootstrap_remote(BootstrapPayload {
                protocol_version: PROTOCOL_VERSION,
                epoch: Uuid::new_v4().to_string(),
                watermark: 1,
                tasks: vec![remote.clone()],
            })
            .unwrap();

        let context = local.prepare_dedupe_context(&new_task.id).unwrap().unwrap();

        assert!(context
            .active_candidates
            .iter()
            .any(|candidate| candidate.task.id == remote.id));
    }

    #[test]
    fn context_separates_active_logbook_and_deleted_tasks() {
        let service = service();
        let active = service
            .create_task(identified_input("Active", 1))
            .unwrap()
            .result;
        let completed = service
            .create_task(identified_input("Completed", 2))
            .unwrap()
            .result;
        service.complete_task(&completed.id).unwrap();
        let deleted = service
            .create_task(identified_input("Deleted", 3))
            .unwrap()
            .result;
        service.delete_task(&deleted.id).unwrap();
        let new_task = service
            .create_task(identified_input("New", 4))
            .unwrap()
            .result;

        let context = service
            .prepare_dedupe_context(&new_task.id)
            .unwrap()
            .unwrap();

        assert_eq!(context.new_task.task.id, new_task.id);
        assert_eq!(
            context
                .active_candidates
                .iter()
                .map(|snapshot| snapshot.task.id.as_str())
                .collect::<Vec<_>>(),
            vec![active.id.as_str()]
        );
        assert_eq!(
            context
                .logbook_context
                .iter()
                .map(|snapshot| snapshot.task.id.as_str())
                .collect::<Vec<_>>(),
            vec![completed.id.as_str()]
        );
    }

    #[test]
    fn no_match_only_consumes_an_unchanged_job() {
        let service = service();
        let new_task = service.create_task(input("Original")).unwrap().result;
        let stale = service
            .prepare_dedupe_context(&new_task.id)
            .unwrap()
            .unwrap();
        service
            .update_task(
                &new_task.id,
                UpdateTaskPatch {
                    title: Some("Changed".into()),
                    ..UpdateTaskPatch::default()
                },
            )
            .unwrap();

        assert!(!service
            .commit_dedupe_no_match(
                &new_task.id,
                &stale.new_task.fingerprint,
                &stale.candidate_fingerprint,
            )
            .unwrap());
        assert_eq!(service.list_pending_dedupe_jobs().unwrap().len(), 1);

        let current = service
            .prepare_dedupe_context(&new_task.id)
            .unwrap()
            .unwrap();
        assert!(service
            .commit_dedupe_no_match(
                &new_task.id,
                &current.new_task.fingerprint,
                &current.candidate_fingerprint,
            )
            .unwrap());
        assert!(service.list_pending_dedupe_jobs().unwrap().is_empty());
    }

    #[test]
    fn no_match_keeps_the_job_when_a_candidate_changes() {
        let service = service();
        let existing = service
            .create_task(identified_input("Existing", 1))
            .unwrap()
            .result;
        let new_task = service
            .create_task(identified_input("New", 2))
            .unwrap()
            .result;
        let context = service
            .prepare_dedupe_context(&new_task.id)
            .unwrap()
            .unwrap();
        service
            .update_task(
                &existing.id,
                UpdateTaskPatch {
                    title: Some("Now matches the new task".into()),
                    ..UpdateTaskPatch::default()
                },
            )
            .unwrap();

        assert!(!service
            .commit_dedupe_no_match(
                &new_task.id,
                &context.new_task.fingerprint,
                &context.candidate_fingerprint,
            )
            .unwrap());
        assert!(service
            .list_pending_dedupe_jobs()
            .unwrap()
            .iter()
            .any(|job| job.task_id == new_task.id));
    }

    #[test]
    fn deterministic_failures_park_after_three_attempts_and_can_retry() {
        let service = service();
        let task = service.create_task(input("Retry me")).unwrap().result;

        assert_eq!(
            service
                .record_dedupe_job_failure(&task.id, "provider_response")
                .unwrap(),
            super::DedupeFailureDisposition::Retrying
        );
        assert_eq!(service.list_pending_dedupe_jobs().unwrap()[0].attempts, 1);
        assert_eq!(
            service
                .record_dedupe_job_failure(&task.id, "provider_response")
                .unwrap(),
            super::DedupeFailureDisposition::Retrying
        );
        assert_eq!(
            service
                .record_dedupe_job_failure(&task.id, "provider_response")
                .unwrap(),
            super::DedupeFailureDisposition::Parked
        );
        assert_eq!(
            service.dedupe_counts().unwrap(),
            super::DedupeCounts {
                pending: 0,
                failed: 1
            }
        );

        assert_eq!(service.retry_failed_dedupe_jobs().unwrap(), 1);
        assert_eq!(
            service.dedupe_counts().unwrap(),
            super::DedupeCounts {
                pending: 1,
                failed: 0
            }
        );
        assert_eq!(service.list_pending_dedupe_jobs().unwrap()[0].attempts, 0);
    }

    #[test]
    fn suggestion_commit_rejects_a_changed_candidate() {
        let service = service();
        let existing = service
            .create_task(identified_input("Existing", 1))
            .unwrap()
            .result;
        let new_task = service
            .create_task(identified_input("New", 2))
            .unwrap()
            .result;
        let context = service
            .prepare_dedupe_context(&new_task.id)
            .unwrap()
            .unwrap();
        let candidate = &context.active_candidates[0];
        service
            .update_task(
                &existing.id,
                UpdateTaskPatch {
                    title: Some("Changed while provider ran".into()),
                    ..UpdateTaskPatch::default()
                },
            )
            .unwrap();

        assert!(service
            .commit_dedupe_suggestion(
                &new_task.id,
                &context.new_task.fingerprint,
                &context.candidate_fingerprint,
                &existing.id,
                &candidate.fingerprint,
                merged("Should not persist"),
            )
            .unwrap()
            .is_none());
        assert!(service.list_dedupe_suggestions().unwrap().is_empty());
        assert!(service
            .list_pending_dedupe_jobs()
            .unwrap()
            .iter()
            .any(|job| job.task_id == new_task.id));
    }

    #[test]
    fn merge_resolution_reconciles_all_fields_atomically() {
        let service = service();
        let existing = service
            .create_task(identified_input("Existing", 1))
            .unwrap()
            .result;
        let existing_order = existing.order_key.clone();
        let new_task = service
            .create_task(identified_input("New", 2))
            .unwrap()
            .result;
        let suggestion = suggestion(&service, &new_task.id, &existing.id);
        clear_outbox(&service);
        let revision = service.revision().unwrap();

        let outcome = service
            .resolve_dedupe_suggestion(&suggestion.id, DedupeResolutionAction::Merge)
            .unwrap();

        assert_eq!(outcome.status, DedupeResolutionStatus::Resolved);
        assert_eq!(outcome.revision, revision + 1);
        assert!(outcome.sync_required);
        let survivor = outcome.survivor.unwrap();
        assert_eq!(survivor.id, existing.id);
        assert_eq!(survivor.title, "Reconciled task");
        assert_eq!(survivor.description, "Combined details from both tasks");
        assert_eq!(survivor.bucket, Bucket::Today);
        assert_eq!(survivor.priority, Priority::High);
        assert_eq!(survivor.area, Area::Work);
        assert_eq!(survivor.due_date.as_deref(), Some("2026-07-19"));
        assert_eq!(survivor.estimate_minutes, Some(45));
        assert_ne!(survivor.order_key, existing_order);
        assert!(service.get_task(&new_task.id).is_err());
        assert!(service.list_dedupe_suggestions().unwrap().is_empty());

        let connection = service.inner.connection.lock();
        let mut statement = connection
            .prepare("SELECT task_id, registers_json FROM outbox ORDER BY local_sequence")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        let survivor_registers: Value = serde_json::from_str(&rows[0].1).unwrap();
        assert_eq!(rows[0].0, existing.id);
        assert_eq!(
            survivor_registers
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "area",
                "description",
                "estimate",
                "order",
                "priority",
                "schedule",
                "title"
            ]
        );
        let deletion_registers: Value = serde_json::from_str(&rows[1].1).unwrap();
        assert_eq!(rows[1].0, new_task.id);
        assert_eq!(
            deletion_registers
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["deletion"]
        );
    }

    #[test]
    fn merge_rejects_an_in_progress_result_when_three_other_tasks_are_active() {
        let service = service();
        for sequence in 1..=3 {
            let mut input = identified_input(&format!("Active {sequence}"), sequence);
            input.bucket = Bucket::InProgress;
            service.create_task(input).unwrap();
        }
        let existing = service
            .create_task(identified_input("Existing", 4))
            .unwrap()
            .result;
        let new_task = service
            .create_task(identified_input("New", 5))
            .unwrap()
            .result;
        let mut draft = merged("Reconciled task");
        draft.bucket = Bucket::InProgress;
        draft.due_date = None;
        let suggestion = suggestion_with_draft(&service, &new_task.id, &existing.id, draft);
        clear_outbox(&service);
        let revision = service.revision().unwrap();

        let error = service
            .resolve_dedupe_suggestion(&suggestion.id, DedupeResolutionAction::Merge)
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::InvalidTransition);
        assert_eq!(service.revision().unwrap(), revision);
        assert_eq!(
            service.get_task(&existing.id).unwrap().result.title,
            "Existing"
        );
        assert_eq!(service.get_task(&new_task.id).unwrap().result.title, "New");
        assert_eq!(service.next_outbox(100).unwrap().result.len(), 0);
        assert_eq!(service.list_dedupe_suggestions().unwrap(), vec![suggestion]);
    }

    #[test]
    fn merge_can_reuse_the_in_progress_slot_held_by_the_deleted_duplicate() {
        let service = service();
        for sequence in 1..=2 {
            let mut input = identified_input(&format!("Active {sequence}"), sequence);
            input.bucket = Bucket::InProgress;
            service.create_task(input).unwrap();
        }
        let existing = service
            .create_task(identified_input("Existing", 3))
            .unwrap()
            .result;
        let mut new_input = identified_input("New", 4);
        new_input.bucket = Bucket::InProgress;
        let new_task = service.create_task(new_input).unwrap().result;
        let mut draft = merged("Reconciled task");
        draft.bucket = Bucket::InProgress;
        draft.due_date = None;
        let suggestion = suggestion_with_draft(&service, &new_task.id, &existing.id, draft);

        let outcome = service
            .resolve_dedupe_suggestion(&suggestion.id, DedupeResolutionAction::Merge)
            .unwrap();

        assert_eq!(outcome.status, DedupeResolutionStatus::Resolved);
        assert_eq!(outcome.survivor.unwrap().bucket, Bucket::InProgress);
        assert_eq!(
            service
                .list_tasks(TaskFilter {
                    bucket: Some(Bucket::InProgress),
                    completed: Some(false),
                    ..TaskFilter::default()
                })
                .unwrap()
                .result
                .len(),
            3
        );
    }

    #[test]
    fn merge_keeps_an_overdue_in_progress_schedule_in_progress() {
        let service = service();
        let existing = service
            .create_task(identified_input("Existing", 1))
            .unwrap()
            .result;
        let new_task = service
            .create_task(identified_input("New", 2))
            .unwrap()
            .result;
        let mut draft = merged("Reconciled task");
        draft.bucket = Bucket::InProgress;
        draft.due_date = Some("2026-07-19".into());
        let suggestion = suggestion_with_draft(&service, &new_task.id, &existing.id, draft);

        assert_eq!(suggestion.merged_task.bucket, Bucket::InProgress);
        assert_eq!(
            suggestion.merged_task.due_date.as_deref(),
            Some("2026-07-19")
        );
        let survivor = service
            .resolve_dedupe_suggestion(&suggestion.id, DedupeResolutionAction::Merge)
            .unwrap()
            .survivor
            .unwrap();
        assert_eq!(survivor.bucket, Bucket::InProgress);
        assert_eq!(survivor.due_date.as_deref(), Some("2026-07-19"));
    }

    #[test]
    fn stale_resolution_applies_no_partial_mutation_and_requeues() {
        let service = service();
        let existing = service
            .create_task(identified_input("Existing", 1))
            .unwrap()
            .result;
        let new_task = service
            .create_task(identified_input("New", 2))
            .unwrap()
            .result;
        let suggestion = suggestion(&service, &new_task.id, &existing.id);
        service
            .update_task(
                &existing.id,
                UpdateTaskPatch {
                    description: Some("Changed while the suggestion was open".into()),
                    ..UpdateTaskPatch::default()
                },
            )
            .unwrap();
        clear_outbox(&service);
        let revision = service.revision().unwrap();

        let outcome = service
            .resolve_dedupe_suggestion(&suggestion.id, DedupeResolutionAction::Merge)
            .unwrap();

        assert_eq!(outcome.status, DedupeResolutionStatus::Stale);
        assert_eq!(outcome.revision, revision);
        assert!(!outcome.sync_required);
        assert_eq!(
            service.get_task(&existing.id).unwrap().result.title,
            "Existing"
        );
        assert_eq!(
            service.get_task(&existing.id).unwrap().result.description,
            "Changed while the suggestion was open"
        );
        assert_eq!(service.get_task(&new_task.id).unwrap().result.title, "New");
        assert_eq!(service.next_outbox(100).unwrap().result.len(), 0);
        assert!(service.list_dedupe_suggestions().unwrap().is_empty());
        assert!(service
            .list_pending_dedupe_jobs()
            .unwrap()
            .iter()
            .any(|job| job.task_id == new_task.id));
    }

    #[test]
    fn either_duplicate_can_be_deleted() {
        for (action, deleted_new) in [
            (DedupeResolutionAction::DeleteNew, true),
            (DedupeResolutionAction::DeleteExisting, false),
        ] {
            let service = service();
            let existing = service
                .create_task(identified_input("Existing", 1))
                .unwrap()
                .result;
            let new_task = service
                .create_task(identified_input("New", 2))
                .unwrap()
                .result;
            let suggestion = suggestion(&service, &new_task.id, &existing.id);
            clear_outbox(&service);

            let outcome = service
                .resolve_dedupe_suggestion(&suggestion.id, action)
                .unwrap();

            assert_eq!(outcome.status, DedupeResolutionStatus::Resolved);
            let deleted_id = if deleted_new {
                &new_task.id
            } else {
                &existing.id
            };
            let survivor_id = if deleted_new {
                &existing.id
            } else {
                &new_task.id
            };
            assert_eq!(
                outcome.deleted_task_id.as_deref(),
                Some(deleted_id.as_str())
            );
            assert_eq!(outcome.survivor.unwrap().id, *survivor_id);
            assert!(service.get_task(deleted_id).is_err());
            assert_eq!(
                service.get_task(survivor_id).unwrap().result.id,
                *survivor_id
            );
            let outbox = service.next_outbox(100).unwrap().result;
            assert_eq!(outbox.len(), 1);
            assert_eq!(outbox[0].task_id, *deleted_id);
            assert_eq!(
                outbox[0]
                    .registers
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                vec!["deletion"]
            );
        }
    }

    #[test]
    fn credentials_are_shared_privately_and_status_is_redacted() {
        let service = service();
        service
            .set_llm_api_key(Provider::OpenAi, Some("sk-test-secret"))
            .unwrap();

        assert_eq!(
            service.llm_credentials().unwrap().openai.as_deref(),
            Some("sk-test-secret")
        );
        let status = service.llm_credential_status().unwrap();
        assert!(status.openai.configured);
        assert_eq!(status.openai.source, Some(LlmCredentialSource::Saved));
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains("sk-test-secret"));
    }
}
