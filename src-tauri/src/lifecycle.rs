use crate::{
    error::{AppError, AppResult},
    service::TaskService,
    transient_focus, work_mode,
};
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const DEFAULT_QUICK_ENTRY_SHORTCUT: &str = "Control+Shift+Space";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickEntryShown {
    session_id: u64,
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    install_application_menu(app)?;

    let show = MenuItem::with_id(app, "show", "Show Todou", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick Entry", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Todou", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quick, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_primary_window(app);
            }
            "quick" => {
                let _ = show_quick_entry(app);
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    if let Err(error) = register_quick_entry_shortcut(app.handle(), DEFAULT_QUICK_ENTRY_SHORTCUT) {
        tracing::warn!(%error, "default quick-entry shortcut is unavailable");
    }
    let autostart = app.autolaunch();
    match autostart.is_enabled() {
        Ok(false) => {
            if let Err(error) = autostart.enable() {
                tracing::warn!(%error, "could not enable launch at login");
            }
        }
        Err(error) => tracing::warn!(%error, "could not inspect launch-at-login state"),
        Ok(true) => {}
    }

    if std::env::args().any(|argument| argument == "--background") {
        if let Some(window) = app.get_webview_window("main") {
            window.hide()?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_application_menu(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = Menu::default(app.handle())?;
    let application_submenu = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        })
        .ok_or("default macOS application menu is unavailable")?;
    let predefined_quit = application_submenu
        .items()?
        .into_iter()
        .next_back()
        .filter(|item| matches!(item, MenuItemKind::Predefined(_)))
        .ok_or("default macOS Quit item is unavailable")?;
    application_submenu.remove(&predefined_quit)?;
    application_submenu.append(&MenuItem::with_id(
        app,
        "application-quit",
        "Quit Todou",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() != "application-quit" {
            return;
        }
        if work_mode::should_intercept_quit(app, app.state::<TaskService>().inner()) {
            let _ = work_mode::deactivate_after_interaction(app);
        } else {
            app.exit(0);
        }
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn install_application_menu(_app: &App) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub fn show_main(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::storage("main window is unavailable"))?;
    window.show().map_err(AppError::storage)?;
    window.unminimize().map_err(AppError::storage)?;
    window.set_focus().map_err(AppError::storage)
}

pub fn show_primary_window(app: &AppHandle) -> AppResult<()> {
    match work_mode::show_active_work_mode(app, app.state::<TaskService>().inner()) {
        Ok(true) => Ok(()),
        Ok(false) => show_main(app),
        Err(error) => {
            tracing::warn!(%error, "could not reveal active work mode");
            show_main(app)
        }
    }
}

pub fn show_quick_entry(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("quick-entry")
        .ok_or_else(|| AppError::storage("quick-entry window is unavailable"))?;
    let session_id = transient_focus::prepare_quick_entry(app, &window)?;
    let show_result = window
        .show()
        .map_err(AppError::storage)
        .and_then(|_| window.set_focus().map_err(AppError::storage))
        .and_then(|_| {
            window
                .emit("todou://quick-entry-shown", QuickEntryShown { session_id })
                .map_err(AppError::storage)
        });
    if show_result.is_err() {
        let _ = transient_focus::dismiss_quick_entry(app, &window, Some(session_id), true);
    }
    show_result
}

pub fn dismiss_quick_entry(
    app: &AppHandle,
    session_id: Option<u64>,
    restore: bool,
) -> AppResult<()> {
    let window = app
        .get_webview_window("quick-entry")
        .ok_or_else(|| AppError::storage("quick-entry window is unavailable"))?;
    transient_focus::dismiss_quick_entry(app, &window, session_id, restore)?;
    Ok(())
}

pub fn register_quick_entry_shortcut(
    app: &AppHandle,
    accelerator: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if accelerator.trim().is_empty() {
        return Err("shortcut cannot be empty".into());
    }
    app.global_shortcut().unregister_all()?;
    if let Err(error) = app.global_shortcut().register(accelerator) {
        let _ = app.global_shortcut().register(DEFAULT_QUICK_ENTRY_SHORTCUT);
        return Err(error.into());
    }
    Ok(())
}
