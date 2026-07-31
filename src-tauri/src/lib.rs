mod commands;
mod dedupe;
pub mod domain;
pub mod error;
pub mod hlc;
mod lifecycle;
mod llm;
pub mod order_key;
pub mod protocol;
pub mod service;
mod socket;
pub mod sync;
mod work_mode;

use crate::{dedupe::DedupeCoordinator, service::TaskService, sync::SyncWake};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "todou=info".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, _cwd| {
                if !arguments.iter().any(|argument| argument == "--background") {
                    let _ = lifecycle::show_primary_window(app);
                }
            },
        ))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = lifecycle::show_quick_entry(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let service = TaskService::open(data_dir.join("todou.sqlite3"))?;
            let wake = SyncWake::default();
            let dedupe = DedupeCoordinator::new()?;
            let socket_path = data_dir.join("todou.sock");
            app.manage(service.clone());
            app.manage(wake.clone());
            app.manage(dedupe);
            let socket_app = app.handle().clone();
            let socket_wake = wake.clone();
            let socket_service = service.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) =
                    socket::serve(socket_path, socket_service, socket_wake, socket_app).await
                {
                    tracing::error!(%error, "local task socket stopped");
                }
            });
            sync::spawn_worker(app.handle().clone(), service.clone(), wake);
            lifecycle::setup(app)?;
            if let Err(error) = work_mode::restore_active_work_mode(app.handle(), &service) {
                tracing::warn!(%error, "could not restore work mode");
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(false) if window.label() == "quick-entry" => {
                let _ = window.hide();
            }
            WindowEvent::Focused(true) if window.label() == "main" => {
                let app = window.app_handle();
                app.state::<DedupeCoordinator>()
                    .schedule(app.clone(), app.state::<TaskService>().inner().clone());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_task,
            commands::get_task,
            commands::update_task,
            commands::move_task,
            commands::reorder_task,
            commands::complete_task,
            commands::restore_task,
            commands::delete_task,
            commands::undo_delete,
            commands::rollover_due,
            commands::list_tasks,
            commands::search_tasks,
            commands::export_tasks,
            commands::export_tasks_to_file,
            commands::get_preferences,
            commands::set_preference,
            commands::set_sync_settings,
            commands::get_llm_settings,
            commands::save_llm_settings,
            commands::process_pending_dedupe,
            commands::run_dedupe_scan,
            commands::list_dedupe_suggestions,
            commands::dismiss_dedupe_suggestion,
            commands::resolve_dedupe_suggestion,
            commands::next_outbox,
            commands::ack_outbox,
            commands::apply_remote_page,
            commands::bootstrap_remote,
            commands::sync_diagnostics,
            commands::sync_status,
            commands::wake_sync,
            commands::show_quick_entry,
            commands::hide_quick_entry,
            commands::register_quick_entry_shortcut,
            commands::dev_build_and_install_app,
            work_mode::start_work_mode,
            work_mode::stop_work_mode,
            work_mode::load_work_mode_session,
            work_mode::checkpoint_work_mode_session,
            work_mode::get_system_activity_sample,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Todou");

    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            let _ = lifecycle::show_primary_window(app);
            app.state::<DedupeCoordinator>()
                .schedule(app.clone(), app.state::<TaskService>().inner().clone());
        }
    });
}
