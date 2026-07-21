use crate::{
    error::{AppError, AppResult, ErrorCode},
    protocol::{dispatch, is_mutating_method, LocalRequest, LocalResponse},
    service::TaskService,
    sync::SyncWake,
};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{unix::OwnedReadHalf, UnixListener, UnixStream},
};

const MAX_FRAME_BYTES: usize = 1024 * 1024;

pub async fn serve(
    path: PathBuf,
    service: TaskService,
    wake: SyncWake,
    app: AppHandle,
) -> AppResult<()> {
    let listener = bind(&path).await?;
    tracing::info!(path = %path.display(), "local task socket listening");
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let service = service.clone();
                let wake = wake.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = handle_connection(stream, service, wake, app).await {
                        tracing::warn!(%error, "local task socket connection failed");
                    }
                });
            }
            Err(error) => {
                tracing::error!(%error, "local task socket accept failed");
            }
        }
    }
}

async fn bind(path: &PathBuf) -> AppResult<UnixListener> {
    if path.exists() {
        match UnixStream::connect(path).await {
            Ok(_) => {
                return Err(AppError::new(
                    ErrorCode::TodouUnavailable,
                    "another Todou task service is already using the local socket",
                ))
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) =>
            {
                fs::remove_file(path)?;
            }
            Err(error) => return Err(AppError::storage(error)),
        }
    }
    let listener = UnixListener::bind(path).map_err(AppError::from)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(listener)
}

async fn handle_connection(
    stream: UnixStream,
    service: TaskService,
    wake: SyncWake,
    app: AppHandle,
) -> AppResult<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    while let Some(line) = read_frame(&mut reader).await? {
        let response = match serde_json::from_str::<LocalRequest>(&line) {
            Ok(request) => {
                let mutating = is_mutating_method(&request.method);
                let service = service.clone();
                let response =
                    tauri::async_runtime::spawn_blocking(move || dispatch(&service, request))
                        .await
                        .unwrap_or_else(|error| {
                            LocalResponse::failure(
                                String::new(),
                                AppError::storage(format!("local request worker failed: {error}")),
                            )
                        });
                if mutating {
                    if let Some(revision) = response.revision() {
                        wake.wake();
                        let _ = app.emit("todou://tasks-changed", revision);
                    }
                }
                response
            }
            Err(error) => LocalResponse::failure(
                String::new(),
                AppError::invalid_input(format!("Invalid JSON-line request: {error}")),
            ),
        };
        let mut encoded = serde_json::to_vec(&response).map_err(AppError::storage)?;
        encoded.push(b'\n');
        writer
            .write_all(&encoded)
            .await
            .map_err(AppError::storage)?;
        writer.flush().await.map_err(AppError::storage)?;
    }
    Ok(())
}

async fn read_frame(reader: &mut BufReader<OwnedReadHalf>) -> AppResult<Option<String>> {
    let mut bytes = Vec::new();
    let mut limited = reader.take((MAX_FRAME_BYTES + 1) as u64);
    let read = limited
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(AppError::storage)?;
    if read == 0 {
        return Ok(None);
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(AppError::invalid_input("JSON-line request exceeds 1 MiB"));
    }
    if bytes.last() != Some(&b'\n') {
        return Err(AppError::invalid_input(
            "JSON-line request must end with a newline",
        ));
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| AppError::invalid_input("JSON-line request must be UTF-8"))
}
