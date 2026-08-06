use crate::error::AppResult;
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Debug, PartialEq, Eq)]
enum RestoreTarget<T> {
    External(T),
    TodouMain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct QuickEntrySession<T> {
    generation: u64,
    target: Option<RestoreTarget<T>>,
}

#[derive(Debug)]
struct FocusLedger<T> {
    next_generation: u64,
    quick_entry: Option<QuickEntrySession<T>>,
    work_mode_target: Option<T>,
    work_mode_generation: u64,
}

impl<T> Default for FocusLedger<T> {
    fn default() -> Self {
        Self {
            next_generation: 0,
            quick_entry: None,
            work_mode_target: None,
            work_mode_generation: 0,
        }
    }
}

impl<T: Clone> FocusLedger<T> {
    fn begin_quick_entry(&mut self, candidate: Option<RestoreTarget<T>>) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        let target = self
            .quick_entry
            .take()
            .and_then(|session| session.target)
            .or(candidate);
        let generation = self.next_generation;
        self.quick_entry = Some(QuickEntrySession { generation, target });
        generation
    }

    fn finish_quick_entry(
        &mut self,
        expected_generation: Option<u64>,
    ) -> Option<Option<RestoreTarget<T>>> {
        let session = self.quick_entry.as_ref()?;
        if expected_generation.is_some_and(|expected| expected != session.generation) {
            return None;
        }
        self.quick_entry.take().map(|session| session.target)
    }

    fn begin_work_mode(&mut self, external: Option<T>) -> u64 {
        self.work_mode_generation = self.work_mode_generation.wrapping_add(1).max(1);
        if let Some(external) = external {
            self.work_mode_target = Some(external);
        }
        self.work_mode_generation
    }

    fn observe_work_mode_external(&mut self, generation: u64, external: T) {
        if self.work_mode_generation == generation {
            self.work_mode_target = Some(external);
        }
    }

    fn end_work_mode(&mut self) {
        self.work_mode_generation = self.work_mode_generation.wrapping_add(1).max(1);
        self.work_mode_target = None;
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{FocusLedger, RestoreTarget};
    use crate::error::{AppError, AppResult};
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSScreen, NSWindow,
        NSWindowCollectionBehavior, NSWorkspace,
    };
    use parking_lot::Mutex;
    use std::{sync::mpsc, thread, time::Duration};
    use tauri::{AppHandle, Manager, WebviewWindow};

    type Application = Retained<NSRunningApplication>;

    #[derive(Default)]
    pub struct TransientFocus {
        ledger: Mutex<FocusLedger<Application>>,
    }

    pub fn prepare_quick_entry(app: &AppHandle, window: &WebviewWindow) -> AppResult<u64> {
        let app_for_native = app.clone();
        let window_for_native = window.clone();
        run_on_main(app, move || {
            let external = frontmost_external();
            let main_focused = app_for_native
                .get_webview_window("main")
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false);
            let state = app_for_native.state::<TransientFocus>();
            let candidate = external
                .map(RestoreTarget::External)
                .or_else(|| main_focused.then_some(RestoreTarget::TodouMain))
                .or_else(|| {
                    state
                        .ledger
                        .lock()
                        .work_mode_target
                        .clone()
                        .map(RestoreTarget::External)
                });
            let generation = state.ledger.lock().begin_quick_entry(candidate);
            configure_quick_window(&window_for_native)?;
            Ok(generation)
        })
    }

    pub fn dismiss_quick_entry(
        app: &AppHandle,
        window: &WebviewWindow,
        expected_generation: Option<u64>,
        restore: bool,
    ) -> AppResult<bool> {
        let app_for_native = app.clone();
        let window_for_native = window.clone();
        run_on_main(app, move || {
            let state = app_for_native.state::<TransientFocus>();
            let Some(target) = state.ledger.lock().finish_quick_entry(expected_generation) else {
                return Ok(false);
            };
            window_for_native.hide().map_err(AppError::storage)?;
            if restore && current_application_is_active() {
                restore_target(&app_for_native, target);
            }
            Ok(true)
        })
    }

    pub fn begin_work_mode(app: &AppHandle) -> AppResult<()> {
        let app_for_native = app.clone();
        run_on_main(app, move || {
            let external = frontmost_external();
            app_for_native
                .state::<TransientFocus>()
                .ledger
                .lock()
                .begin_work_mode(external);
            Ok(())
        })
    }

    pub fn restore_after_work_mode_interaction(app: &AppHandle) -> AppResult<()> {
        let app_for_native = app.clone();
        let generation = run_on_main(app, move || {
            let state = app_for_native.state::<TransientFocus>();
            if let Some(external) = frontmost_external() {
                let mut ledger = state.ledger.lock();
                let generation = ledger.work_mode_generation;
                ledger.observe_work_mode_external(generation, external);
                return Ok(None);
            }
            let ledger = state.ledger.lock();
            let generation = ledger.work_mode_generation;
            restore_external(ledger.work_mode_target.clone());
            Ok(Some(generation))
        })?;
        if let Some(generation) = generation {
            schedule_work_mode_observation(app.clone(), generation);
        }
        Ok(())
    }

    pub fn end_work_mode(app: &AppHandle) {
        app.state::<TransientFocus>().ledger.lock().end_work_mode();
    }

    fn configure_quick_window(window: &WebviewWindow) -> AppResult<()> {
        let native_window = window.ns_window().map_err(AppError::storage)? as *const NSWindow;
        let window = unsafe { &*native_window };
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        if let Some(main_screen) = MainThreadMarker::new().and_then(NSScreen::mainScreen) {
            let screen = main_screen.frame();
            let frame = window.frame();
            let mut origin = frame.origin;
            origin.x = screen.origin.x + (screen.size.width - frame.size.width) / 2.0;
            origin.y = screen.origin.y + (screen.size.height - frame.size.height) / 2.0;
            window.setFrameOrigin(origin);
        }
        Ok(())
    }

    fn restore_target(app: &AppHandle, target: Option<RestoreTarget<Application>>) {
        match target {
            Some(RestoreTarget::External(target)) => restore_external(Some(target)),
            Some(RestoreTarget::TodouMain) => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_focus();
                }
            }
            None => restore_external(None),
        }
    }

    fn restore_external(target: Option<Application>) {
        let Some(main_thread) = MainThreadMarker::new() else {
            return;
        };
        let application = NSApplication::sharedApplication(main_thread);
        application.deactivate();
        if let Some(target) = target.filter(|target| !target.isTerminated()) {
            target.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }

    fn frontmost_external() -> Option<Application> {
        let current = NSRunningApplication::currentApplication();
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .filter(|application| !application.isTerminated() && application != &current)
    }

    fn current_application_is_active() -> bool {
        NSRunningApplication::currentApplication().isActive()
    }

    fn schedule_work_mode_observation(app: AppHandle, generation: u64) {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            let app_for_native = app.clone();
            let _ = app.run_on_main_thread(move || {
                let state = app_for_native.state::<TransientFocus>();
                if let Some(external) = frontmost_external() {
                    state
                        .ledger
                        .lock()
                        .observe_work_mode_external(generation, external);
                    return;
                }
                let ledger = state.ledger.lock();
                if ledger.work_mode_generation == generation && current_application_is_active() {
                    restore_external(ledger.work_mode_target.clone());
                }
            });
        });
    }

    fn run_on_main<T, F>(app: &AppHandle, action: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> AppResult<T> + Send + 'static,
    {
        if MainThreadMarker::new().is_some() {
            return action();
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.send(action());
        })
        .map_err(AppError::storage)?;
        receiver
            .recv()
            .map_err(|_| AppError::storage("macOS focus operation did not complete"))?
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::FocusLedger;
    use crate::error::AppResult;
    use parking_lot::Mutex;
    use tauri::{AppHandle, WebviewWindow};

    #[derive(Default)]
    pub struct TransientFocus {
        ledger: Mutex<FocusLedger<()>>,
    }

    pub fn prepare_quick_entry(app: &AppHandle, _window: &WebviewWindow) -> AppResult<u64> {
        Ok(app
            .state::<TransientFocus>()
            .ledger
            .lock()
            .begin_quick_entry(None))
    }

    pub fn dismiss_quick_entry(
        app: &AppHandle,
        window: &WebviewWindow,
        expected_generation: Option<u64>,
        _restore: bool,
    ) -> AppResult<bool> {
        let matched = app
            .state::<TransientFocus>()
            .ledger
            .lock()
            .finish_quick_entry(expected_generation)
            .is_some();
        if matched {
            window.hide().map_err(crate::error::AppError::storage)?;
        }
        Ok(matched)
    }

    pub fn begin_work_mode(app: &AppHandle) -> AppResult<()> {
        app.state::<TransientFocus>()
            .ledger
            .lock()
            .begin_work_mode(None);
        Ok(())
    }

    pub fn restore_after_work_mode_interaction(_app: &AppHandle) -> AppResult<()> {
        Ok(())
    }

    pub fn end_work_mode(app: &AppHandle) {
        app.state::<TransientFocus>().ledger.lock().end_work_mode();
    }
}

pub use platform::TransientFocus;

pub fn prepare_quick_entry(app: &AppHandle, window: &WebviewWindow) -> AppResult<u64> {
    platform::prepare_quick_entry(app, window)
}

pub fn dismiss_quick_entry(
    app: &AppHandle,
    window: &WebviewWindow,
    expected_generation: Option<u64>,
    restore: bool,
) -> AppResult<bool> {
    platform::dismiss_quick_entry(app, window, expected_generation, restore)
}

pub fn begin_work_mode(app: &AppHandle) -> AppResult<()> {
    platform::begin_work_mode(app)
}

pub fn restore_after_work_mode_interaction(app: &AppHandle) -> AppResult<()> {
    platform::restore_after_work_mode_interaction(app)
}

pub fn end_work_mode(app: &AppHandle) {
    platform::end_work_mode(app);
}

#[cfg(test)]
mod tests {
    use super::{FocusLedger, RestoreTarget};

    #[test]
    fn repeated_quick_entry_preserves_original_target_and_rejects_stale_close() {
        let mut ledger = FocusLedger::default();
        let first = ledger.begin_quick_entry(Some(RestoreTarget::External("Spotify")));
        let second = ledger.begin_quick_entry(None);

        assert_ne!(first, second);
        assert_eq!(ledger.finish_quick_entry(Some(first)), None);
        assert_eq!(
            ledger.finish_quick_entry(Some(second)),
            Some(Some(RestoreTarget::External("Spotify")))
        );
    }

    #[test]
    fn duplicate_quick_entry_close_is_idempotent() {
        let mut ledger = FocusLedger::<&str>::default();
        let generation = ledger.begin_quick_entry(Some(RestoreTarget::TodouMain));

        assert_eq!(
            ledger.finish_quick_entry(Some(generation)),
            Some(Some(RestoreTarget::TodouMain))
        );
        assert_eq!(ledger.finish_quick_entry(Some(generation)), None);
    }

    #[test]
    fn quick_entry_over_work_mode_can_restore_the_external_app() {
        let mut ledger = FocusLedger::default();
        ledger.begin_work_mode(Some("Spotify"));
        let target = ledger.work_mode_target.map(RestoreTarget::External);
        let generation = ledger.begin_quick_entry(target);

        assert_eq!(
            ledger.finish_quick_entry(Some(generation)),
            Some(Some(RestoreTarget::External("Spotify")))
        );
    }

    #[test]
    fn stale_work_mode_observation_does_not_replace_the_new_target() {
        let mut ledger = FocusLedger::default();
        let old = ledger.begin_work_mode(Some("Spotify"));
        let current = ledger.begin_work_mode(Some("Safari"));

        ledger.observe_work_mode_external(old, "Finder");
        assert_eq!(ledger.work_mode_target, Some("Safari"));
        ledger.observe_work_mode_external(current, "Music");
        assert_eq!(ledger.work_mode_target, Some("Music"));
    }
}
