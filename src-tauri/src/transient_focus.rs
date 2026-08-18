use crate::error::AppResult;
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq)]
struct ScreenRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn screen_with_largest_intersection(window: ScreenRect, screens: &[ScreenRect]) -> Option<usize> {
    screens
        .iter()
        .enumerate()
        .filter_map(|(index, screen)| {
            let width =
                (window.x + window.width).min(screen.x + screen.width) - window.x.max(screen.x);
            let height =
                (window.y + window.height).min(screen.y + screen.height) - window.y.max(screen.y);
            let area = width.max(0.0) * height.max(0.0);
            (area > 0.0).then_some((index, area))
        })
        .reduce(|best, candidate| {
            if candidate.1 > best.1 {
                candidate
            } else {
                best
            }
        })
        .map(|(index, _)| index)
}

fn appkit_rect_from_quartz(rect: ScreenRect, primary_top: f64) -> ScreenRect {
    ScreenRect {
        y: primary_top - rect.y - rect.height,
        ..rect
    }
}

fn centered_origin(screen: ScreenRect, window: ScreenRect) -> (f64, f64) {
    (
        screen.x + (screen.width - window.width) / 2.0,
        screen.y + (screen.height - window.height) / 2.0,
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RestoreTarget<T> {
    External(T),
    TodouMain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct QuickEntrySession<T> {
    generation: u64,
    target: Option<RestoreTarget<T>>,
    restore_regular_activation_policy: bool,
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
    fn begin_quick_entry(
        &mut self,
        candidate: Option<RestoreTarget<T>>,
        restore_regular_activation_policy: bool,
    ) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        let previous = self.quick_entry.take();
        let target = previous
            .as_ref()
            .and_then(|session| session.target.clone())
            .or(candidate);
        let restore_regular_activation_policy = restore_regular_activation_policy
            || previous.is_some_and(|session| session.restore_regular_activation_policy);
        let generation = self.next_generation;
        self.quick_entry = Some(QuickEntrySession {
            generation,
            target,
            restore_regular_activation_policy,
        });
        generation
    }

    fn finish_quick_entry(
        &mut self,
        expected_generation: Option<u64>,
    ) -> Option<(Option<RestoreTarget<T>>, bool)> {
        let session = self.quick_entry.as_ref()?;
        if expected_generation.is_some_and(|expected| expected != session.generation) {
            return None;
        }
        self.quick_entry
            .take()
            .map(|session| (session.target, session.restore_regular_activation_policy))
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
    use super::{
        appkit_rect_from_quartz, centered_origin, screen_with_largest_intersection, FocusLedger,
        RestoreTarget, ScreenRect,
    };
    use crate::error::{AppError, AppResult};
    use core_foundation::{
        array::CFArray,
        base::{CFType, TCFType},
        dictionary::CFDictionary,
        number::CFNumber,
        string::CFString,
    };
    use core_graphics::{
        geometry::CGRect,
        window::{
            copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
            kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
            kCGWindowOwnerPID,
        },
    };
    use objc2::{
        define_class, ffi,
        rc::Retained,
        runtime::{AnyObject, NSObjectProtocol},
        ClassType, MainThreadMarker, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSApplicationActivationPolicy, NSEvent,
        NSPanel, NSRunningApplication, NSScreen, NSScreenSaverWindowLevel, NSWindow,
        NSWindowCollectionBehavior, NSWindowStyleMask, NSWorkspace,
    };
    use parking_lot::Mutex;
    use std::{ptr, sync::mpsc, thread, time::Duration};
    use tauri::{AppHandle, Manager, WebviewWindow};

    type Application = Retained<NSRunningApplication>;

    #[derive(Default)]
    struct QuickEntryPanelIvars;

    define_class!(
        #[unsafe(super = NSPanel)]
        #[name = "TodouQuickEntryPanel"]
        #[thread_kind = MainThreadOnly]
        #[ivars = QuickEntryPanelIvars]
        struct QuickEntryPanel;

        unsafe impl NSObjectProtocol for QuickEntryPanel {}

        impl QuickEntryPanel {
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                true
            }

            #[unsafe(method(canBecomeMainWindow))]
            fn can_become_main_window(&self) -> bool {
                false
            }
        }
    );

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
            let work_mode_target = state.ledger.lock().work_mode_target.clone();
            let candidate = external
                .clone()
                .map(RestoreTarget::External)
                .or_else(|| main_focused.then_some(RestoreTarget::TodouMain))
                .or_else(|| work_mode_target.map(RestoreTarget::External));
            let screen = target_screen(&app_for_native, candidate.as_ref())?;
            configure_quick_window(&window_for_native, screen)?;

            let native_app = NSApplication::sharedApplication(
                MainThreadMarker::new()
                    .ok_or_else(|| AppError::storage("Quick Entry requires the main thread"))?,
            );
            let restore_regular_activation_policy =
                matches!(candidate, Some(RestoreTarget::External(_)))
                    && native_app.activationPolicy() == NSApplicationActivationPolicy::Regular;
            if restore_regular_activation_policy
                && !native_app.setActivationPolicy(NSApplicationActivationPolicy::Accessory)
            {
                return Err(AppError::storage(
                    "could not enter Quick Entry activation mode",
                ));
            }
            let generation = state
                .ledger
                .lock()
                .begin_quick_entry(candidate, restore_regular_activation_policy);
            Ok(generation)
        })
    }

    pub fn show_quick_entry(window: &WebviewWindow) -> AppResult<()> {
        let window_for_native = window.clone();
        let app = window.app_handle().clone();
        run_on_main(&app, move || {
            let native_window =
                window_for_native.ns_window().map_err(AppError::storage)? as *const NSWindow;
            let window = unsafe { &*native_window };
            window.orderFrontRegardless();
            window.makeKeyWindow();

            let current = NSRunningApplication::currentApplication();
            if !current.isActive()
                && NSApplication::sharedApplication(
                    MainThreadMarker::new()
                        .ok_or_else(|| AppError::storage("Quick Entry requires the main thread"))?,
                )
                .activationPolicy()
                    == NSApplicationActivationPolicy::Regular
            {
                current.activateWithOptions(NSApplicationActivationOptions::empty());
            }
            Ok(())
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
            let matches = state
                .ledger
                .lock()
                .quick_entry
                .as_ref()
                .is_some_and(|session| {
                    expected_generation.is_none_or(|expected| expected == session.generation)
                });
            if !matches {
                return Ok(false);
            }
            let native_window = match window_for_native.ns_window() {
                Ok(window) => window as *const NSWindow,
                Err(error) => {
                    if let Some((target, restore_regular_activation_policy)) =
                        state.ledger.lock().finish_quick_entry(expected_generation)
                    {
                        restore_regular_activation_policy_if_needed(
                            restore_regular_activation_policy,
                        );
                        if restore {
                            restore_target(&app_for_native, target);
                        }
                    }
                    return Err(AppError::storage(error));
                }
            };
            let window = unsafe { &*native_window };
            let should_restore =
                restore && (current_application_is_active() || window.isKeyWindow());
            window.orderOut(None);
            let Some((target, restore_regular_activation_policy)) =
                state.ledger.lock().finish_quick_entry(expected_generation)
            else {
                return Ok(false);
            };
            restore_regular_activation_policy_if_needed(restore_regular_activation_policy);
            if should_restore {
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
                ledger.work_mode_target = Some(external);
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

    fn configure_quick_window(window: &WebviewWindow, screen: ScreenRect) -> AppResult<()> {
        let native_window = window.ns_window().map_err(AppError::storage)? as *const NSWindow;
        let window = unsafe { &*native_window };
        let panel = convert_to_quick_panel(window)?;
        panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        panel.setFloatingPanel(true);
        panel.setHidesOnDeactivate(false);
        panel.setLevel(NSScreenSaverWindowLevel);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::CanJoinAllApplications
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        let frame = panel.frame();
        let (x, y) = centered_origin(
            screen,
            ScreenRect {
                x: frame.origin.x,
                y: frame.origin.y,
                width: frame.size.width,
                height: frame.size.height,
            },
        );
        let mut origin = frame.origin;
        origin.x = x;
        origin.y = y;
        panel.setFrameOrigin(origin);
        Ok(())
    }

    fn convert_to_quick_panel(window: &NSWindow) -> AppResult<&QuickEntryPanel> {
        let object = unsafe { &*(window as *const NSWindow as *const AnyObject) };
        if ptr::eq(object.class(), QuickEntryPanel::class()) {
            return Ok(unsafe { &*(window as *const NSWindow as *const QuickEntryPanel) });
        }
        if QuickEntryPanel::class().instance_size() > object.class().instance_size() {
            return Err(AppError::storage(
                "native Quick Entry panel is larger than Tauri's window allocation",
            ));
        }
        let old_class = object.class();
        let replaced = unsafe {
            ffi::object_setClass(
                window as *const NSWindow as *mut AnyObject,
                QuickEntryPanel::class(),
            )
        };
        if !ptr::eq(replaced, old_class) {
            return Err(AppError::storage(
                "native Quick Entry window class changed unexpectedly",
            ));
        }
        Ok(unsafe { &*(window as *const NSWindow as *const QuickEntryPanel) })
    }

    fn target_screen(
        app: &AppHandle,
        target: Option<&RestoreTarget<Application>>,
    ) -> AppResult<ScreenRect> {
        let main_thread = MainThreadMarker::new()
            .ok_or_else(|| AppError::storage("Quick Entry requires the main thread"))?;
        let screens = NSScreen::screens(main_thread);
        let frames = screens
            .iter()
            .map(|screen| {
                let frame = screen.frame();
                screen_rect(
                    frame.origin.x,
                    frame.origin.y,
                    frame.size.width,
                    frame.size.height,
                )
            })
            .collect::<Vec<_>>();

        let selected = match target {
            Some(RestoreTarget::External(application)) => {
                focused_window_frame(application, &frames)
                    .and_then(|frame| screen_with_largest_intersection(frame, &frames))
            }
            Some(RestoreTarget::TodouMain) => app
                .get_webview_window("main")
                .and_then(|window| window.ns_window().ok())
                .and_then(|window| unsafe { (&*(window as *const NSWindow)).screen() })
                .and_then(|screen| {
                    let frame = screen.frame();
                    let frame = screen_rect(
                        frame.origin.x,
                        frame.origin.y,
                        frame.size.width,
                        frame.size.height,
                    );
                    frames.iter().position(|candidate| *candidate == frame)
                }),
            None => None,
        }
        .or_else(|| {
            let cursor = NSEvent::mouseLocation();
            frames.iter().position(|screen| {
                cursor.x >= screen.x
                    && cursor.x < screen.x + screen.width
                    && cursor.y >= screen.y
                    && cursor.y < screen.y + screen.height
            })
        })
        .unwrap_or(0);

        screens
            .iter()
            .nth(selected)
            .map(|screen| {
                let frame = screen.visibleFrame();
                screen_rect(
                    frame.origin.x,
                    frame.origin.y,
                    frame.size.width,
                    frame.size.height,
                )
            })
            .ok_or_else(|| AppError::storage("Quick Entry monitor is unavailable"))
    }

    fn focused_window_frame(
        application: &NSRunningApplication,
        screens: &[ScreenRect],
    ) -> Option<ScreenRect> {
        let primary_top = screens.first().map(|screen| screen.y + screen.height)?;
        let raw_windows = copy_window_info(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )?;
        let windows = unsafe {
            CFArray::<CFDictionary<CFString, CFType>>::wrap_under_get_rule(
                raw_windows.as_concrete_TypeRef(),
            )
        };
        let owner_pid_key = unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerPID) };
        let layer_key = unsafe { CFString::wrap_under_get_rule(kCGWindowLayer) };
        let bounds_key = unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) };

        windows.iter().find_map(|window| {
            let owner_pid = window
                .find(&owner_pid_key)?
                .downcast::<CFNumber>()?
                .to_i32()?;
            let layer = window.find(&layer_key)?.downcast::<CFNumber>()?.to_i32()?;
            if owner_pid != application.processIdentifier() || layer != 0 {
                return None;
            }
            let bounds = window.find(&bounds_key)?.downcast::<CFDictionary>()?;
            let bounds = CGRect::from_dict_representation(&bounds)?;
            (bounds.size.width > 0.0 && bounds.size.height > 0.0).then(|| {
                appkit_rect_from_quartz(
                    ScreenRect {
                        x: bounds.origin.x,
                        y: bounds.origin.y,
                        width: bounds.size.width,
                        height: bounds.size.height,
                    },
                    primary_top,
                )
            })
        })
    }

    fn screen_rect(x: f64, y: f64, width: f64, height: f64) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn restore_regular_activation_policy_if_needed(restore: bool) {
        let Some(main_thread) = MainThreadMarker::new().filter(|_| restore) else {
            return;
        };
        if !NSApplication::sharedApplication(main_thread)
            .setActivationPolicy(NSApplicationActivationPolicy::Regular)
        {
            tracing::warn!("could not restore the regular macOS activation policy");
        }
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
                if ["main", "quick-entry"].into_iter().any(|label| {
                    app_for_native
                        .get_webview_window(label)
                        .and_then(|window| window.is_focused().ok())
                        .unwrap_or(false)
                }) {
                    return;
                }
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

    pub fn prepare_quick_entry(app: &AppHandle, window: &WebviewWindow) -> AppResult<u64> {
        window.center().map_err(crate::error::AppError::storage)?;
        Ok(app
            .state::<TransientFocus>()
            .ledger
            .lock()
            .begin_quick_entry(None, false))
    }

    pub fn show_quick_entry(window: &WebviewWindow) -> AppResult<()> {
        window.show().map_err(crate::error::AppError::storage)?;
        window.set_focus().map_err(crate::error::AppError::storage)
    }

    pub fn dismiss_quick_entry(
        app: &AppHandle,
        window: &WebviewWindow,
        expected_generation: Option<u64>,
        _restore: bool,
    ) -> AppResult<bool> {
        let state = app.state::<TransientFocus>();
        let matches = state
            .ledger
            .lock()
            .quick_entry
            .as_ref()
            .is_some_and(|session| {
                expected_generation.is_none_or(|expected| expected == session.generation)
            });
        if !matches {
            return Ok(false);
        }
        window.hide().map_err(crate::error::AppError::storage)?;
        Ok(state
            .ledger
            .lock()
            .finish_quick_entry(expected_generation)
            .is_some())
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

pub fn show_quick_entry(window: &WebviewWindow) -> AppResult<()> {
    platform::show_quick_entry(window)
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
    use super::{
        appkit_rect_from_quartz, centered_origin, screen_with_largest_intersection, FocusLedger,
        RestoreTarget, ScreenRect,
    };

    #[test]
    fn focused_window_selects_the_screen_with_the_largest_overlap() {
        let screens = [
            ScreenRect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            ScreenRect {
                x: 1512.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        ];
        let focused_window = ScreenRect {
            x: 1400.0,
            y: 100.0,
            width: 1000.0,
            height: 700.0,
        };

        assert_eq!(
            screen_with_largest_intersection(focused_window, &screens),
            Some(1)
        );
    }

    #[test]
    fn quick_entry_centers_within_a_negative_coordinate_screen() {
        let screen = ScreenRect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1055.0,
        };
        let window = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 640.0,
            height: 230.0,
        };

        assert_eq!(centered_origin(screen, window), (-1280.0, 412.5));
    }

    #[test]
    fn quartz_window_bounds_are_converted_to_appkit_coordinates() {
        let quartz = ScreenRect {
            x: 80.0,
            y: 982.0,
            width: 800.0,
            height: 700.0,
        };

        assert_eq!(
            appkit_rect_from_quartz(quartz, 982.0),
            ScreenRect {
                x: 80.0,
                y: -700.0,
                width: 800.0,
                height: 700.0,
            }
        );
    }

    #[test]
    fn repeated_quick_entry_preserves_original_target_and_rejects_stale_close() {
        let mut ledger = FocusLedger::default();
        let first = ledger.begin_quick_entry(Some(RestoreTarget::External("Spotify")), true);
        let second = ledger.begin_quick_entry(None, false);

        assert_ne!(first, second);
        assert_eq!(ledger.finish_quick_entry(Some(first)), None);
        assert_eq!(
            ledger.finish_quick_entry(Some(second)),
            Some((Some(RestoreTarget::External("Spotify")), true))
        );
    }

    #[test]
    fn duplicate_quick_entry_close_is_idempotent() {
        let mut ledger = FocusLedger::<&str>::default();
        let generation = ledger.begin_quick_entry(Some(RestoreTarget::TodouMain), false);

        assert_eq!(
            ledger.finish_quick_entry(Some(generation)),
            Some((Some(RestoreTarget::TodouMain), false))
        );
        assert_eq!(ledger.finish_quick_entry(Some(generation)), None);
    }

    #[test]
    fn native_window_events_can_finish_the_current_quick_entry() {
        let mut ledger = FocusLedger::default();
        ledger.begin_quick_entry(Some(RestoreTarget::External("Spotify")), false);

        assert_eq!(
            ledger.finish_quick_entry(None),
            Some((Some(RestoreTarget::External("Spotify")), false))
        );
    }

    #[test]
    fn quick_entry_over_work_mode_can_restore_the_external_app() {
        let mut ledger = FocusLedger::default();
        ledger.begin_work_mode(Some("Spotify"));
        let target = ledger.work_mode_target.map(RestoreTarget::External);
        let generation = ledger.begin_quick_entry(target, false);

        assert_eq!(
            ledger.finish_quick_entry(Some(generation)),
            Some((Some(RestoreTarget::External("Spotify")), false))
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
