use crate::{
    domain::{BootstrapPayload, Bucket, RemotePage, ReorderTaskInput, Task, UpdateTaskPatch},
    error::{AppError, ErrorCode},
    service::TaskService,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct LocalRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum LocalResponse {
    Success {
        id: String,
        ok: bool,
        result: Value,
        revision: u64,
    },
    Failure {
        id: String,
        ok: bool,
        error: AppError,
    },
}

impl LocalResponse {
    fn success<T: Serialize>(id: String, result: T, revision: u64) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self::Success {
                id,
                ok: true,
                result,
                revision,
            },
            Err(error) => Self::failure(id, AppError::storage(error)),
        }
    }

    pub fn failure(id: String, error: AppError) -> Self {
        Self::Failure {
            id,
            ok: false,
            error,
        }
    }

    pub fn revision(&self) -> Option<u64> {
        match self {
            Self::Success { revision, .. } => Some(*revision),
            Self::Failure { .. } => None,
        }
    }
}

pub fn is_mutating_method(method: &str) -> bool {
    matches!(
        method,
        "createTask"
            | "create_task"
            | "updateTask"
            | "update_task"
            | "moveTask"
            | "move_task"
            | "reorderTask"
            | "reorder_task"
            | "completeTask"
            | "complete_task"
            | "restoreTask"
            | "restore_task"
            | "deleteTask"
            | "delete_task"
            | "undoDelete"
            | "undo_delete"
            | "rolloverDue"
            | "rollover_due"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateParams {
    id: String,
    patch: UpdateTaskPatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveParams {
    id: String,
    bucket: Bucket,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    query: String,
    #[serde(default)]
    include_completed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RolloverParams {
    local_date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckParams {
    operation_id: String,
    remote_task: Task,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitParams {
    #[serde(default = "default_outbox_limit")]
    limit: u32,
}

fn default_outbox_limit() -> u32 {
    100
}

pub fn dispatch(service: &TaskService, request: LocalRequest) -> LocalResponse {
    let id = request.id;
    let result = dispatch_inner(service, &request.method, request.params);
    match result {
        Ok((value, revision)) => LocalResponse::success(id, value, revision),
        Err(error) => LocalResponse::failure(id, error),
    }
}

fn dispatch_inner(
    service: &TaskService,
    method: &str,
    params: Value,
) -> Result<(Value, u64), AppError> {
    macro_rules! revisioned {
        ($expression:expr) => {{
            let value = $expression?;
            Ok((serde_json::to_value(value.result)?, value.revision))
        }};
    }

    match method {
        "createTask" | "create_task" => {
            revisioned!(service.create_task(parse_params(params)?))
        }
        "getTask" | "get_task" => {
            let value: IdParams = parse_params(params)?;
            revisioned!(service.get_task(&value.id))
        }
        "updateTask" | "update_task" => {
            let value: UpdateParams = parse_params(params)?;
            revisioned!(service.update_task(&value.id, value.patch))
        }
        "moveTask" | "move_task" => {
            let value: MoveParams = parse_params(params)?;
            revisioned!(service.move_task(&value.id, value.bucket))
        }
        "reorderTask" | "reorder_task" => {
            let value: ReorderTaskInput = parse_params(params)?;
            revisioned!(service.reorder_task(
                &value.id,
                value.before_id.as_deref(),
                value.after_id.as_deref()
            ))
        }
        "completeTask" | "complete_task" => {
            let value: IdParams = parse_params(params)?;
            revisioned!(service.complete_task(&value.id))
        }
        "restoreTask" | "restore_task" => {
            let value: IdParams = parse_params(params)?;
            revisioned!(service.restore_task(&value.id))
        }
        "deleteTask" | "delete_task" => {
            let value: IdParams = parse_params(params)?;
            revisioned!(service.delete_task(&value.id))
        }
        "undoDelete" | "undo_delete" => {
            let value: IdParams = parse_params(params)?;
            revisioned!(service.undo_delete(&value.id))
        }
        "rolloverDue" | "rollover_due" => {
            let value: RolloverParams = parse_params(params)?;
            revisioned!(service.rollover_due(&value.local_date))
        }
        "listTasks" | "list_tasks" => revisioned!(service.list_tasks(parse_params(params)?)),
        "searchTasks" | "search_tasks" => {
            let value: SearchParams = parse_params(params)?;
            revisioned!(service.search_tasks(&value.query, value.include_completed))
        }
        "exportTasks" | "export_tasks" => revisioned!(service.export_tasks()),
        "nextOutbox" | "next_outbox" => {
            let value: LimitParams = parse_params(params)?;
            revisioned!(service.next_outbox(value.limit))
        }
        "ackOutbox" | "ack_outbox" => {
            let value: AckParams = parse_params(params)?;
            revisioned!(service.ack_outbox(&value.operation_id, value.remote_task))
        }
        "applyRemotePage" | "apply_remote_page" => {
            let summary = service.apply_remote_page(parse_params::<RemotePage>(params)?)?;
            Ok((serde_json::to_value(&summary)?, summary.revision))
        }
        "bootstrapRemote" | "bootstrap_remote" => {
            let summary = service.bootstrap_remote(parse_params::<BootstrapPayload>(params)?)?;
            Ok((serde_json::to_value(&summary)?, summary.revision))
        }
        "syncDiagnostics" | "sync_diagnostics" => {
            revisioned!(service.sync_diagnostics())
        }
        _ => Err(AppError::new(
            ErrorCode::MethodNotFound,
            format!("Unknown local method '{method}'"),
        )),
    }
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, AppError> {
    serde_json::from_value(params)
        .map_err(|error| AppError::invalid_input(format!("Invalid method parameters: {error}")))
}

#[cfg(test)]
mod tests {
    use super::{dispatch, LocalRequest, LocalResponse};
    use crate::{error::ErrorCode, hlc::ClockSource, service::TaskService};
    use chrono::NaiveDate;
    use serde_json::json;
    use std::sync::Arc;

    struct FixedClock;

    impl ClockSource for FixedClock {
        fn now_millis(&self) -> i64 {
            1_721_430_000_000
        }

        fn local_date(&self) -> NaiveDate {
            NaiveDate::from_ymd_opt(2026, 7, 20).unwrap()
        }
    }

    #[test]
    fn unknown_socket_method_has_stable_error_code() {
        let service = TaskService::in_memory_with_clock(Arc::new(FixedClock)).unwrap();
        let response = dispatch(
            &service,
            LocalRequest {
                id: "request-1".into(),
                method: "inventTask".into(),
                params: json!({}),
            },
        );

        match response {
            LocalResponse::Failure { id, error, .. } => {
                assert_eq!(id, "request-1");
                assert_eq!(error.code, ErrorCode::MethodNotFound);
            }
            LocalResponse::Success { .. } => panic!("unknown method unexpectedly succeeded"),
        }
    }
}
