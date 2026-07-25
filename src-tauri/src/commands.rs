use crate::{
    dedupe::{
        emit_suggestions_changed, DedupeCoordinator, LlmSettingsStatus, SaveLlmSettingsInput,
    },
    domain::{
        BootstrapPayload, Bucket, CreateTaskInput, ExportSnapshot, MergeSummary, OutboxMutation,
        RemotePage, Task, TaskFilter, UpdateTaskPatch,
    },
    error::{AppError, AppResult},
    lifecycle,
    service::{
        DedupeResolutionAction, DedupeResolutionOutcome, DedupeResolutionStatus, DedupeSuggestion,
        TaskService,
    },
    sync::SyncWake,
};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};
#[cfg(debug_assertions)]
use std::{path::PathBuf, process::Command};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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
    window: WebviewWindow,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    dedupe: State<'_, DedupeCoordinator>,
    input: CreateTaskInput,
) -> AppResult<Task> {
    let task = announce_change(&app, &wake, service.create_task(input)?);
    if window.label() == "main" {
        dedupe.schedule(app, service.inner().clone());
    }
    Ok(task)
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
pub fn get_llm_settings(
    service: State<'_, TaskService>,
    dedupe: State<'_, DedupeCoordinator>,
) -> AppResult<LlmSettingsStatus> {
    dedupe.settings_status(&service)
}

#[tauri::command]
pub async fn save_llm_settings(
    app: AppHandle,
    service: State<'_, TaskService>,
    dedupe: State<'_, DedupeCoordinator>,
    input: SaveLlmSettingsInput,
) -> AppResult<LlmSettingsStatus> {
    let status = dedupe.save_settings(&service, input).await?;
    dedupe.schedule(app, service.inner().clone());
    Ok(status)
}

#[tauri::command]
pub fn process_pending_dedupe(
    app: AppHandle,
    service: State<'_, TaskService>,
    dedupe: State<'_, DedupeCoordinator>,
) {
    dedupe.schedule(app, service.inner().clone());
}

#[tauri::command]
pub fn list_dedupe_suggestions(
    service: State<'_, TaskService>,
) -> AppResult<Vec<DedupeSuggestion>> {
    service.list_dedupe_suggestions()
}

#[tauri::command]
pub fn dismiss_dedupe_suggestion(
    app: AppHandle,
    service: State<'_, TaskService>,
    id: String,
) -> AppResult<()> {
    service.dismiss_dedupe_suggestion(&id)?;
    emit_suggestions_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn resolve_dedupe_suggestion(
    app: AppHandle,
    service: State<'_, TaskService>,
    wake: State<'_, SyncWake>,
    dedupe: State<'_, DedupeCoordinator>,
    id: String,
    action: DedupeResolutionAction,
) -> AppResult<DedupeResolutionOutcome> {
    let outcome = service.resolve_dedupe_suggestion(&id, action)?;
    if outcome.status == DedupeResolutionStatus::Stale {
        dedupe.schedule(app.clone(), service.inner().clone());
    }
    if outcome.sync_required {
        wake.wake();
        if let Err(error) = app.emit("todou://tasks-changed", outcome.revision) {
            tracing::warn!(%error, "could not emit task change event");
        }
    }
    emit_suggestions_changed(&app);
    Ok(outcome)
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
pub fn sync_status(wake: State<'_, SyncWake>) -> &'static str {
    wake.status()
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
fn is_todou_dmg(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name == "Todou.dmg" || name.starts_with("Todou_") && name.ends_with(".dmg")
}

#[cfg(debug_assertions)]
fn is_todou_installer_mount(path: &Path) -> bool {
    if path.parent() != Some(Path::new("/Volumes")) {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if name == "Todou" {
        return true;
    }
    name.strip_prefix("Todou ").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
    })
}

#[cfg(debug_assertions)]
fn mounted_todou_installers(hdiutil_info: &str) -> Vec<PathBuf> {
    let mut image_path = None;
    let mut mounts = Vec::new();
    for line in hdiutil_info.lines() {
        if line.starts_with("===") {
            image_path = None;
            continue;
        }
        if line.trim_start().starts_with("image-path") {
            image_path = line
                .split_once(':')
                .map(|(_, value)| PathBuf::from(value.trim()));
            continue;
        }
        let Some(mount_start) = line.find("/Volumes/") else {
            continue;
        };
        let mount = PathBuf::from(line[mount_start..].trim());
        if image_path.as_deref().is_some_and(is_todou_dmg) && is_todou_installer_mount(&mount) {
            mounts.push(mount);
        }
    }
    mounts
}

#[cfg(debug_assertions)]
fn detach_mounted_todou_installers() -> Vec<String> {
    let output = match Command::new("/usr/bin/hdiutil").arg("info").output() {
        Ok(output) if output.status.success() => output,
        _ => return vec!["mounted Todou installers could not be inspected".to_owned()],
    };
    let info = String::from_utf8_lossy(&output.stdout);
    let mut failures = Vec::new();
    for mount in mounted_todou_installers(&info) {
        if !mount.join("Todou.app").is_dir() || !mount.join("Applications").exists() {
            continue;
        }
        match Command::new("/usr/bin/hdiutil")
            .arg("detach")
            .arg(&mount)
            .status()
        {
            Ok(status) if status.success() => {}
            _ => failures.push(mount.to_string_lossy().into_owned()),
        }
    }
    failures
}

#[cfg(debug_assertions)]
fn installed_app_path() -> AppResult<PathBuf> {
    let system_app = PathBuf::from("/Applications/Todou.app");
    if system_app.is_dir() {
        return Ok(system_app);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::storage("the home directory is unavailable"))?;
    let user_app = home.join("Applications/Todou.app");
    user_app
        .is_dir()
        .then_some(user_app)
        .ok_or_else(|| AppError::storage("the installed production app is unavailable"))
}

#[cfg(debug_assertions)]
fn build_and_install_app() -> AppResult<String> {
    let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| AppError::storage("the project root is unavailable"))?;
    let script = project_root.join("scripts/install-macos-app.sh");
    if !script.is_file() {
        return Err(AppError::storage(
            "the macOS installer script is unavailable",
        ));
    }
    let install = Command::new(&script)
        .env("TODOU_OPEN_AFTER_INSTALL", "0")
        .current_dir(project_root)
        .status()
        .map_err(|error| AppError::storage(format!("could not start the installer: {error}")))?;
    if !install.success() {
        return Err(AppError::storage(format!(
            "the production install failed with {install}"
        )));
    }
    let cleanup_failures = detach_mounted_todou_installers();
    if !cleanup_failures.is_empty() {
        return Ok(format!(
            "Production app installed; eject {} from Finder",
            cleanup_failures.join(", ")
        ));
    }
    let installed_app = installed_app_path()?;
    let open = Command::new("/usr/bin/open")
        .arg(&installed_app)
        .status()
        .map_err(|error| AppError::storage(format!("could not open the installed app: {error}")))?;
    if open.success() {
        Ok("Production app installed".to_owned())
    } else {
        Ok("Production app installed but could not be opened automatically".to_owned())
    }
}

#[tauri::command]
pub async fn dev_build_and_install_app() -> AppResult<String> {
    #[cfg(not(debug_assertions))]
    {
        Err(AppError::invalid_input(
            "production builds are only available in the development app",
        ))
    }

    #[cfg(debug_assertions)]
    {
        tauri::async_runtime::spawn_blocking(build_and_install_app)
            .await
            .map_err(|error| AppError::storage(format!("the install worker stopped: {error}")))?
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
                description: "Review the project brief".to_owned(),
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
    fn native_build_finds_only_mounted_todou_installer_images() {
        let info = r#"
================================================
image-path      : /tmp/Todou_0.1.0_aarch64.dmg
/dev/disk5s1	Apple_HFS	/Volumes/Todou 1
================================================
image-path      : /tmp/Other.dmg
/dev/disk6s1	Apple_HFS	/Volumes/Todou 2
================================================
image-path      : /tmp/Todou_0.1.0_aarch64.dmg
/dev/disk7s1	Apple_HFS	/Volumes/Todou 3 backup
"#;

        assert_eq!(
            mounted_todou_installers(info),
            vec![PathBuf::from("/Volumes/Todou 1")]
        );
    }
}
