use crate::{
    domain::{
        Area, BootstrapPayload, Bucket, OutboxMutation, Priority, RemoteChange, RemotePage, Task,
        TaskClocks, PROTOCOL_VERSION,
    },
    error::ErrorCode,
    service::TaskService,
};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::{Client, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fmt,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

const PUSH_BATCH: u32 = 100;
const MAX_PUSHES_PER_CYCLE: usize = 1_000;
const PULL_BATCH: u32 = 200;
const MAX_PULL_PAGES_PER_CYCLE: usize = 50;

#[derive(Clone, Copy, Serialize)]
#[repr(u8)]
#[serde(rename_all = "kebab-case")]
enum SyncStatus {
    NotConnected = 0,
    Updating = 1,
    UpToDate = 2,
}

impl SyncStatus {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Updating,
            2 => Self::UpToDate,
            _ => Self::NotConnected,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::UpToDate => "up-to-date",
            Self::Updating => "updating",
            Self::NotConnected => "not-connected",
        }
    }
}

fn publish_sync_status(app: &AppHandle, wake: &SyncWake, status: SyncStatus) {
    wake.set_status(status);
    if let Err(error) = app.emit("todou://sync-status", status) {
        tracing::warn!(%error, "could not emit sync status");
    }
}

#[derive(Clone, Default)]
pub struct SyncWake {
    inner: Arc<WakeInner>,
}

#[derive(Default)]
struct WakeInner {
    generation: AtomicU64,
    status: AtomicU8,
    notify: Notify,
}

impl SyncWake {
    pub fn wake(&self) -> u64 {
        let generation = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.inner.notify.notify_one();
        generation
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::Acquire)
    }

    pub fn status(&self) -> &'static str {
        SyncStatus::from_u8(self.inner.status.load(Ordering::Acquire)).as_str()
    }

    fn set_status(&self, status: SyncStatus) {
        self.inner.status.store(status as u8, Ordering::Release);
    }

    pub async fn changed_after(&self, generation: u64) -> u64 {
        loop {
            let current = self.generation();
            if current > generation {
                return current;
            }
            self.inner.notify.notified().await;
        }
    }
}

#[derive(Debug, Clone)]
struct SupabaseConfig {
    url: String,
    publishable_key: String,
}

impl SupabaseConfig {
    fn load(service: &TaskService) -> Result<Option<Self>, SyncFailure> {
        let (stored_url, stored_key) = service
            .sync_preferences()
            .map_err(|error| SyncFailure::permanent(error.to_string()))?;
        let url = stored_url.or_else(|| env::var("TODOU_SUPABASE_URL").ok());
        let publishable_key =
            stored_key.or_else(|| env::var("TODOU_SUPABASE_PUBLISHABLE_KEY").ok());
        match (url, publishable_key) {
            (None, None) => Ok(None),
            (Some(url), Some(publishable_key)) => Ok(Some(Self {
                url: url.trim_end_matches('/').to_owned(),
                publishable_key,
            })),
            _ => Err(SyncFailure::permanent(
                "both supabaseUrl and supabasePublishableKey must be configured",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    Retryable,
    Permanent,
    EpochMismatch,
}

#[derive(Debug, Clone)]
struct SyncFailure {
    kind: FailureKind,
    message: String,
}

impl SyncFailure {
    fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Retryable,
            message: message.into(),
        }
    }

    fn permanent(message: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Permanent,
            message: message.into(),
        }
    }
}

impl fmt::Display for SyncFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

struct SupabaseTransport {
    client: Client,
    config: SupabaseConfig,
}

impl SupabaseTransport {
    fn new(client: Client, config: SupabaseConfig) -> Self {
        Self { client, config }
    }

    async fn apply(&self, mutation: &OutboxMutation) -> Result<Task, SyncFailure> {
        #[derive(Deserialize)]
        struct ApplyRow {
            snapshot: RemoteTaskRow,
        }

        let rows: Vec<ApplyRow> = self
            .rpc(
                "apply_task_mutation",
                &json!({
                    "p_operation_id": mutation.operation_id,
                    "p_task_id": mutation.task_id,
                    "p_protocol_version": mutation.protocol_version,
                    "p_registers": mutation.registers,
                }),
            )
            .await?;
        let row = rows.into_iter().next().ok_or_else(|| {
            SyncFailure::retryable("apply_task_mutation returned no acknowledgement")
        })?;
        row.snapshot.into_task()
    }

    async fn pull(&self, epoch: &str, after: u64) -> Result<RemotePage, SyncFailure> {
        #[derive(Deserialize)]
        struct PullRow {
            seq: u64,
            protocol_version: u32,
            snapshot: RemoteTaskRow,
        }

        let rows: Vec<PullRow> = self
            .rpc(
                "pull_task_changes",
                &json!({
                    "p_epoch": epoch,
                    "p_after_seq": after,
                    "p_limit": PULL_BATCH,
                }),
            )
            .await?;
        let mut changes = Vec::with_capacity(rows.len());
        for row in rows {
            if row.protocol_version != PROTOCOL_VERSION {
                return Err(SyncFailure::permanent(format!(
                    "unsupported remote protocol version {}",
                    row.protocol_version
                )));
            }
            changes.push(RemoteChange {
                seq: row.seq,
                task: row.snapshot.into_task()?,
            });
        }
        Ok(RemotePage {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch.to_owned(),
            changes,
        })
    }

    async fn bootstrap(&self) -> Result<BootstrapPayload, SyncFailure> {
        let row: BootstrapRow = self.rpc("bootstrap_tasks", &json!({})).await?;
        let mut tasks = Vec::with_capacity(row.tasks.len());
        for task in row.tasks {
            tasks.push(task.into_task()?);
        }
        Ok(BootstrapPayload {
            protocol_version: row.protocol_version,
            epoch: row.epoch,
            watermark: row.watermark,
            tasks,
        })
    }

    async fn head(&self) -> Result<RemoteHead, SyncFailure> {
        let response = self
            .client
            .get(format!(
                "{}/rest/v1/sync_head?select=epoch,last_seq&singleton=eq.true",
                self.config.url
            ))
            .header("apikey", &self.config.publishable_key)
            .send()
            .await
            .map_err(|error| SyncFailure::retryable(format!("Supabase request failed: {error}")))?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            SyncFailure::retryable(format!("Supabase response failed: {error}"))
        })?;
        if !status.is_success() {
            return Err(classify_http_failure(status, &body));
        }
        let rows: Vec<RemoteHead> = serde_json::from_str(&body).map_err(|error| {
            SyncFailure::permanent(format!("Invalid Supabase response: {error}"))
        })?;
        rows.into_iter()
            .next()
            .ok_or_else(|| SyncFailure::permanent("Supabase sync head is missing"))
    }

    async fn rpc<T: DeserializeOwned, P: Serialize + ?Sized>(
        &self,
        function: &str,
        payload: &P,
    ) -> Result<T, SyncFailure> {
        let response = self
            .client
            .post(format!("{}/rest/v1/rpc/{function}", self.config.url))
            .header("apikey", &self.config.publishable_key)
            .json(payload)
            .send()
            .await
            .map_err(|error| SyncFailure::retryable(format!("Supabase request failed: {error}")))?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            SyncFailure::retryable(format!("Supabase response failed: {error}"))
        })?;
        if !status.is_success() {
            return Err(classify_http_failure(status, &body));
        }
        serde_json::from_str(&body)
            .map_err(|error| SyncFailure::retryable(format!("Invalid Supabase response: {error}")))
    }
}

#[derive(Debug, Deserialize)]
struct BootstrapRow {
    protocol_version: u32,
    epoch: String,
    watermark: u64,
    tasks: Vec<RemoteTaskRow>,
}

#[derive(Debug, Deserialize)]
struct RemoteHead {
    epoch: String,
    last_seq: u64,
}

#[derive(Debug, Deserialize)]
struct RemoteTaskRow {
    id: String,
    title: String,
    bucket: Bucket,
    priority: Priority,
    area: Area,
    due_date: Option<String>,
    estimate_minutes: Option<u16>,
    order_key: String,
    completed_at: Option<String>,
    deleted_at: Option<String>,
    created_at: String,
    updated_at: String,
    title_clock: String,
    schedule_clock: String,
    priority_clock: String,
    area_clock: String,
    estimate_clock: String,
    order_clock: String,
    completion_clock: String,
    deletion_clock: String,
}

fn canonical_remote_timestamp(value: String, field: &str) -> Result<String, SyncFailure> {
    DateTime::parse_from_rfc3339(&value)
        .map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| {
            SyncFailure::retryable(format!(
                "Invalid Supabase response: {field} must be an RFC 3339 timestamp"
            ))
        })
}

impl RemoteTaskRow {
    fn into_task(self) -> Result<Task, SyncFailure> {
        let completed_at = self
            .completed_at
            .map(|value| canonical_remote_timestamp(value, "completed_at"))
            .transpose()?;
        let deleted_at = self
            .deleted_at
            .map(|value| canonical_remote_timestamp(value, "deleted_at"))
            .transpose()?;
        let created_at = canonical_remote_timestamp(self.created_at, "created_at")?;
        let updated_at = canonical_remote_timestamp(self.updated_at, "updated_at")?;
        let task = Task {
            id: self.id,
            title: self.title,
            bucket: self.bucket,
            priority: self.priority,
            area: self.area,
            due_date: self.due_date,
            estimate_minutes: self.estimate_minutes,
            order_key: self.order_key,
            completed_at,
            deleted_at,
            created_at,
            updated_at,
            clocks: TaskClocks {
                title: self.title_clock,
                schedule: self.schedule_clock,
                priority: self.priority_clock,
                area: self.area_clock,
                estimate: self.estimate_clock,
                order: self.order_clock,
                completion: self.completion_clock,
                deletion: self.deletion_clock,
            },
        };
        task.validate()
            .map_err(|error| SyncFailure::retryable(error.to_string()))?;
        Ok(task)
    }
}

fn classify_http_failure(status: StatusCode, body: &str) -> SyncFailure {
    let normalized = body.to_ascii_lowercase();
    if normalized.contains("epoch_mismatch") {
        return SyncFailure {
            kind: FailureKind::EpochMismatch,
            message: "remote sync epoch changed".into(),
        };
    }
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("Supabase returned HTTP {status}"));
    let deterministic_rejection = [
        "protocol_mismatch",
        "idempotency_mismatch",
        "invalid_registers",
        "invalid_title_register",
        "invalid_schedule_register",
        "invalid_priority_register",
        "invalid_area_register",
        "invalid_estimate_register",
        "invalid_order_register",
        "invalid_completion_register",
        "invalid_deletion_register",
        "empty_title",
        "missing_title",
    ]
    .iter()
    .any(|marker| normalized.contains(marker));
    if deterministic_rejection {
        SyncFailure::permanent(message)
    } else {
        SyncFailure::retryable(message)
    }
}

pub fn spawn_worker(app: AppHandle, service: TaskService, wake: SyncWake) {
    tauri::async_runtime::spawn(async move {
        let client = match Client::builder().timeout(Duration::from_secs(20)).build() {
            Ok(client) => client,
            Err(error) => {
                publish_sync_status(&app, &wake, SyncStatus::NotConnected);
                tracing::error!(%error, "could not create Supabase HTTP client");
                return;
            }
        };
        let mut generation = wake.generation();
        let mut failures = 0_u32;
        loop {
            match service.rollover_current_date() {
                Ok(result) if !result.result.is_empty() => {
                    wake.wake();
                    let _ = app.emit("todou://tasks-changed", result.revision);
                }
                Err(error) => tracing::warn!(%error, "due-date rollover failed"),
                _ => {}
            }
            let result = reconcile(&client, &app, &service, &wake).await;
            let wait = match result {
                Ok(configured) => {
                    failures = 0;
                    publish_sync_status(
                        &app,
                        &wake,
                        if configured {
                            SyncStatus::UpToDate
                        } else {
                            SyncStatus::NotConnected
                        },
                    );
                    Duration::from_secs(30)
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    if let Err(storage_error) = service.mark_sync_failure(&error.message) {
                        tracing::warn!(%storage_error, "could not persist sync failure");
                    }
                    publish_sync_status(&app, &wake, SyncStatus::NotConnected);
                    tracing::warn!(%error, kind = ?error.kind, "sync cycle failed");
                    Duration::from_secs((1_u64 << failures.min(8)).min(300))
                }
            };
            tokio::select! {
                next = wake.changed_after(generation) => generation = next,
                _ = tokio::time::sleep(wait) => generation = wake.generation(),
            }
        }
    });
}

async fn reconcile(
    client: &Client,
    app: &AppHandle,
    service: &TaskService,
    wake: &SyncWake,
) -> Result<bool, SyncFailure> {
    let Some(config) = SupabaseConfig::load(service)? else {
        service
            .clear_sync_failure()
            .map_err(|error| SyncFailure::retryable(error.to_string()))?;
        return Ok(false);
    };
    publish_sync_status(app, wake, SyncStatus::Updating);
    let transport = SupabaseTransport::new(client.clone(), config);

    let mut pushed = 0_usize;
    'push: while pushed < MAX_PUSHES_PER_CYCLE {
        let mutations = service
            .next_outbox(PUSH_BATCH)
            .map_err(|error| SyncFailure::retryable(error.to_string()))?
            .result;
        if mutations.is_empty() {
            break;
        }
        for mutation in mutations {
            match transport.apply(&mutation).await {
                Ok(remote_task) => match service.ack_outbox(&mutation.operation_id, remote_task) {
                    Ok(result) => {
                        let _ = app.emit("todou://tasks-changed", result.revision);
                    }
                    Err(error)
                        if matches!(
                            error.code,
                            ErrorCode::ProtocolMismatch
                                | ErrorCode::IdempotencyMismatch
                                | ErrorCode::InvalidInput
                        ) =>
                    {
                        service
                            .record_outbox_failure(&mutation.operation_id, &error.message, false)
                            .map_err(|storage| SyncFailure::permanent(storage.to_string()))?;
                        tracing::error!(
                            operation_id = %mutation.operation_id,
                            %error,
                            "outbox acknowledgement quarantined"
                        );
                    }
                    Err(error) => {
                        service
                            .record_outbox_failure(&mutation.operation_id, &error.message, true)
                            .map_err(|storage| SyncFailure::permanent(storage.to_string()))?;
                        return Err(SyncFailure::retryable(error.to_string()));
                    }
                },
                Err(error) if error.kind == FailureKind::Permanent => {
                    service
                        .record_outbox_failure(&mutation.operation_id, &error.message, false)
                        .map_err(|storage| SyncFailure::permanent(storage.to_string()))?;
                    tracing::error!(
                        operation_id = %mutation.operation_id,
                        %error,
                        "outbox mutation quarantined"
                    );
                }
                Err(error) => {
                    service
                        .record_outbox_failure(&mutation.operation_id, &error.message, true)
                        .map_err(|storage| SyncFailure::permanent(storage.to_string()))?;
                    return Err(error);
                }
            }
            pushed += 1;
            if pushed >= MAX_PUSHES_PER_CYCLE {
                break 'push;
            }
        }
    }

    let cursor = service
        .cursor()
        .map_err(|error| SyncFailure::permanent(error.to_string()))?;
    let Some(mut epoch) = cursor.epoch else {
        if bootstrap(app, service, &transport).await? > 0 {
            wake.wake();
        }
        service
            .mark_sync_success()
            .map_err(|error| SyncFailure::permanent(error.to_string()))?;
        return Ok(true);
    };
    let head = transport.head().await?;
    if head.epoch != epoch || head.last_seq < cursor.sequence {
        if bootstrap(app, service, &transport).await? > 0 {
            wake.wake();
        }
        service
            .mark_sync_success()
            .map_err(|error| SyncFailure::permanent(error.to_string()))?;
        return Ok(true);
    }
    let mut after = cursor.sequence;
    for _ in 0..MAX_PULL_PAGES_PER_CYCLE {
        let page = match transport.pull(&epoch, after).await {
            Ok(page) => page,
            Err(error) if error.kind == FailureKind::EpochMismatch => {
                if bootstrap(app, service, &transport).await? > 0 {
                    wake.wake();
                }
                service
                    .mark_sync_success()
                    .map_err(|storage| SyncFailure::permanent(storage.to_string()))?;
                return Ok(true);
            }
            Err(error) => return Err(error),
        };
        let count = page.changes.len();
        if count == 0 {
            break;
        }
        after = page
            .changes
            .last()
            .map(|change| change.seq)
            .unwrap_or(after);
        epoch = page.epoch.clone();
        let summary = service
            .apply_remote_page(page)
            .map_err(|error| SyncFailure::permanent(error.to_string()))?;
        if summary.inserted + summary.updated > 0 {
            let _ = app.emit("todou://tasks-changed", summary.revision);
        }
        if count < PULL_BATCH as usize {
            break;
        }
    }
    service
        .mark_sync_success()
        .map_err(|error| SyncFailure::permanent(error.to_string()))?;
    Ok(true)
}

async fn bootstrap(
    app: &AppHandle,
    service: &TaskService,
    transport: &SupabaseTransport,
) -> Result<u64, SyncFailure> {
    let payload = transport.bootstrap().await?;
    if payload.protocol_version != PROTOCOL_VERSION {
        return Err(SyncFailure::permanent(format!(
            "unsupported bootstrap protocol version {}",
            payload.protocol_version
        )));
    }
    let summary = service
        .bootstrap_remote(payload)
        .map_err(|error| SyncFailure::permanent(error.to_string()))?;
    if summary.inserted + summary.updated > 0 {
        let _ = app.emit("todou://tasks-changed", summary.revision);
    }
    Ok(summary.repair_operations)
}

#[cfg(test)]
mod tests {
    use super::{
        classify_http_failure, FailureKind, RemoteTaskRow, SupabaseConfig, SupabaseTransport,
        SyncWake,
    };
    use crate::{
        domain::{Area, Bucket, CreateTaskInput, Priority, TaskFilter, UpdateTaskPatch},
        hlc::ClockSource,
        service::TaskService,
    };
    use chrono::NaiveDate;
    use reqwest::StatusCode;
    use std::{env, sync::Arc};
    use tempfile::tempdir;

    struct FixedClock {
        millis: i64,
    }

    impl ClockSource for FixedClock {
        fn now_millis(&self) -> i64 {
            self.millis
        }

        fn local_date(&self) -> NaiveDate {
            NaiveDate::from_ymd_opt(2026, 7, 21).unwrap()
        }
    }

    fn postgres_utc_spelling(value: &str, omit_zero_fraction: bool) -> String {
        let without_z = value.strip_suffix('Z').unwrap();
        let value = if omit_zero_fraction {
            without_z.strip_suffix(".000").unwrap_or(without_z)
        } else {
            without_z
        };
        format!("{value}+00:00")
    }

    fn equivalent_completion_acknowledges(millis: i64, omit_zero_fraction: bool) {
        let service = TaskService::in_memory_with_clock(Arc::new(FixedClock { millis })).unwrap();
        let created = service
            .create_task(CreateTaskInput {
                id: None,
                title: "Timestamp equivalence".to_owned(),
                bucket: Bucket::Inbox,
                priority: Priority::Low,
                area: Area::Personal,
                due_date: None,
                estimate_minutes: None,
            })
            .unwrap()
            .result;
        let completed = service.complete_task(&created.id).unwrap().result;
        let operation = service
            .next_outbox(100)
            .unwrap()
            .result
            .into_iter()
            .find(|mutation| {
                mutation.registers.len() == 1 && mutation.registers.contains_key("completion")
            })
            .unwrap();
        let remote = RemoteTaskRow {
            id: completed.id.clone(),
            title: completed.title.clone(),
            bucket: completed.bucket,
            priority: completed.priority,
            area: completed.area,
            due_date: completed.due_date.clone(),
            estimate_minutes: completed.estimate_minutes,
            order_key: completed.order_key.clone(),
            completed_at: completed
                .completed_at
                .as_deref()
                .map(|value| postgres_utc_spelling(value, omit_zero_fraction)),
            deleted_at: None,
            created_at: postgres_utc_spelling(&completed.created_at, omit_zero_fraction),
            updated_at: postgres_utc_spelling(&completed.updated_at, omit_zero_fraction),
            title_clock: completed.clocks.title.clone(),
            schedule_clock: completed.clocks.schedule.clone(),
            priority_clock: completed.clocks.priority.clone(),
            area_clock: completed.clocks.area.clone(),
            estimate_clock: completed.clocks.estimate.clone(),
            order_clock: completed.clocks.order.clone(),
            completion_clock: completed.clocks.completion.clone(),
            deletion_clock: completed.clocks.deletion.clone(),
        }
        .into_task()
        .unwrap();

        let acknowledged = service
            .ack_outbox(&operation.operation_id, remote)
            .unwrap()
            .result;

        assert_eq!(acknowledged.completed_at, completed.completed_at);
        assert_eq!(acknowledged.created_at, completed.created_at);
        assert!(service
            .next_outbox(100)
            .unwrap()
            .result
            .iter()
            .all(|pending| pending.operation_id != operation.operation_id));
    }

    async fn push_outbox(service: &TaskService, transport: &SupabaseTransport) {
        loop {
            let mutations = service.next_outbox(100).unwrap().result;
            if mutations.is_empty() {
                return;
            }
            for mutation in mutations {
                let remote = transport.apply(&mutation).await.unwrap();
                service.ack_outbox(&mutation.operation_id, remote).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn wake_coalesces_without_losing_generation() {
        let wake = SyncWake::default();
        wake.wake();
        wake.wake();

        assert_eq!(wake.changed_after(0).await, 2);
    }

    #[test]
    fn epoch_mismatch_is_bootstrap_signal() {
        let error =
            classify_http_failure(StatusCode::BAD_REQUEST, r#"{"message":"epoch_mismatch"}"#);
        assert_eq!(error.kind, FailureKind::EpochMismatch);
    }

    #[test]
    fn auth_and_missing_migration_failures_do_not_quarantine_mutations() {
        let auth =
            classify_http_failure(StatusCode::UNAUTHORIZED, r#"{"message":"Invalid API key"}"#);
        let missing_rpc = classify_http_failure(
            StatusCode::NOT_FOUND,
            r#"{"message":"Could not find the function public.apply_task_mutation"}"#,
        );

        assert_eq!(auth.kind, FailureKind::Retryable);
        assert_eq!(missing_rpc.kind, FailureKind::Retryable);
    }

    #[test]
    fn deterministic_invalid_register_is_quarantined() {
        let error = classify_http_failure(
            StatusCode::BAD_REQUEST,
            r#"{"message":"invalid_schedule_register"}"#,
        );

        assert_eq!(error.kind, FailureKind::Permanent);
    }

    #[test]
    fn postgres_snapshot_maps_flat_clocks_to_task_contract() {
        let row: RemoteTaskRow = serde_json::from_str(
            r#"{
              "id":"40f18880-af35-4d55-b10c-ea7d50fe626f",
              "title":"Synced",
              "bucket":"inbox",
              "priority":"low",
              "area":"work",
              "due_date":null,
              "estimate_minutes":25,
              "order_key":"V",
              "completed_at":null,
              "deleted_at":null,
              "created_at":"2026-07-20T20:00:00.000Z",
              "updated_at":"2026-07-20T20:00:00.000Z",
              "title_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "schedule_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "priority_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "area_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "estimate_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "order_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "completion_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "deletion_clock":"1721430000000-0000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }"#,
        )
        .unwrap();

        let task = row.into_task().unwrap();
        assert_eq!(task.estimate_minutes, Some(25));
        assert_eq!(task.clocks.title, task.clocks.deletion);
    }

    #[test]
    fn postgres_utc_offset_completion_acknowledges_at_the_same_clock() {
        equivalent_completion_acknowledges(1_784_666_158_943, false);
    }

    #[test]
    fn postgres_whole_second_completion_acknowledges_at_the_same_clock() {
        equivalent_completion_acknowledges(1_784_666_158_000, true);
    }

    #[tokio::test]
    #[ignore = "requires a disposable local Supabase stack"]
    async fn local_supabase_two_device_round_trip_converges() {
        let config = SupabaseConfig {
            url: env::var("TODOU_E2E_SUPABASE_URL").expect("TODOU_E2E_SUPABASE_URL is required"),
            publishable_key: env::var("TODOU_E2E_SUPABASE_PUBLISHABLE_KEY")
                .expect("TODOU_E2E_SUPABASE_PUBLISHABLE_KEY is required"),
        };
        let transport = SupabaseTransport::new(reqwest::Client::new(), config);
        let first_dir = tempdir().unwrap();
        let second_dir = tempdir().unwrap();
        let first = TaskService::open(first_dir.path().join("todou.sqlite3")).unwrap();
        let second = TaskService::open(second_dir.path().join("todou.sqlite3")).unwrap();

        let task = first
            .create_task(CreateTaskInput {
                id: None,
                title: "Todou local Supabase convergence check".to_owned(),
                bucket: Bucket::Inbox,
                priority: Priority::Low,
                area: Area::Personal,
                due_date: None,
                estimate_minutes: Some(25),
            })
            .unwrap()
            .result;
        push_outbox(&first, &transport).await;

        let bootstrap = transport.bootstrap().await.unwrap();
        first.bootstrap_remote(bootstrap.clone()).unwrap();
        second.bootstrap_remote(bootstrap).unwrap();

        first
            .update_task(
                &task.id,
                UpdateTaskPatch {
                    title: Some("Edited offline on the first Mac".to_owned()),
                    ..UpdateTaskPatch::default()
                },
            )
            .unwrap();
        second
            .update_task(
                &task.id,
                UpdateTaskPatch {
                    area: Some(Area::Work),
                    ..UpdateTaskPatch::default()
                },
            )
            .unwrap();

        push_outbox(&first, &transport).await;
        push_outbox(&second, &transport).await;

        for service in [&first, &second] {
            let cursor = service.cursor().unwrap();
            let page = transport
                .pull(cursor.epoch.as_deref().unwrap(), cursor.sequence)
                .await
                .unwrap();
            service.apply_remote_page(page).unwrap();
        }

        let first_task = first.get_task(&task.id).unwrap().result;
        let second_task = second.get_task(&task.id).unwrap().result;
        assert_eq!(first_task.title, "Edited offline on the first Mac");
        assert_eq!(first_task.area, Area::Work);
        assert_eq!(first_task, second_task);
        assert_eq!(
            first
                .list_tasks(TaskFilter::default())
                .unwrap()
                .result
                .len(),
            1
        );
    }
}
