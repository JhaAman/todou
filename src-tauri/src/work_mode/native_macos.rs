use super::{
    clamp_geometry_to_work_area, default_work_window_geometry, persist_work_window_geometry,
    select_work_area_for_geometry, snap_geometry_to_corners, WorkArea, WorkWindowGeometry,
    WORK_WINDOW_HEIGHT_POINTS, WORK_WINDOW_MARGIN_POINTS, WORK_WINDOW_MAX_WIDTH_POINTS,
    WORK_WINDOW_MIN_WIDTH_POINTS, WORK_WINDOW_SNAP_THRESHOLD_POINTS,
};
use crate::error::{AppError, AppResult};
use objc2::{
    define_class, ffi, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObjectProtocol},
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSEvent, NSPanel, NSScreen, NSView, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use std::{
    cell::Cell,
    ptr,
    sync::{mpsc, OnceLock},
};
use tauri::{AppHandle, WebviewWindow};

const DRAG_REGION_TRAILING_INSET: f64 = 132.0;
const WORK_WINDOW_CORNER_RADIUS: f64 = 8.0;

static WORK_MODE_APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Default)]
struct WorkModePanelIvars;

define_class!(
    #[unsafe(super = NSPanel)]
    #[name = "TodouWorkModePanel"]
    #[thread_kind = MainThreadOnly]
    #[ivars = WorkModePanelIvars]
    struct WorkModePanel;

    unsafe impl NSObjectProtocol for WorkModePanel {}

    impl WorkModePanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            false
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool {
            false
        }

    }
);

struct WorkModeDragViewIvars {
    grab_offset_x: Cell<f64>,
    grab_offset_y: Cell<f64>,
}

define_class!(
    #[unsafe(super = NSView)]
    #[name = "TodouWorkModeDragView"]
    #[thread_kind = MainThreadOnly]
    #[ivars = WorkModeDragViewIvars]
    struct WorkModeDragView;

    unsafe impl NSObjectProtocol for WorkModeDragView {}

    impl WorkModeDragView {
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            let Some(window) = self.window() else {
                return;
            };
            let cursor = NSEvent::mouseLocation();
            let frame = window.frame();
            self.ivars()
                .grab_offset_x
                .set(cursor.x - frame.origin.x);
            self.ivars()
                .grab_offset_y
                .set(cursor.y - frame.origin.y);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, _event: &NSEvent) {
            let Some(window) = self.window() else {
                return;
            };
            let cursor = NSEvent::mouseLocation();
            let mut frame = window.frame();
            frame.origin.x = cursor.x - self.ivars().grab_offset_x.get();
            frame.origin.y = cursor.y - self.ivars().grab_offset_y.get();
            window.setFrameOrigin(frame.origin);
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {
            if let Some(window) = self.window() {
                finish_native_interaction(&window);
            }
        }

        #[unsafe(method(viewDidEndLiveResize))]
        fn view_did_end_live_resize(&self) {
            unsafe {
                let _: () = msg_send![super(self), viewDidEndLiveResize];
            }
            if let Some(window) = self.window() {
                finish_native_interaction(&window);
            }
        }
    }
);

impl WorkModeDragView {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(WorkModeDragViewIvars {
            grab_offset_x: Cell::new(0.0),
            grab_offset_y: Cell::new(0.0),
        });
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) fn configure_work_panel(
    app: &AppHandle,
    window: &WebviewWindow,
    persisted_geometry: Option<WorkWindowGeometry>,
) -> AppResult<()> {
    let _ = WORK_MODE_APP.set(app.clone());
    let native_window = window.ns_window().map_err(AppError::storage)? as usize;
    run_on_main(window, move || {
        let window = unsafe { &*(native_window as *const NSWindow) };
        let panel = convert_to_panel(window)?;
        configure_panel(panel, persisted_geometry)
    })
}

pub(super) fn capture_geometry(window: &WebviewWindow) -> AppResult<WorkWindowGeometry> {
    let native_window = window.ns_window().map_err(AppError::storage)? as usize;
    run_on_main(window, move || {
        let window = unsafe { &*(native_window as *const NSWindow) };
        Ok(geometry_from_window(window))
    })
}

pub(super) fn show_without_activation(window: &WebviewWindow) -> AppResult<()> {
    let native_window = window.ns_window().map_err(AppError::storage)? as usize;
    run_on_main(window, move || {
        let window = unsafe { &*(native_window as *const NSWindow) };
        window.orderFrontRegardless();
        Ok(())
    })
}

fn run_on_main<T, F>(window: &WebviewWindow, action: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    if MainThreadMarker::new().is_some() {
        return action();
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let _ = sender.send(action());
        })
        .map_err(AppError::storage)?;
    receiver
        .recv()
        .map_err(|_| AppError::storage("macOS window operation did not complete"))?
}

fn convert_to_panel(window: &NSWindow) -> AppResult<&WorkModePanel> {
    let object = unsafe { &*(window as *const NSWindow as *const AnyObject) };
    if ptr::eq(object.class(), WorkModePanel::class()) {
        return Ok(unsafe { &*(window as *const NSWindow as *const WorkModePanel) });
    }
    if WorkModePanel::class().instance_size() > object.class().instance_size() {
        return Err(AppError::storage(
            "native Work Mode panel is larger than Tauri's window allocation",
        ));
    }

    let old_class = object.class();
    // Reusing the native object preserves Tauri's webview and delegate while changing only Work Mode into an NSPanel.
    let replaced = unsafe {
        ffi::object_setClass(
            window as *const NSWindow as *mut AnyObject,
            WorkModePanel::class(),
        )
    };
    if !ptr::eq(replaced, old_class) {
        return Err(AppError::storage(
            "native Work Mode window class changed unexpectedly",
        ));
    }
    Ok(unsafe { &*(window as *const NSWindow as *const WorkModePanel) })
}

fn configure_panel(
    panel: &WorkModePanel,
    persisted_geometry: Option<WorkWindowGeometry>,
) -> AppResult<()> {
    let work_areas = screen_work_areas();
    let area_index = persisted_geometry
        .and_then(|geometry| select_work_area_for_geometry(geometry, &work_areas))
        .unwrap_or(0);
    let work_area = work_areas
        .get(area_index)
        .copied()
        .ok_or_else(|| AppError::storage("work-mode monitor is unavailable"))?;
    let height = WORK_WINDOW_HEIGHT_POINTS.min(work_area.height).max(1);
    let min_width = WORK_WINDOW_MIN_WIDTH_POINTS.min(work_area.width).max(1);
    let max_width = WORK_WINDOW_MAX_WIDTH_POINTS
        .min(work_area.width)
        .max(min_width);
    let geometry = persisted_geometry
        .map(|geometry| WorkWindowGeometry {
            width: geometry.width.clamp(min_width, max_width),
            height,
            ..geometry
        })
        .unwrap_or_else(|| default_work_window_geometry(work_area, min_width, max_width, height));
    let geometry = clamp_geometry_to_work_area(geometry, work_area);

    panel.setStyleMask(NSWindowStyleMask::Resizable | NSWindowStyleMask::NonactivatingPanel);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setFloatingPanel(true);
    panel.setHidesOnDeactivate(false);
    panel.setMovableByWindowBackground(false);
    panel.setAcceptsMouseMovedEvents(true);
    panel.setHasShadow(true);
    panel.setOpaque(false);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );

    let mut min_size = panel.frame().size;
    min_size.width = f64::from(min_width);
    min_size.height = f64::from(height);
    panel.setMinSize(min_size);
    let mut max_size = min_size;
    max_size.width = f64::from(max_width);
    panel.setMaxSize(max_size);
    apply_geometry(panel, geometry);

    if panel.contentView().is_some_and(|view| {
        !view
            .subviews()
            .iter()
            .any(|view| view.isKindOfClass(WorkModeDragView::class()))
    }) {
        install_drag_view(panel)?;
    }
    apply_corner_radius(panel);
    Ok(())
}

fn install_drag_view(panel: &WorkModePanel) -> AppResult<()> {
    let content = panel
        .contentView()
        .ok_or_else(|| AppError::storage("work-mode content view is unavailable"))?;
    let mut frame = content.bounds();
    frame.size.width = (frame.size.width - DRAG_REGION_TRAILING_INSET).max(1.0);
    let drag_view = WorkModeDragView::new(
        MainThreadMarker::new()
            .ok_or_else(|| AppError::storage("work-mode drag view requires the main thread"))?,
    );
    drag_view.setFrame(frame);
    drag_view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content.addSubview(&drag_view);
    Ok(())
}

fn apply_corner_radius(panel: &WorkModePanel) {
    let Some(content) = panel.contentView() else {
        return;
    };
    content.setWantsLayer(true);
    unsafe {
        let layer: *mut AnyObject = msg_send![&*content, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: WORK_WINDOW_CORNER_RADIUS];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }
    }
}

fn finish_native_interaction(window: &NSWindow) {
    let work_areas = screen_work_areas();
    let geometry = geometry_from_window(window);
    let snapped = snap_geometry_to_corners(
        geometry,
        &work_areas,
        WORK_WINDOW_MARGIN_POINTS,
        WORK_WINDOW_SNAP_THRESHOLD_POINTS,
    );
    if snapped != geometry {
        apply_geometry(window, snapped);
    }
    if let Some(app) = WORK_MODE_APP.get() {
        if let Err(error) = persist_work_window_geometry(app, snapped) {
            tracing::warn!(%error, "could not persist native work-mode geometry");
        }
    }
}

fn screen_work_areas() -> Vec<WorkArea> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Vec::new();
    };
    NSScreen::screens(mtm)
        .iter()
        .map(|screen| {
            let frame = screen.visibleFrame();
            WorkArea {
                x: rounded_i32(frame.origin.x),
                y: rounded_i32(frame.origin.y),
                width: rounded_u32(frame.size.width),
                height: rounded_u32(frame.size.height),
            }
        })
        .collect()
}

fn geometry_from_window(window: &NSWindow) -> WorkWindowGeometry {
    let frame = window.frame();
    WorkWindowGeometry {
        x: rounded_i32(frame.origin.x),
        y: rounded_i32(frame.origin.y),
        width: rounded_u32(frame.size.width),
        height: rounded_u32(frame.size.height),
    }
}

fn apply_geometry(window: &NSWindow, geometry: WorkWindowGeometry) {
    let mut frame = window.frame();
    frame.origin.x = f64::from(geometry.x);
    frame.origin.y = f64::from(geometry.y);
    frame.size.width = f64::from(geometry.width);
    frame.size.height = f64::from(geometry.height);
    window.setFrame_display(frame, true);
}

fn rounded_i32(value: f64) -> i32 {
    value
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn rounded_u32(value: f64) -> u32 {
    value.round().clamp(1.0, f64::from(u32::MAX)) as u32
}
