use crate::{
    domain::{Bucket, TaskFilter},
    error::{AppError, AppResult},
    service::TaskService,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[cfg(target_os = "macos")]
mod native_macos;

const WORK_MODE_METADATA_KEY: &str = "work_mode_state_v2";
const WORK_MODE_EVENT: &str = "todou://work-mode-active-changed";
const WORK_WINDOW_GEOMETRY_VERSION: u32 = 1;
const WORK_WINDOW_HEIGHT_POINTS: u32 = 72;
const WORK_WINDOW_MIN_WIDTH_POINTS: u32 = 320;
const WORK_WINDOW_DEFAULT_WIDTH_POINTS: u32 = 500;
const WORK_WINDOW_MAX_WIDTH_POINTS: u32 = 720;
const WORK_WINDOW_MARGIN_POINTS: u32 = 12;
const WORK_WINDOW_SNAP_THRESHOLD_POINTS: u32 = 24;

static WORK_MODE_STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkWindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWorkModeState {
    #[serde(default)]
    active: bool,
    #[serde(default, rename = "session", skip_serializing)]
    legacy_session: Option<serde_json::Value>,
    #[serde(default)]
    geometry: Option<WorkWindowGeometry>,
    #[serde(default)]
    geometry_version: u32,
}

#[tauri::command]
pub fn start_work_mode(app: AppHandle, service: State<'_, TaskService>) -> AppResult<()> {
    if !has_in_progress_task(service.inner())? {
        return Err(AppError::invalid_input("Move a task to In Progress first"));
    }
    let _guard = WORK_MODE_STATE_LOCK.lock();
    let previous = match read_persisted_state(service.inner()) {
        Ok(state) => state,
        Err(error) => {
            tracing::warn!(%error, "discarding corrupt work-mode metadata while starting");
            PersistedWorkModeState::default()
        }
    };
    let mut next = previous.clone();
    next.active = true;

    configure_work_window(&app, next.geometry)?;
    write_persisted_state(service.inner(), &next)?;
    if let Err(error) = enter_work_mode(&app) {
        let _ = write_persisted_state(service.inner(), &previous);
        let _ = emit_active(&app, false);
        let _ = leave_work_mode(&app);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn stop_work_mode(app: AppHandle, service: State<'_, TaskService>) -> AppResult<()> {
    {
        let _guard = WORK_MODE_STATE_LOCK.lock();
        let mut state = match read_persisted_state(service.inner()) {
            Ok(state) => state,
            Err(error) => {
                tracing::warn!(%error, "discarding corrupt work-mode metadata while stopping");
                PersistedWorkModeState::default()
            }
        };
        if let Ok(geometry) = capture_work_window_geometry(&app) {
            state.geometry = Some(geometry);
        }
        state.active = false;
        write_persisted_state(service.inner(), &state)?;
    }
    let notification_result = emit_active(&app, false);
    let window_result = leave_work_mode(&app);
    notification_result.and(window_result)
}

#[tauri::command]
pub fn load_work_mode_active(service: State<'_, TaskService>) -> AppResult<bool> {
    let _guard = WORK_MODE_STATE_LOCK.lock();
    Ok(read_persisted_state(service.inner())?.active)
}

pub fn restore_active_work_mode(app: &AppHandle, service: &TaskService) -> AppResult<bool> {
    let _guard = WORK_MODE_STATE_LOCK.lock();
    let mut state = read_persisted_state(service)?;
    if !state.active {
        return Ok(false);
    }

    if !has_in_progress_task(service)? {
        state.active = false;
        write_persisted_state(service, &state)?;
        emit_active(app, false)?;
        return Ok(false);
    }

    let restore_result = configure_work_window(app, state.geometry)
        .and_then(|_| write_persisted_state(service, &state))
        .and_then(|_| enter_work_mode(app));
    if let Err(error) = restore_result {
        state.active = false;
        if let Err(cleanup_error) = write_persisted_state(service, &state) {
            tracing::warn!(%cleanup_error, "could not clear a failed work-mode restore");
        }
        let _ = emit_active(app, false);
        let _ = leave_work_mode(app);
        return Err(error);
    }
    Ok(true)
}

pub fn show_active_work_mode(app: &AppHandle, service: &TaskService) -> AppResult<bool> {
    let _guard = WORK_MODE_STATE_LOCK.lock();
    let state = read_persisted_state(service)?;
    if !state.active {
        return Ok(false);
    }
    configure_work_window(app, state.geometry)?;
    reveal_work_mode(app)?;
    Ok(true)
}

pub(crate) fn should_intercept_quit(app: &AppHandle, service: &TaskService) -> bool {
    let persisted_active = {
        let _guard = WORK_MODE_STATE_LOCK.lock();
        read_persisted_state(service).is_ok_and(|state| state.active)
    };
    persisted_active
        || app
            .get_webview_window("work-mode")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
}

pub(crate) fn deactivate_after_interaction(app: &AppHandle) -> AppResult<()> {
    for label in ["main", "quick-entry"] {
        if let Some(window) = app.get_webview_window(label) {
            if window.is_focused().map_err(AppError::storage)? {
                return Ok(());
            }
        }
    }
    deactivate_todou(app)
}

fn clamp_geometry_to_work_area(
    geometry: WorkWindowGeometry,
    work_area: WorkArea,
) -> WorkWindowGeometry {
    let max_width = work_area.width.max(1);
    let max_height = work_area.height.max(1);
    let width = geometry.width.clamp(1, max_width);
    let height = geometry.height.clamp(1, max_height);
    let min_x = i64::from(work_area.x);
    let min_y = i64::from(work_area.y);
    let max_x = min_x + i64::from(max_width - width);
    let max_y = min_y + i64::from(max_height - height);
    WorkWindowGeometry {
        x: clamp_i64(i64::from(geometry.x), min_x, max_x),
        y: clamp_i64(i64::from(geometry.y), min_y, max_y),
        width,
        height,
    }
}

fn snap_geometry_to_corners(
    geometry: WorkWindowGeometry,
    work_areas: &[WorkArea],
    margin: u32,
    threshold: u32,
) -> WorkWindowGeometry {
    if let Some(snapped) = nearest_corner_geometry(geometry, work_areas, margin, threshold) {
        return snapped;
    }

    select_work_area_for_geometry(geometry, work_areas)
        .map(|index| clamp_geometry_to_work_area(geometry, work_areas[index]))
        .unwrap_or(geometry)
}

fn select_work_area_for_geometry(
    geometry: WorkWindowGeometry,
    work_areas: &[WorkArea],
) -> Option<usize> {
    let mut selected = work_areas.first().map(|_| 0);
    let mut largest_overlap = 0_u64;
    let mut nearest_distance = u128::MAX;
    for (index, work_area) in work_areas.iter().copied().enumerate() {
        let overlap = intersection_area(geometry, work_area);
        let distance = center_distance_squared(geometry, work_area);
        if overlap > largest_overlap || (overlap == largest_overlap && distance < nearest_distance)
        {
            selected = Some(index);
            largest_overlap = overlap;
            nearest_distance = distance;
        }
    }
    selected
}

fn nearest_corner_geometry(
    geometry: WorkWindowGeometry,
    work_areas: &[WorkArea],
    margin: u32,
    threshold: u32,
) -> Option<WorkWindowGeometry> {
    let mut best: Option<(u128, usize, usize, WorkWindowGeometry)> = None;
    for (area_index, work_area) in work_areas.iter().copied().enumerate() {
        let fitted = WorkWindowGeometry {
            width: geometry.width.clamp(1, work_area.width.max(1)),
            height: geometry.height.clamp(1, work_area.height.max(1)),
            ..geometry
        };
        let margin_x = margin.min(work_area.width.saturating_sub(fitted.width) / 2);
        let margin_y = margin.min(work_area.height.saturating_sub(fitted.height) / 2);
        let left = i64::from(work_area.x) + i64::from(margin_x);
        let right = i64::from(work_area.x) + i64::from(work_area.width)
            - i64::from(fitted.width)
            - i64::from(margin_x);
        let lower = i64::from(work_area.y) + i64::from(margin_y);
        let upper = i64::from(work_area.y) + i64::from(work_area.height)
            - i64::from(fitted.height)
            - i64::from(margin_y);

        for (corner_index, (x, y)) in [(left, lower), (right, lower), (left, upper), (right, upper)]
            .into_iter()
            .enumerate()
        {
            let dx = i64::from(geometry.x).abs_diff(x);
            let dy = i64::from(geometry.y).abs_diff(y);
            if dx > u64::from(threshold) || dy > u64::from(threshold) {
                continue;
            }
            let distance = u128::from(dx) * u128::from(dx) + u128::from(dy) * u128::from(dy);
            let candidate = WorkWindowGeometry {
                x: saturating_i32(x),
                y: saturating_i32(y),
                ..fitted
            };
            let key = (distance, area_index, corner_index);
            if best
                .as_ref()
                .is_none_or(|current| key < (current.0, current.1, current.2))
            {
                best = Some((distance, area_index, corner_index, candidate));
            }
        }
    }
    best.map(|(_, _, _, geometry)| geometry)
}

fn center_distance_squared(geometry: WorkWindowGeometry, work_area: WorkArea) -> u128 {
    let center_x = i128::from(geometry.x) * 2 + i128::from(geometry.width);
    let center_y = i128::from(geometry.y) * 2 + i128::from(geometry.height);
    let min_x = i128::from(work_area.x) * 2;
    let min_y = i128::from(work_area.y) * 2;
    let max_x = min_x + i128::from(work_area.width) * 2;
    let max_y = min_y + i128::from(work_area.height) * 2;
    let dx = distance_to_interval(center_x, min_x, max_x);
    let dy = distance_to_interval(center_y, min_y, max_y);
    dx * dx + dy * dy
}

fn distance_to_interval(value: i128, min: i128, max: i128) -> u128 {
    if value < min {
        (min - value) as u128
    } else if value > max {
        (value - max) as u128
    } else {
        0
    }
}

fn has_in_progress_task(service: &TaskService) -> AppResult<bool> {
    Ok(!service
        .list_tasks(TaskFilter {
            bucket: Some(Bucket::InProgress),
            completed: Some(false),
            ..TaskFilter::default()
        })?
        .result
        .is_empty())
}

fn read_persisted_state(service: &TaskService) -> AppResult<PersistedWorkModeState> {
    service
        .get_local_metadata_value(WORK_MODE_METADATA_KEY)?
        .map(|value| {
            serde_json::from_value(value)
                .map_err(|_| AppError::storage("work-mode metadata is corrupt"))
        })
        .transpose()
        .map(Option::unwrap_or_default)
        .map(normalize_persisted_state)
}

fn write_persisted_state(service: &TaskService, state: &PersistedWorkModeState) -> AppResult<()> {
    if !state.active && state.geometry.is_none() {
        return service.set_local_metadata_value(WORK_MODE_METADATA_KEY, None);
    }
    let mut state = state.clone();
    state.geometry_version = WORK_WINDOW_GEOMETRY_VERSION;
    service.set_local_metadata_value(
        WORK_MODE_METADATA_KEY,
        Some(serde_json::to_value(&state).map_err(AppError::from)?),
    )
}

fn normalize_persisted_state(mut state: PersistedWorkModeState) -> PersistedWorkModeState {
    if state.legacy_session.take().is_some() {
        state.active = true;
    }
    if state.geometry_version != WORK_WINDOW_GEOMETRY_VERSION {
        state.geometry = None;
        state.geometry_version = WORK_WINDOW_GEOMETRY_VERSION;
    }
    state
}

pub(super) fn persist_work_window_geometry(
    app: &AppHandle,
    geometry: WorkWindowGeometry,
) -> AppResult<()> {
    let _guard = WORK_MODE_STATE_LOCK.lock();
    let service = app.state::<TaskService>();
    let mut state = read_persisted_state(service.inner())?;
    state.geometry = Some(geometry);
    write_persisted_state(service.inner(), &state)
}

#[cfg(target_os = "macos")]
fn configure_work_window(
    app: &AppHandle,
    persisted_geometry: Option<WorkWindowGeometry>,
) -> AppResult<()> {
    let window = work_window(app)?;
    native_macos::configure_work_panel(app, &window, persisted_geometry)
}

#[cfg(not(target_os = "macos"))]
fn configure_work_window(
    app: &AppHandle,
    persisted_geometry: Option<WorkWindowGeometry>,
) -> AppResult<()> {
    use tauri::{LogicalPosition, LogicalSize};

    let window = work_window(app)?;
    let primary_monitor = window.primary_monitor().map_err(AppError::storage)?;
    let available_monitors = window.available_monitors().map_err(AppError::storage)?;
    let work_areas = available_monitors
        .iter()
        .map(|monitor| {
            let scale_factor = monitor.scale_factor();
            let position = monitor.work_area().position.to_logical::<i32>(scale_factor);
            let size = monitor.work_area().size.to_logical::<u32>(scale_factor);
            WorkArea {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect::<Vec<_>>();
    let restored_monitor = persisted_geometry
        .and_then(|geometry| select_work_area_for_geometry(geometry, &work_areas))
        .and_then(|index| available_monitors.get(index))
        .cloned();
    let monitor = restored_monitor
        .or(primary_monitor)
        .or_else(|| available_monitors.first().cloned())
        .ok_or_else(|| AppError::storage("work-mode monitor is unavailable"))?;
    let scale_factor = monitor.scale_factor();
    let position = monitor.work_area().position.to_logical::<i32>(scale_factor);
    let size = monitor.work_area().size.to_logical::<u32>(scale_factor);
    let work_area = WorkArea {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let height = WORK_WINDOW_HEIGHT_POINTS.min(work_area.height);
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

    window.set_focusable(false).map_err(AppError::storage)?;
    window.set_resizable(true).map_err(AppError::storage)?;
    window.set_always_on_top(true).map_err(AppError::storage)?;
    window
        .set_visible_on_all_workspaces(true)
        .map_err(AppError::storage)?;
    window
        .set_min_size(Some(LogicalSize::new(
            f64::from(min_width),
            f64::from(height),
        )))
        .map_err(AppError::storage)?;
    window
        .set_max_size(Some(LogicalSize::new(
            f64::from(max_width),
            f64::from(height),
        )))
        .map_err(AppError::storage)?;
    window
        .set_size(LogicalSize::new(
            f64::from(geometry.width),
            f64::from(geometry.height),
        ))
        .map_err(AppError::storage)?;
    window
        .set_position(LogicalPosition::new(
            f64::from(geometry.x),
            f64::from(geometry.y),
        ))
        .map_err(AppError::storage)?;

    if persisted_geometry.is_none() {
        let geometry = snap_geometry_to_corners(
            geometry,
            &[work_area],
            WORK_WINDOW_MARGIN_POINTS,
            WORK_WINDOW_SNAP_THRESHOLD_POINTS,
        );
        window
            .set_position(LogicalPosition::new(
                f64::from(geometry.x),
                f64::from(geometry.y),
            ))
            .map_err(AppError::storage)?;
    }
    Ok(())
}

fn default_work_window_geometry(
    work_area: WorkArea,
    min_width: u32,
    max_width: u32,
    height: u32,
) -> WorkWindowGeometry {
    let width = WORK_WINDOW_DEFAULT_WIDTH_POINTS.clamp(min_width, max_width);
    let margin = WORK_WINDOW_MARGIN_POINTS;
    let x = i64::from(work_area.x) + i64::from(work_area.width)
        - i64::from(width)
        - i64::from(margin.min(work_area.width.saturating_sub(width)));
    let y = i64::from(work_area.y) + i64::from(margin.min(work_area.height.saturating_sub(height)));
    WorkWindowGeometry {
        x: saturating_i32(x),
        y: saturating_i32(y),
        width,
        height,
    }
}

fn enter_work_mode(app: &AppHandle) -> AppResult<()> {
    emit_active(app, true)?;
    reveal_work_mode(app)
}

fn emit_active(app: &AppHandle, active: bool) -> AppResult<()> {
    work_window(app)?
        .emit(WORK_MODE_EVENT, active)
        .map_err(AppError::storage)
}

fn reveal_work_mode(app: &AppHandle) -> AppResult<()> {
    let work = work_window(app)?;
    let main = main_window(app)?;
    show_work_window(&work)?;
    if let Err(error) = main.hide().map_err(AppError::storage) {
        let _ = work.hide();
        return Err(error);
    }
    deactivate_todou(app)
}

#[cfg(target_os = "macos")]
fn show_work_window(window: &WebviewWindow) -> AppResult<()> {
    native_macos::show_without_activation(window)
}

#[cfg(not(target_os = "macos"))]
fn show_work_window(window: &WebviewWindow) -> AppResult<()> {
    window.show().map_err(AppError::storage)
}

fn leave_work_mode(app: &AppHandle) -> AppResult<()> {
    let hide_result = work_window(app).and_then(|window| window.hide().map_err(AppError::storage));
    let main = main_window(app);
    let show_result = main
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|window| window.show().map_err(AppError::storage));
    let unminimize_result = main
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|window| window.unminimize().map_err(AppError::storage));
    let focus_result = main
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|window| window.set_focus().map_err(AppError::storage));
    hide_result
        .and(show_result)
        .and(unminimize_result)
        .and(focus_result)
}

fn capture_work_window_geometry(app: &AppHandle) -> AppResult<WorkWindowGeometry> {
    capture_geometry(&work_window(app)?)
}

#[cfg(target_os = "macos")]
fn capture_geometry(window: &WebviewWindow) -> AppResult<WorkWindowGeometry> {
    native_macos::capture_geometry(window)
}

#[cfg(not(target_os = "macos"))]
fn capture_geometry(window: &WebviewWindow) -> AppResult<WorkWindowGeometry> {
    let scale_factor = window.scale_factor().map_err(AppError::storage)?;
    let position = window
        .outer_position()
        .map_err(AppError::storage)?
        .to_logical::<i32>(scale_factor);
    let size = window
        .outer_size()
        .map_err(AppError::storage)?
        .to_logical::<u32>(scale_factor);
    Ok(WorkWindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn work_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    app.get_webview_window("work-mode")
        .ok_or_else(|| AppError::storage("work-mode window is unavailable"))
}

fn main_window(app: &AppHandle) -> AppResult<WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| AppError::storage("main window is unavailable"))
}

fn intersection_area(geometry: WorkWindowGeometry, work_area: WorkArea) -> u64 {
    let left = i64::from(geometry.x).max(i64::from(work_area.x));
    let top = i64::from(geometry.y).max(i64::from(work_area.y));
    let right = (i64::from(geometry.x) + i64::from(geometry.width))
        .min(i64::from(work_area.x) + i64::from(work_area.width));
    let bottom = (i64::from(geometry.y) + i64::from(geometry.height))
        .min(i64::from(work_area.y) + i64::from(work_area.height));
    u64::try_from((right - left).max(0)).unwrap_or_default()
        * u64::try_from((bottom - top).max(0)).unwrap_or_default()
}

fn clamp_i64(value: i64, min: i64, max: i64) -> i32 {
    saturating_i32(value.clamp(min, max))
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

#[cfg(target_os = "macos")]
fn deactivate_todou(app: &AppHandle) -> AppResult<()> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    app.run_on_main_thread(|| {
        if let Some(main_thread) = MainThreadMarker::new() {
            NSApplication::sharedApplication(main_thread).deactivate();
        }
    })
    .map_err(AppError::storage)
}

#[cfg(not(target_os = "macos"))]
fn deactivate_todou(_app: &AppHandle) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_geometry_to_work_area, has_in_progress_task, normalize_persisted_state,
        select_work_area_for_geometry, snap_geometry_to_corners, PersistedWorkModeState, WorkArea,
        WorkWindowGeometry, WORK_WINDOW_GEOMETRY_VERSION,
    };
    use crate::{
        domain::{Area, Bucket, CreateTaskInput, Priority},
        hlc::ClockSource,
        service::TaskService,
    };
    use chrono::NaiveDate;
    use std::sync::Arc;

    struct FixedClock;

    impl ClockSource for FixedClock {
        fn now_millis(&self) -> i64 {
            1_785_240_000_000
        }

        fn local_date(&self) -> NaiveDate {
            NaiveDate::from_ymd_opt(2026, 7, 28).unwrap()
        }
    }

    fn service() -> TaskService {
        TaskService::in_memory_with_clock(Arc::new(FixedClock)).unwrap()
    }

    fn task_input(
        title: &str,
        bucket: Bucket,
        priority: Priority,
        estimate_minutes: Option<u16>,
    ) -> CreateTaskInput {
        CreateTaskInput {
            id: None,
            title: title.into(),
            bucket,
            priority,
            area: Area::Work,
            due_date: None,
            estimate_minutes,
        }
    }

    fn work_area(x: i32, y: i32, width: u32, height: u32) -> WorkArea {
        WorkArea {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn clamps_the_entire_window_to_a_negative_origin_work_area() {
        let geometry = WorkWindowGeometry {
            x: 600,
            y: -500,
            width: 3_000,
            height: 2_000,
        };

        let clamped = clamp_geometry_to_work_area(geometry, work_area(-1_920, 23, 1_920, 1_057));

        assert_eq!(
            clamped,
            WorkWindowGeometry {
                x: -1_920,
                y: 23,
                width: 1_920,
                height: 1_057,
            }
        );
    }

    #[test]
    fn snaps_all_four_corners_using_usable_frame_offsets() {
        let area = work_area(0, 0, 1_000, 800);
        for ((x, y), (expected_x, expected_y)) in [
            ((8, 9), (10, 10)),
            ((887, 7), (890, 10)),
            ((11, 688), (10, 690)),
            ((885, 687), (890, 690)),
        ] {
            assert_eq!(
                snap_geometry_to_corners(
                    WorkWindowGeometry {
                        x,
                        y,
                        width: 100,
                        height: 100,
                    },
                    &[area],
                    10,
                    20,
                ),
                WorkWindowGeometry {
                    x: expected_x,
                    y: expected_y,
                    width: 100,
                    height: 100,
                }
            );
        }
    }

    #[test]
    fn does_not_create_a_corner_snap_by_clamping_first() {
        let area = work_area(0, 23, 1_000, 777);
        let near_right_edge_only = WorkWindowGeometry {
            x: 885,
            y: 350,
            width: 100,
            height: 100,
        };

        assert_eq!(
            snap_geometry_to_corners(near_right_edge_only, &[area], 10, 20),
            near_right_edge_only
        );
    }

    #[test]
    fn chooses_the_nearest_corner_across_offset_monitors() {
        let areas = [
            work_area(-1_920, 23, 1_920, 1_057),
            work_area(0, -900, 1_440, 900),
        ];
        let geometry = WorkWindowGeometry {
            x: 925,
            y: -82,
            width: 500,
            height: 72,
        };

        assert_eq!(
            snap_geometry_to_corners(geometry, &areas, 12, 24),
            WorkWindowGeometry {
                x: 928,
                y: -84,
                ..geometry
            }
        );
    }

    #[test]
    fn restores_to_the_monitor_with_the_largest_window_overlap() {
        let areas = [
            work_area(0, 0, 1_920, 1_057),
            work_area(-1_920, 0, 1_920, 1_080),
        ];
        let geometry = WorkWindowGeometry {
            x: -1_850,
            y: 900,
            width: 640,
            height: 96,
        };

        assert_eq!(select_work_area_for_geometry(geometry, &areas), Some(1));
    }

    #[test]
    fn restores_to_the_nearest_monitor_when_none_overlap() {
        let areas = [
            work_area(0, 0, 1_920, 1_057),
            work_area(-1_920, 0, 1_920, 1_080),
        ];

        assert_eq!(
            select_work_area_for_geometry(
                WorkWindowGeometry {
                    x: 4_000,
                    y: 900,
                    width: 640,
                    height: 96,
                },
                &areas
            ),
            Some(0)
        );
    }

    #[test]
    fn drops_only_legacy_geometry_coordinates() {
        let state = normalize_persisted_state(PersistedWorkModeState {
            active: true,
            legacy_session: None,
            geometry: Some(WorkWindowGeometry {
                x: 10,
                y: 20,
                width: 640,
                height: 96,
            }),
            geometry_version: 0,
        });

        assert!(state.active);
        assert_eq!(state.geometry, None);
        assert_eq!(state.geometry_version, WORK_WINDOW_GEOMETRY_VERSION);
    }

    #[test]
    fn restores_legacy_session_as_active() {
        let state: PersistedWorkModeState = serde_json::from_value(serde_json::json!({
            "session": { "taskId": "task-1" },
            "geometryVersion": WORK_WINDOW_GEOMETRY_VERSION,
        }))
        .unwrap();

        assert!(normalize_persisted_state(state).active);
    }

    #[test]
    fn detects_only_active_in_progress_tasks() {
        let service = service();
        assert!(!has_in_progress_task(&service).unwrap());

        service
            .create_task(task_input(
                "Not in progress",
                Bucket::Today,
                Priority::High,
                Some(10),
            ))
            .unwrap();
        assert!(!has_in_progress_task(&service).unwrap());

        service
            .create_task(task_input(
                "In progress",
                Bucket::InProgress,
                Priority::High,
                Some(20),
            ))
            .unwrap();
        assert!(has_in_progress_task(&service).unwrap());
    }
}
