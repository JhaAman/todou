use crate::error::{AppError, AppResult};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const DEFAULT_QUICK_ENTRY_SHORTCUT: &str = "Control+Space";

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show Todou", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick Entry", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Todou", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quick, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_main(app);
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

pub fn show_main(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::storage("main window is unavailable"))?;
    window.show().map_err(AppError::storage)?;
    window.unminimize().map_err(AppError::storage)?;
    window.set_focus().map_err(AppError::storage)
}

pub fn show_quick_entry(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("quick-entry")
        .ok_or_else(|| AppError::storage("quick-entry window is unavailable"))?;
    window.center().map_err(AppError::storage)?;
    window.show().map_err(AppError::storage)?;
    window.set_focus().map_err(AppError::storage)?;
    window
        .emit("todou://quick-entry-shown", ())
        .map_err(AppError::storage)
}

pub fn hide_quick_entry(app: &AppHandle) -> AppResult<()> {
    let window = app
        .get_webview_window("quick-entry")
        .ok_or_else(|| AppError::storage("quick-entry window is unavailable"))?;
    window.hide().map_err(AppError::storage)
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
