use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, io};

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    NotFound,
    Deleted,
    InvalidTransition,
    InvalidAnchor,
    StoreBusy,
    StorageUnavailable,
    ProtocolMismatch,
    IdempotencyMismatch,
    MethodNotFound,
    TodouUnavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<Value>) -> Self {
        self.details = Some(details.into());
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn not_found(id: &str) -> Self {
        Self::new(ErrorCode::NotFound, "Task not found")
            .with_details(serde_json::json!({ "taskId": id }))
    }

    pub fn storage(error: impl fmt::Display) -> Self {
        Self::new(
            ErrorCode::StorageUnavailable,
            format!("Local storage is unavailable: {error}"),
        )
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        match &error {
            rusqlite::Error::SqliteFailure(code, _)
                if matches!(
                    code.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                Self::new(
                    ErrorCode::StoreBusy,
                    "Local storage is busy; retry the command",
                )
            }
            _ => Self::storage(error),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::invalid_input(format!("Invalid JSON payload: {error}"))
    }
}

impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        Self::storage(error)
    }
}
