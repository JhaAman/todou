use crate::{
    domain::{
        BootstrapPayload, Bucket, CreateTaskInput, ExportSnapshot, MergeSummary, OutboxMutation,
        RemotePage, Task, TaskFilter, UpdateTaskPatch,
    },
    error::{AppError, AppResult},
    lifecycle,
    service::TaskService,
    sync::SyncWake,
};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};
#[cfg(debug_assertions)]
use std::{path::PathBuf, process::Command};
use tauri::{AppHandle, Emitter, Manager, State};

fn announce_change<T>(app: &AppHandle, wake: &SyncWake, value: crate::domain::Revisioned<T>) -> T {
    wake.wake();
    if let Err(error) = app.emit("todou://tasks-changed", value.revision) {
        tracing::warn!(%error, "could not emit task change event");
    }
    value.result
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    input: CreateTaskInput,
) -> AppResult<Task> {
    Ok(announce_change(&app, &wake, service.create_task(input)?))
}

#[tauri::command]
pub fn get_task(service: State<'_, TaskService>, id: String) -> AppResult<Task> {
    Ok(service.get_task(&id)?.result)
}

#[tauri::command]
pub fn update_task(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    id: String,
    patch: UpdateTaskPatch,
) -> AppResult<Task> {
    Ok(announce_change(
        &app,
        &wake,
        service.update_task(&id, patch)?,
    ))
}

#[tauri::command]
pub fn move_task(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    id: String,
    bucket: Bucket,
) -> AppResult<Task> {
    Ok(announce_change(
        &app,
        &wake,
        service.move_task(&id, bucket)?,
    ))
}

#[tauri::command]
pub fn reorder_task(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    id: String,
    before_id: Option<String>,
    after_id: Option<String>,
) -> AppResult<Vec<Task>> {
    Ok(announce_change(
        &app,
        &wake,
        service.reorder_task(&id, before_id.as_deref(), after_id.as_deref())?,
    ))
}

#[tauri::command]
pub fn complete_task(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    id: String,
) -> AppResult<Task> {
    Ok(announce_change(&app, &wake, service.complete_task(&id)?))
}

#[tauri::command]
pub fn restore_task(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    id: String,
) -> AppResult<Task> {
    Ok(announce_change(&app, &wake, service.restore_task(&id)?))
}

#[tauri::command]
pub fn delete_task(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    id: String,
) -> AppResult<()> {
    announce_change(&app, &wake, service.delete_task(&id)?);
    Ok(())
}

#[tauri::command]
pub fn undo_delete(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    id: String,
) -> AppResult<Task> {
    Ok(announce_change(&app, &wake, service.undo_delete(&id)?))
}

#[tauri::command]
pub fn rollover_due(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    local_date: String,
) -> AppResult<Vec<Task>> {
    Ok(announce_change(
        &app,
        &wake,
        service.rollover_due(&local_date)?,
    ))
}

#[tauri::command]
pub fn list_tasks(service: State<'_, TaskService>, filter: TaskFilter) -> AppResult<Vec<Task>> {
    Ok(service.list_tasks(filter)?.result)
}

#[tauri::command]
pub fn search_tasks(
    service: State<'_, TaskService>,
    query: String,
    include_completed: bool,
) -> AppResult<Vec<Task>> {
    Ok(service.search_tasks(&query, include_completed)?.result)
}

#[tauri::command]
pub fn export_tasks(service: State<'_, TaskService>) -> AppResult<ExportSnapshot> {
    Ok(service.export_tasks()?.result)
}

fn export_document(snapshot: &ExportSnapshot, ui_preferences: Value) -> AppResult<String> {
    let mut document = serde_json::to_value(snapshot)?;
    let preferences = document
        .get_mut("preferences")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| AppError::storage("export preferences are unavailable"))?;
    preferences.insert("ui".to_owned(), ui_preferences);
    serde_json::to_string_pretty(&document).map_err(AppError::from)
}

fn export_filename(exported_at: &str) -> String {
    let timestamp = exported_at
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("Todou Export {timestamp}.json")
}

fn write_export(directory: &Path, filename: &str, json: &str) -> AppResult<std::path::PathBuf> {
    std::fs::create_dir_all(directory)?;
    let path = directory.join(filename);
    std::fs::write(&path, json)?;
    Ok(path)
}

#[tauri::command]
pub fn export_tasks_to_file(
    app: AppHandle,
    service: State<'_, TaskService>,
    ui_preferences: Value,
) -> AppResult<String> {
    let snapshot = service.export_tasks()?.result;
    let filename = export_filename(&snapshot.exported_at);
    let json = export_document(&snapshot, ui_preferences)?;
    let directory = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(AppError::storage)?;
    let path = write_export(&directory, &filename, &json)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_preferences(service: State<'_, TaskService>) -> AppResult<BTreeMap<String, Value>> {
    Ok(service.get_preferences()?.result)
}

#[tauri::command]
pub fn set_preference(
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    key: String,
    value: Value,
) -> AppResult<Value> {
    let value = service.set_preference(&key, value)?.result;
    if matches!(key.as_str(), "supabaseUrl" | "supabasePublishableKey") {
        wake.wake();
    }
    Ok(value)
}

#[tauri::command]
pub fn set_sync_settings(
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    url: String,
    publishable_key: String,
) -> AppResult<Value> {
    let value = service.set_sync_settings(&url, &publishable_key)?.result;
    wake.wake();
    Ok(value)
}

#[tauri::command]
pub fn next_outbox(service: State<'_, TaskService>, limit: u32) -> AppResult<Vec<OutboxMutation>> {
    Ok(service.next_outbox(limit)?.result)
}

#[tauri::command]
pub fn ack_outbox(
    app: AppHandle,
    service: State<'_, TaskService>,
    operation_id: String,
    remote_task: Task,
) -> AppResult<Task> {
    let result = service.ack_outbox(&operation_id, remote_task)?;
    let _ = app.emit("todou://tasks-changed", result.revision);
    Ok(result.result)
}

#[tauri::command]
pub fn apply_remote_page(
    app: AppHandle,
    service: State<'_, TaskService>,
    page: RemotePage,
) -> AppResult<MergeSummary> {
    let summary = service.apply_remote_page(page)?;
    if summary.inserted + summary.updated > 0 {
        let _ = app.emit("todou://tasks-changed", summary.revision);
    }
    Ok(summary)
}

#[tauri::command]
pub fn bootstrap_remote(
    app: AppHandle,
    service: State<'_, TaskService>,
    payload: BootstrapPayload,
) -> AppResult<MergeSummary> {
    let summary = service.bootstrap_remote(payload)?;
    if summary.inserted + summary.updated > 0 {
        let _ = app.emit("todou://tasks-changed", summary.revision);
    }
    Ok(summary)
}

#[tauri::command]
pub fn sync_diagnostics(service: State<'_, TaskService>) -> AppResult<Value> {
    Ok(service.sync_diagnostics()?.result)
}

#[tauri::command]
pub fn wake_sync(wake: State<'_, SyncWake>) -> u64 {
    wake.wake()
}

#[tauri::command]
pub fn show_quick_entry(app: AppHandle) -> AppResult<()> {
    lifecycle::show_quick_entry(&app)
}

#[tauri::command]
pub fn hide_quick_entry(app: AppHandle) -> AppResult<()> {
    lifecycle::hide_quick_entry(&app)
}

#[tauri::command]
pub fn register_quick_entry_shortcut(app: AppHandle, accelerator: String) -> AppResult<()> {
    lifecycle::register_quick_entry_shortcut(&app, &accelerator)
        .map_err(|error| AppError::invalid_input(format!("global shortcut unavailable: {error}")))
}

#[cfg(debug_assertions)]
fn newest_dmg(directory: &Path) -> AppResult<PathBuf> {
    let mut builds = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(AppError::storage)? {
        let entry = entry.map_err(AppError::storage)?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("dmg") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map_err(AppError::storage)?;
        builds.push((modified, path));
    }

    builds
        .into_iter()
        .max_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)))
        .map(|(_, path)| path)
        .ok_or_else(|| AppError::storage("the build finished without producing a DMG"))
}

#[cfg(debug_assertions)]
fn build_and_open_dmg() -> AppResult<PathBuf> {
    let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::storage("the project root is unavailable"))?;
    let build = Command::new("bun")
        .args(["run", "build"])
        // Tauri skips its temporary Finder window in CI mode.
        .env("CI", "true")
        .current_dir(project_root)
        .status()
        .map_err(|error| AppError::storage(format!("could not start Bun: {error}")))?;
    if !build.success() {
        return Err(AppError::storage(format!(
            "the production build failed with {build}"
        )));
    }

    let dmg = newest_dmg(&project_root.join("src-tauri/target/release/bundle/dmg"))?;
    let open = Command::new("/usr/bin/open")
        .arg(&dmg)
        .status()
        .map_err(|error| AppError::storage(format!("could not open the DMG: {error}")))?;
    if !open.success() {
        return Err(AppError::storage(format!(
            "macOS could not open the DMG ({open})"
        )));
    }

    Ok(dmg)
}

#[tauri::command]
pub async fn dev_build_and_open_dmg() -> AppResult<String> {
    #[cfg(not(debug_assertions))]
    {
        Err(AppError::invalid_input(
            "production builds are only available in the development app",
        ))
    }

    #[cfg(debug_assertions)]
    {
        let dmg = tauri::async_runtime::spawn_blocking(build_and_open_dmg)
            .await
            .map_err(|error| AppError::storage(format!("the build worker stopped: {error}")))??;
        Ok(dmg.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ExportTask;
    use serde_json::json;

    fn snapshot() -> ExportSnapshot {
        ExportSnapshot {
            schema_version: 1,
            exported_at: "2026-07-20T19:20:21.123Z".to_owned(),
            tasks: vec![ExportTask {
                id: "task-1".to_owned(),
                title: "Plan the week".to_owned(),
                bucket: Bucket::Today,
                priority: crate::domain::Priority::High,
                area: crate::domain::Area::Work,
                due_date: None,
                estimate_minutes: Some(30),
                order_key: "V".to_owned(),
                completed_at: None,
                created_at: "2026-07-20T19:00:00.000Z".to_owned(),
                updated_at: "2026-07-20T19:00:00.000Z".to_owned(),
            }],
            preferences: BTreeMap::from([("theme".to_owned(), json!("dracula"))]),
        }
    }

    #[test]
    fn native_export_is_pretty_and_includes_device_ui_preferences() {
        let json = export_document(
            &snapshot(),
            json!({ "themeId": "nord", "shortcuts": { "search": "Meta+P" } }),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["tasks"][0]["title"], "Plan the week");
        assert_eq!(parsed["preferences"]["theme"], "dracula");
        assert_eq!(parsed["preferences"]["ui"]["themeId"], "nord");
        assert!(json.contains("\n  \"schemaVersion\""));
    }

    #[test]
    fn native_export_filename_is_filesystem_safe() {
        assert_eq!(
            export_filename("2026-07-20T19:20:21.123Z"),
            "Todou Export 2026-07-20T19_20_21_123Z.json"
        );
    }

    #[test]
    fn native_export_writes_one_json_file() {
        let directory = tempfile::tempdir().unwrap();
        let json = export_document(&snapshot(), json!({ "themeId": "superhuman" })).unwrap();
        let path = write_export(directory.path(), "Todou Export test.json", &json).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), json);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn native_build_finds_the_generated_dmg() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("build.log"), "not a bundle").unwrap();
        let dmg = directory.path().join("Todou_0.1.0_aarch64.dmg");
        std::fs::write(&dmg, "bundle").unwrap();

        assert_eq!(newest_dmg(directory.path()).unwrap(), dmg);
    }

    #[test]
    fn native_build_rejects_a_missing_dmg() {
        let directory = tempfile::tempdir().unwrap();
        let error = newest_dmg(directory.path()).unwrap_err();

        assert_eq!(error.code, crate::error::ErrorCode::StorageUnavailable);
        assert!(error.message.contains("without producing a DMG"));
    }
}
