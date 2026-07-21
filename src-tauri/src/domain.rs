use crate::error::{AppError, AppResult};
use chrono::{DateTime, NaiveDate};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, str::FromStr};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revisioned<T> {
    pub result: T,
    pub revision: u64,
}

impl<T> Revisioned<T> {
    pub fn new(result: T, revision: u64) -> Self {
        Self { result, revision }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bucket {
    Today,
    Inbox,
}

impl Bucket {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::Inbox => "inbox",
        }
    }

    pub fn sort_rank(self) -> u8 {
        match self {
            Self::Today => 0,
            Self::Inbox => 1,
        }
    }
}

impl FromStr for Bucket {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "today" => Ok(Self::Today),
            "inbox" => Ok(Self::Inbox),
            _ => Err(AppError::invalid_input("bucket must be 'today' or 'inbox'")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    High,
    Low,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Low => "low",
        }
    }

    pub fn sort_rank(self) -> u8 {
        match self {
            Self::High => 0,
            Self::Low => 1,
        }
    }
}

impl FromStr for Priority {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "high" => Ok(Self::High),
            "low" => Ok(Self::Low),
            _ => Err(AppError::invalid_input("priority must be 'high' or 'low'")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Area {
    Personal,
    Work,
}

impl Area {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Work => "work",
        }
    }
}

impl FromStr for Area {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "personal" => Ok(Self::Personal),
            "work" => Ok(Self::Work),
            _ => Err(AppError::invalid_input("area must be 'personal' or 'work'")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskClocks {
    pub title: String,
    pub schedule: String,
    pub priority: String,
    pub area: String,
    pub estimate: String,
    pub order: String,
    pub completion: String,
    pub deletion: String,
}

impl TaskClocks {
    pub fn all(stamp: String) -> Self {
        Self {
            title: stamp.clone(),
            schedule: stamp.clone(),
            priority: stamp.clone(),
            area: stamp.clone(),
            estimate: stamp.clone(),
            order: stamp.clone(),
            completion: stamp.clone(),
            deletion: stamp,
        }
    }

    pub fn stamps(&self) -> [&str; 8] {
        [
            &self.title,
            &self.schedule,
            &self.priority,
            &self.area,
            &self.estimate,
            &self.order,
            &self.completion,
            &self.deletion,
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub bucket: Bucket,
    pub priority: Priority,
    pub area: Area,
    pub due_date: Option<String>,
    pub estimate_minutes: Option<u16>,
    pub order_key: String,
    pub completed_at: Option<String>,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub clocks: TaskClocks,
}

impl Task {
    pub fn validate(&self) -> AppResult<()> {
        validate_title(&self.title)?;
        validate_due_date(self.due_date.as_deref())?;
        validate_estimate(self.estimate_minutes)?;
        validate_timestamp(&self.created_at, "createdAt")?;
        validate_timestamp(&self.updated_at, "updatedAt")?;
        if let Some(value) = &self.completed_at {
            validate_timestamp(value, "completedAt")?;
        }
        if let Some(value) = &self.deleted_at {
            validate_timestamp(value, "deletedAt")?;
        }
        crate::order_key::validate(&self.order_key)?;
        for stamp in self.clocks.stamps() {
            crate::hlc::Hlc::parse(stamp)?;
        }
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.deleted_at.is_none() && self.completed_at.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default = "default_bucket")]
    pub bucket: Bucket,
    #[serde(default = "default_priority")]
    pub priority: Priority,
    #[serde(default = "default_area")]
    pub area: Area,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub estimate_minutes: Option<u16>,
}

fn default_bucket() -> Bucket {
    Bucket::Inbox
}

fn default_priority() -> Priority {
    Priority::Low
}

fn default_area() -> Area {
    Area::Personal
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<Area>,
    #[serde(skip_serializing_if = "NullablePatch::is_missing")]
    pub due_date: NullablePatch<String>,
    #[serde(skip_serializing_if = "NullablePatch::is_missing")]
    pub estimate_minutes: NullablePatch<u16>,
}

impl<'de> Deserialize<'de> for UpdateTaskPatch {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct RawPatch {
            #[serde(default)]
            title: Option<String>,
            #[serde(default)]
            priority: Option<Priority>,
            #[serde(default)]
            area: Option<Area>,
            #[serde(default, deserialize_with = "deserialize_nullable_patch")]
            due_date: NullablePatch<String>,
            #[serde(default, deserialize_with = "deserialize_nullable_patch")]
            estimate_minutes: NullablePatch<u16>,
        }

        let raw = RawPatch::deserialize(deserializer)?;
        Ok(Self {
            title: raw.title,
            priority: raw.priority,
            area: raw.area,
            due_date: raw.due_date,
            estimate_minutes: raw.estimate_minutes,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(untagged)]
pub enum NullablePatch<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<T> NullablePatch<T> {
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<NullablePatch<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(match Option::<T>::deserialize(deserializer)? {
        Some(value) => NullablePatch::Value(value),
        None => NullablePatch::Null,
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFilter {
    #[serde(default)]
    pub bucket: Option<Bucket>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub area: Option<Area>,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    #[serde(alias = "query")]
    pub text: Option<String>,
    #[serde(default)]
    pub include_deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderTaskInput {
    pub id: String,
    #[serde(default)]
    pub before_id: Option<String>,
    #[serde(default)]
    pub after_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampedValue {
    pub stamp: String,
    pub value: Value,
}

pub type RegisterMap = BTreeMap<String, StampedValue>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxMutation {
    pub protocol_version: u32,
    pub local_sequence: u64,
    pub operation_id: String,
    pub device_id: String,
    pub task_id: String,
    pub registers: RegisterMap,
    pub created_at: String,
    pub attempt_count: u32,
    pub next_attempt_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteChange {
    pub seq: u64,
    pub task: Task,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePage {
    pub protocol_version: u32,
    pub epoch: String,
    pub changes: Vec<RemoteChange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub protocol_version: u32,
    pub epoch: String,
    pub watermark: u64,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeSummary {
    pub inserted: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub repair_operations: u64,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCursor {
    pub epoch: Option<String>,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTask {
    pub id: String,
    pub title: String,
    pub bucket: Bucket,
    pub priority: Priority,
    pub area: Area,
    pub due_date: Option<String>,
    pub estimate_minutes: Option<u16>,
    pub order_key: String,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Task> for ExportTask {
    fn from(task: Task) -> Self {
        Self {
            id: task.id,
            title: task.title,
            bucket: task.bucket,
            priority: task.priority,
            area: task.area,
            due_date: task.due_date,
            estimate_minutes: task.estimate_minutes,
            order_key: task.order_key,
            completed_at: task.completed_at,
            created_at: task.created_at,
            updated_at: task.updated_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSnapshot {
    pub schema_version: u32,
    pub exported_at: String,
    pub tasks: Vec<ExportTask>,
    pub preferences: BTreeMap<String, Value>,
}

pub fn normalize_title(value: &str) -> AppResult<String> {
    let title = value.trim();
    validate_title(title)?;
    Ok(title.to_owned())
}

pub fn validate_title(value: &str) -> AppResult<()> {
    let length = value.chars().count();
    if value.trim() != value || !(1..=500).contains(&length) {
        return Err(AppError::invalid_input(
            "title must be trimmed and contain between 1 and 500 characters",
        ));
    }
    Ok(())
}

pub fn parse_due_date(value: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::invalid_input("dueDate must use YYYY-MM-DD"))
}

pub fn validate_due_date(value: Option<&str>) -> AppResult<()> {
    if let Some(value) = value {
        parse_due_date(value)?;
    }
    Ok(())
}

pub fn validate_estimate(value: Option<u16>) -> AppResult<()> {
    if value.is_some_and(|minutes| !(1..=1440).contains(&minutes)) {
        return Err(AppError::invalid_input(
            "estimateMinutes must be between 1 and 1440",
        ));
    }
    Ok(())
}

fn validate_timestamp(value: &str, field: &str) -> AppResult<()> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| AppError::invalid_input(format!("{field} must be an RFC 3339 timestamp")))
}

#[cfg(test)]
mod tests {
    use super::{NullablePatch, UpdateTaskPatch};

    #[test]
    fn update_patch_distinguishes_missing_and_null() {
        let missing: UpdateTaskPatch = serde_json::from_str("{}").unwrap();
        let null: UpdateTaskPatch = serde_json::from_str(r#"{"dueDate":null}"#).unwrap();
        let value: UpdateTaskPatch = serde_json::from_str(r#"{"dueDate":"2026-07-21"}"#).unwrap();

        assert!(matches!(missing.due_date, NullablePatch::Missing));
        assert!(matches!(null.due_date, NullablePatch::Null));
        assert!(matches!(value.due_date, NullablePatch::Value(_)));
    }
}
