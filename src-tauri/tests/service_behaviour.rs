use chrono::NaiveDate;
use serde_json::json;
use std::sync::Arc;
use tempfile::tempdir;
use todou_lib::{
    domain::{
        Area, BootstrapPayload, Bucket, CreateTaskInput, NullablePatch, Priority, RemoteChange,
        RemotePage, TaskFilter, UpdateTaskPatch, PROTOCOL_VERSION,
    },
    error::ErrorCode,
    hlc::ClockSource,
    service::TaskService,
};
use uuid::Uuid;

struct FixedClock {
    millis: i64,
    date: NaiveDate,
}

impl FixedClock {
    fn july_20() -> Arc<Self> {
        Arc::new(Self {
            millis: 1_721_430_000_000,
            date: NaiveDate::from_ymd_opt(2026, 7, 20).unwrap(),
        })
    }
}

impl ClockSource for FixedClock {
    fn now_millis(&self) -> i64 {
        self.millis
    }

    fn local_date(&self) -> NaiveDate {
        self.date
    }
}

fn service() -> TaskService {
    TaskService::in_memory_with_clock(FixedClock::july_20()).unwrap()
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

fn epoch() -> String {
    Uuid::new_v4().to_string()
}

#[test]
fn local_task_and_outbox_survive_restart() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("todou.sqlite3");
    let created = {
        let service = TaskService::open_with_clock(&path, FixedClock::july_20()).unwrap();
        service.create_task(input("Persist me")).unwrap()
    };

    let reopened = TaskService::open_with_clock(&path, FixedClock::july_20()).unwrap();
    let tasks = reopened.list_tasks(TaskFilter::default()).unwrap();
    let outbox = reopened.next_outbox(100).unwrap();

    assert_eq!(tasks.result.len(), 1);
    assert_eq!(tasks.result[0].id, created.result.id);
    assert_eq!(tasks.revision, created.revision);
    assert_eq!(outbox.result.len(), 1);
    assert_eq!(outbox.result[0].task_id, created.result.id);
    assert_eq!(outbox.result[0].registers.len(), 8);
}

#[test]
fn unfiltered_restart_load_includes_active_and_completed_tasks() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("todou.sqlite3");
    {
        let service = TaskService::open_with_clock(&path, FixedClock::july_20()).unwrap();
        service.create_task(input("Active")).unwrap();
        let completed = service.create_task(input("Completed")).unwrap().result;
        service.complete_task(&completed.id).unwrap();
    }

    let reopened = TaskService::open_with_clock(&path, FixedClock::july_20()).unwrap();
    let all = reopened.list_tasks(TaskFilter::default()).unwrap().result;
    let active = reopened
        .list_tasks(TaskFilter {
            completed: Some(false),
            ..TaskFilter::default()
        })
        .unwrap()
        .result;
    let completed = reopened
        .list_tasks(TaskFilter {
            completed: Some(true),
            ..TaskFilter::default()
        })
        .unwrap()
        .result;

    assert_eq!(all.len(), 2);
    assert!(all[0].completed_at.is_none());
    assert_eq!(active.len(), 1);
    assert_eq!(completed.len(), 1);
}

#[test]
fn empty_sync_preferences_disable_sync_without_an_error() {
    let service = service();
    service.set_preference("supabaseUrl", json!("  ")).unwrap();
    service
        .set_preference("supabasePublishableKey", json!(""))
        .unwrap();

    assert_eq!(service.sync_preferences().unwrap(), (None, None));
}

#[test]
fn changing_sync_credentials_atomically_resets_endpoint_diagnostics() {
    let service = service();
    service
        .set_sync_settings("https://first.supabase.co", "first-key")
        .unwrap();
    assert_eq!(
        service.sync_preferences().unwrap(),
        (
            Some("https://first.supabase.co".into()),
            Some("first-key".into())
        )
    );
    assert!(service
        .set_sync_settings("https://partial.supabase.co", "")
        .is_err());
    assert_eq!(
        service.sync_preferences().unwrap(),
        (
            Some("https://first.supabase.co".into()),
            Some("first-key".into())
        )
    );
    let first_epoch = epoch();
    service
        .bootstrap_remote(BootstrapPayload {
            protocol_version: PROTOCOL_VERSION,
            epoch: first_epoch.clone(),
            watermark: 9,
            tasks: vec![],
        })
        .unwrap();
    service.mark_sync_success().unwrap();
    service
        .mark_sync_failure("Remote request timed out")
        .unwrap();

    service
        .set_sync_settings("  https://first.supabase.co  ", " first-key ")
        .unwrap();
    let unchanged = service.sync_diagnostics().unwrap().result;
    assert_eq!(unchanged["cursor"]["epoch"], json!(first_epoch));
    assert_eq!(unchanged["cursor"]["sequence"], json!(9));
    assert!(unchanged["lastSuccessfulSync"].is_string());
    assert_eq!(unchanged["lastError"], json!("Remote request timed out"));

    service
        .set_sync_settings("https://second.supabase.co", "second-key")
        .unwrap();
    assert_eq!(
        service.sync_preferences().unwrap(),
        (
            Some("https://second.supabase.co".into()),
            Some("second-key".into())
        )
    );
    let changed = service.sync_diagnostics().unwrap().result;
    assert_eq!(changed["cursor"]["epoch"], json!(null));
    assert_eq!(changed["cursor"]["sequence"], json!(0));
    assert_eq!(changed["lastSuccessfulSync"], json!(null));
    assert_eq!(changed["lastError"], json!(null));
}

#[test]
fn due_and_move_transitions_preserve_schedule_invariant() {
    let service = service();
    let mut due = input("Due already");
    due.due_date = Some("2026-07-20".into());
    let due = service.create_task(due).unwrap().result;
    assert_eq!(due.bucket, Bucket::Today);

    let moved = service.move_task(&due.id, Bucket::Inbox).unwrap().result;
    assert_eq!(moved.bucket, Bucket::Inbox);
    assert_eq!(moved.due_date, None);

    let dated = service
        .update_task(
            &moved.id,
            UpdateTaskPatch {
                due_date: NullablePatch::Value("2026-07-19".into()),
                ..UpdateTaskPatch::default()
            },
        )
        .unwrap()
        .result;
    assert_eq!(dated.bucket, Bucket::Today);
    assert_eq!(dated.due_date.as_deref(), Some("2026-07-19"));
}

#[test]
fn rollover_moves_only_active_due_inbox_tasks() {
    let primary = service();
    let mut overdue = input("Overdue");
    overdue.due_date = Some("2026-07-21".into());
    let overdue = primary.create_task(overdue).unwrap().result;
    let complete = primary.complete_task(&overdue.id).unwrap().result;

    let mut due = input("Due next day");
    due.due_date = Some("2026-07-21".into());
    let due = primary.create_task(due).unwrap().result;
    let moved = primary.rollover_due("2026-07-21").unwrap().result;

    assert_eq!(
        moved.iter().map(|task| &task.id).collect::<Vec<_>>(),
        vec![&due.id]
    );
    assert_eq!(
        primary.get_task(&complete.id).unwrap().result.bucket,
        Bucket::Inbox
    );

    let source = service();
    let mut overdue_complete = input("Restore overdue");
    overdue_complete.due_date = Some("2026-07-20".into());
    let overdue_complete = source.create_task(overdue_complete).unwrap().result;
    let mut overdue_complete = source.complete_task(&overdue_complete.id).unwrap().result;
    overdue_complete.bucket = Bucket::Inbox;
    let restored_service = service();
    restored_service
        .bootstrap_remote(BootstrapPayload {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch(),
            watermark: 0,
            tasks: vec![overdue_complete.clone()],
        })
        .unwrap();
    let restored = restored_service
        .restore_task(&overdue_complete.id)
        .unwrap()
        .result;
    assert_eq!(restored.bucket, Bucket::Today);
}

#[test]
fn high_priority_is_sorted_first_and_fifo_within_tier() {
    let service = service();
    let low = service.create_task(input("Low")).unwrap().result;
    let mut first_high = input("First high");
    first_high.priority = Priority::High;
    let first_high = service.create_task(first_high).unwrap().result;
    let mut second_high = input("Second high");
    second_high.priority = Priority::High;
    let second_high = service.create_task(second_high).unwrap().result;

    let tasks = service.list_tasks(TaskFilter::default()).unwrap().result;
    assert_eq!(
        tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            first_high.id.as_str(),
            second_high.id.as_str(),
            low.id.as_str()
        ]
    );
}

#[test]
fn reorder_requires_current_adjacent_anchors() {
    let service = service();
    let first = service.create_task(input("First")).unwrap().result;
    let second = service.create_task(input("Second")).unwrap().result;
    let third = service.create_task(input("Third")).unwrap().result;

    let reordered = service
        .reorder_task(&third.id, Some(&first.id), None)
        .unwrap()
        .result;
    assert_eq!(
        reordered
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec![third.id.as_str(), first.id.as_str(), second.id.as_str()]
    );

    let error = service
        .reorder_task(&second.id, None, Some(&third.id))
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidAnchor);
}

#[test]
fn deletion_is_hidden_from_queries_and_export_but_undo_restores_it() {
    let service = service();
    let task = service.create_task(input("Temporary")).unwrap().result;
    service.set_preference("theme", json!("dracula")).unwrap();
    service
        .set_preference("supabase.publishableKey", json!("not-for-export"))
        .unwrap();

    service.delete_task(&task.id).unwrap();
    assert!(service
        .list_tasks(TaskFilter::default())
        .unwrap()
        .result
        .is_empty());
    let export = service.export_tasks().unwrap().result;
    assert!(export.tasks.is_empty());
    assert_eq!(export.preferences.get("theme"), Some(&json!("dracula")));
    assert!(!export.preferences.contains_key("supabase.publishableKey"));

    let restored = service.undo_delete(&task.id).unwrap().result;
    assert_eq!(restored.deleted_at, None);
    assert_eq!(
        service
            .list_tasks(TaskFilter::default())
            .unwrap()
            .result
            .len(),
        1
    );
}

#[test]
fn two_devices_merge_different_fields_without_losing_either_edit() {
    let first = service();
    let second = service();
    let initial = first.create_task(input("Initial")).unwrap().result;
    let epoch = epoch();
    first
        .bootstrap_remote(BootstrapPayload {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch.clone(),
            watermark: 0,
            tasks: vec![initial.clone()],
        })
        .unwrap();
    second
        .bootstrap_remote(BootstrapPayload {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch.clone(),
            watermark: 0,
            tasks: vec![initial.clone()],
        })
        .unwrap();

    let title_edit = first
        .update_task(
            &initial.id,
            UpdateTaskPatch {
                title: Some("Edited title".into()),
                ..UpdateTaskPatch::default()
            },
        )
        .unwrap()
        .result;
    let area_edit = second
        .update_task(
            &initial.id,
            UpdateTaskPatch {
                area: Some(Area::Work),
                ..UpdateTaskPatch::default()
            },
        )
        .unwrap()
        .result;

    first
        .apply_remote_page(RemotePage {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch.clone(),
            changes: vec![RemoteChange {
                seq: 1,
                task: area_edit.clone(),
            }],
        })
        .unwrap();
    second
        .apply_remote_page(RemotePage {
            protocol_version: PROTOCOL_VERSION,
            epoch,
            changes: vec![RemoteChange {
                seq: 1,
                task: title_edit,
            }],
        })
        .unwrap();

    let on_first = first.get_task(&initial.id).unwrap().result;
    let on_second = second.get_task(&initial.id).unwrap().result;
    assert_eq!(on_first.title, "Edited title");
    assert_eq!(on_first.area, Area::Work);
    assert_eq!(on_first, on_second);
}

#[test]
fn same_field_conflict_uses_greater_hlc_deterministically() {
    let first = service();
    let second = service();
    let initial = first.create_task(input("Initial")).unwrap().result;
    let epoch = epoch();
    for target in [&first, &second] {
        target
            .bootstrap_remote(BootstrapPayload {
                protocol_version: PROTOCOL_VERSION,
                epoch: epoch.clone(),
                watermark: 0,
                tasks: vec![initial.clone()],
            })
            .unwrap();
    }
    let first_edit = first
        .update_task(
            &initial.id,
            UpdateTaskPatch {
                title: Some("From first".into()),
                ..UpdateTaskPatch::default()
            },
        )
        .unwrap()
        .result;
    let second_edit = second
        .update_task(
            &initial.id,
            UpdateTaskPatch {
                title: Some("From second".into()),
                ..UpdateTaskPatch::default()
            },
        )
        .unwrap()
        .result;
    let expected = if first_edit.clocks.title > second_edit.clocks.title {
        first_edit.title.clone()
    } else {
        second_edit.title.clone()
    };

    first
        .apply_remote_page(RemotePage {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch.clone(),
            changes: vec![RemoteChange {
                seq: 1,
                task: second_edit,
            }],
        })
        .unwrap();
    second
        .apply_remote_page(RemotePage {
            protocol_version: PROTOCOL_VERSION,
            epoch,
            changes: vec![RemoteChange {
                seq: 1,
                task: first_edit,
            }],
        })
        .unwrap();

    assert_eq!(first.get_task(&initial.id).unwrap().result.title, expected);
    assert_eq!(second.get_task(&initial.id).unwrap().result.title, expected);
}

#[test]
fn acknowledgement_never_advances_feed_cursor() {
    let service = service();
    let task = service.create_task(input("Ack me")).unwrap().result;
    let operation = service
        .next_outbox(1)
        .unwrap()
        .result
        .into_iter()
        .next()
        .unwrap();

    service.ack_outbox(&operation.operation_id, task).unwrap();

    assert_eq!(service.cursor().unwrap().epoch, None);
    assert_eq!(service.cursor().unwrap().sequence, 0);
    assert!(service.next_outbox(100).unwrap().result.is_empty());
}

#[test]
fn acknowledgement_adopts_canonical_remote_creation_time() {
    let service = service();
    let local = service.create_task(input("Canonical time")).unwrap().result;
    let operation = service
        .next_outbox(1)
        .unwrap()
        .result
        .into_iter()
        .next()
        .unwrap();
    let mut remote = local.clone();
    remote.created_at = "2026-07-20T22:00:00.000Z".into();

    let acknowledged = service
        .ack_outbox(&operation.operation_id, remote.clone())
        .unwrap()
        .result;

    assert_eq!(acknowledged.created_at, remote.created_at);
    assert_ne!(acknowledged.created_at, local.created_at);
}

#[test]
fn invalid_remote_page_changes_neither_tasks_nor_cursor() {
    let local = service();
    let remote = service();
    let initial = local.create_task(input("Initial")).unwrap().result;
    let epoch = epoch();
    local
        .bootstrap_remote(BootstrapPayload {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch.clone(),
            watermark: 0,
            tasks: vec![initial.clone()],
        })
        .unwrap();
    remote
        .bootstrap_remote(BootstrapPayload {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch.clone(),
            watermark: 0,
            tasks: vec![initial.clone()],
        })
        .unwrap();
    let edited = remote
        .update_task(
            &initial.id,
            UpdateTaskPatch {
                title: Some("Remote".into()),
                ..UpdateTaskPatch::default()
            },
        )
        .unwrap()
        .result;

    let error = local
        .apply_remote_page(RemotePage {
            protocol_version: PROTOCOL_VERSION,
            epoch,
            changes: vec![
                RemoteChange {
                    seq: 1,
                    task: edited.clone(),
                },
                RemoteChange {
                    seq: 3,
                    task: edited,
                },
            ],
        })
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ProtocolMismatch);
    assert_eq!(local.cursor().unwrap().sequence, 0);
    assert_eq!(local.get_task(&initial.id).unwrap().result.title, "Initial");
}

#[test]
fn bootstrap_requeues_local_tasks_missing_from_remote_snapshot() {
    let service = service();
    service.create_task(input("Local only")).unwrap();
    let before = service.next_outbox(100).unwrap().result.len();

    let summary = service
        .bootstrap_remote(BootstrapPayload {
            protocol_version: PROTOCOL_VERSION,
            epoch: epoch(),
            watermark: 42,
            tasks: Vec::new(),
        })
        .unwrap();

    assert_eq!(summary.repair_operations, 1);
    assert_eq!(service.cursor().unwrap().sequence, 42);
    assert_eq!(service.next_outbox(100).unwrap().result.len(), before + 1);
}

#[test]
fn persisted_hlc_remains_monotonic_after_restart() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("todou.sqlite3");
    let first_clock = {
        let service = TaskService::open_with_clock(&path, FixedClock::july_20()).unwrap();
        service
            .create_task(input("Before restart"))
            .unwrap()
            .result
            .clocks
            .title
    };
    let second_clock = TaskService::open_with_clock(&path, FixedClock::july_20())
        .unwrap()
        .create_task(input("After restart"))
        .unwrap()
        .result
        .clocks
        .title;

    assert!(second_clock > first_clock);
}
