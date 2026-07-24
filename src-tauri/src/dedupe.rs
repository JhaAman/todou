use crate::{
    domain::NullablePatch,
    error::{AppError, AppResult},
    llm::{
        DedupeDecision, DedupeRequest, FailureCategory, LlmClient, LlmTask, Provider,
        ProviderCredentials,
    },
    service::{DedupeContext, LlmCredentialStatus, TaskService},
};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use std::{collections::HashSet, sync::Arc};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

const CANDIDATES_PER_REQUEST: usize = 250;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLlmSettingsInput {
    #[serde(skip_serializing_if = "NullablePatch::is_missing")]
    pub openai_api_key: NullablePatch<String>,
    #[serde(skip_serializing_if = "NullablePatch::is_missing")]
    pub anthropic_api_key: NullablePatch<String>,
}

impl<'de> Deserialize<'de> for SaveLlmSettingsInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct RawInput {
            #[serde(default, deserialize_with = "deserialize_nullable_patch")]
            openai_api_key: NullablePatch<String>,
            #[serde(default, deserialize_with = "deserialize_nullable_patch")]
            anthropic_api_key: NullablePatch<String>,
        }

        let raw = RawInput::deserialize(deserializer)?;
        Ok(Self {
            openai_api_key: raw.openai_api_key,
            anthropic_api_key: raw.anthropic_api_key,
        })
    }
}

fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<NullablePatch<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(match Option::<T>::deserialize(deserializer)? {
        Some(value) => NullablePatch::Value(value),
        None => NullablePatch::Null,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettingsStatus {
    pub openai: LlmCredentialStatus,
    pub anthropic: LlmCredentialStatus,
    pub pending_jobs: u64,
    pub failed_jobs: u64,
}

#[derive(Clone)]
pub struct DedupeCoordinator {
    client: LlmClient,
    drain_lock: Arc<Mutex<()>>,
}

impl DedupeCoordinator {
    pub fn new() -> AppResult<Self> {
        let client = LlmClient::new()
            .map_err(|_| AppError::storage("could not initialize the AI provider client"))?;
        Ok(Self {
            client,
            drain_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn schedule(&self, app: AppHandle, service: TaskService) {
        let coordinator = self.clone();
        tauri::async_runtime::spawn(async move {
            coordinator.drain(app, service).await;
        });
    }

    pub fn settings_status(&self, service: &TaskService) -> AppResult<LlmSettingsStatus> {
        let credentials = service.llm_credential_status()?;
        let counts = service.dedupe_counts()?;
        Ok(LlmSettingsStatus {
            openai: credentials.openai,
            anthropic: credentials.anthropic,
            pending_jobs: counts.pending,
            failed_jobs: counts.failed,
        })
    }

    pub async fn save_settings(
        &self,
        service: &TaskService,
        input: SaveLlmSettingsInput,
    ) -> AppResult<LlmSettingsStatus> {
        let current = service.llm_credentials()?;
        let openai = normalize_key_patch(input.openai_api_key)?;
        let anthropic = normalize_key_patch(input.anthropic_api_key)?;

        if let Some(Some(key)) = &openai {
            self.client
                .validate_key(Provider::OpenAi, key)
                .await
                .map_err(|_| AppError::invalid_input("The OpenAI API key could not be verified"))?;
        }
        if let Some(Some(key)) = &anthropic {
            self.client
                .validate_key(Provider::Anthropic, key)
                .await
                .map_err(|_| {
                    AppError::invalid_input("The Anthropic API key could not be verified")
                })?;
        }

        let has_openai = resulting_key_exists(&openai, current.openai.is_some(), "OPENAI_API_KEY");
        let has_anthropic =
            resulting_key_exists(&anthropic, current.anthropic.is_some(), "ANTHROPIC_API_KEY");
        if !has_openai && !has_anthropic {
            return Err(AppError::invalid_input(
                "Keep at least one OpenAI or Anthropic API key configured",
            ));
        }

        if let Some(value) = openai.as_ref() {
            service.set_llm_api_key(Provider::OpenAi, value.as_deref())?;
        }
        if let Some(value) = anthropic.as_ref() {
            service.set_llm_api_key(Provider::Anthropic, value.as_deref())?;
        }
        service.retry_failed_dedupe_jobs()?;
        self.settings_status(service)
    }

    async fn drain(&self, app: AppHandle, service: TaskService) {
        let _guard = self.drain_lock.lock().await;
        let mut processed = HashSet::new();

        loop {
            let jobs = match service.list_pending_dedupe_jobs() {
                Ok(jobs) => jobs,
                Err(error) => {
                    tracing::warn!(%error, "could not read pending dedupe jobs");
                    return;
                }
            };
            let Some(job) = jobs
                .into_iter()
                .find(|job| !processed.contains(&job.task_id))
            else {
                return;
            };
            processed.insert(job.task_id.clone());

            let context = match service.prepare_dedupe_context(&job.task_id) {
                Ok(Some(context)) => context,
                Ok(None) => continue,
                Err(error) => {
                    tracing::warn!(task_id = %job.task_id, %error, "could not prepare dedupe job");
                    continue;
                }
            };
            let credentials = match service.llm_credentials() {
                Ok(credentials) => ProviderCredentials {
                    openai: credentials.openai,
                    anthropic: credentials.anthropic,
                },
                Err(error) => {
                    tracing::warn!(task_id = %job.task_id, %error, "could not read AI credentials");
                    return;
                }
            };
            if !credentials.has_any() {
                emit_credentials_required(&app);
                return;
            }

            match self.reconcile_context(&context, &credentials).await {
                Ok(Some((decision, existing_fingerprint))) => {
                    let Some(existing_id) = decision.duplicate_task_id else {
                        continue;
                    };
                    let Some(merged_task) = decision.merged_task else {
                        continue;
                    };
                    match service.commit_dedupe_suggestion(
                        &context.job.task_id,
                        &context.new_task.fingerprint,
                        &context.candidate_fingerprint,
                        &existing_id,
                        &existing_fingerprint,
                        merged_task,
                    ) {
                        Ok(Some(_)) => emit_suggestions_changed(&app),
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(
                                task_id = %context.job.task_id,
                                %error,
                                "could not persist dedupe suggestion"
                            );
                        }
                    }
                }
                Ok(None) => {
                    if let Err(error) = service.commit_dedupe_no_match(
                        &context.job.task_id,
                        &context.new_task.fingerprint,
                        &context.candidate_fingerprint,
                    ) {
                        tracing::warn!(
                            task_id = %context.job.task_id,
                            %error,
                            "could not finish dedupe job"
                        );
                    }
                }
                Err(FailureCategory::MissingCredentials)
                | Err(FailureCategory::AuthOrAccess)
                | Err(FailureCategory::Quota) => {
                    emit_credentials_required(&app);
                    return;
                }
                Err(FailureCategory::Transient) => return,
                Err(FailureCategory::JobSpecific) => {
                    if let Err(error) =
                        service.record_dedupe_job_failure(&context.job.task_id, "provider_response")
                    {
                        tracing::warn!(
                            task_id = %context.job.task_id,
                            %error,
                            "could not record dedupe failure"
                        );
                    }
                }
            }
        }
    }

    async fn reconcile_context(
        &self,
        context: &DedupeContext,
        credentials: &ProviderCredentials,
    ) -> Result<Option<(DedupeDecision, String)>, FailureCategory> {
        let new_task = LlmTask::from(&context.new_task.task);
        let logbook_tasks = context
            .logbook_context
            .iter()
            .map(|snapshot| LlmTask::from(&snapshot.task))
            .collect::<Vec<_>>();
        let chunks = context
            .active_candidates
            .chunks(CANDIDATES_PER_REQUEST)
            .collect::<Vec<_>>();

        if chunks.is_empty() {
            return Ok(None);
        }

        for candidates in chunks {
            let request = DedupeRequest {
                new_task: new_task.clone(),
                active_tasks: candidates
                    .iter()
                    .map(|snapshot| LlmTask::from(&snapshot.task))
                    .collect(),
                logbook_tasks: logbook_tasks.clone(),
            };
            let decision = self
                .client
                .reconcile(&request, credentials)
                .await
                .map_err(|error| error.category)?;
            let Some(existing_id) = decision.duplicate_task_id.as_deref() else {
                continue;
            };
            let existing_fingerprint = candidates
                .iter()
                .find(|snapshot| snapshot.task.id == existing_id)
                .map(|snapshot| snapshot.fingerprint.clone())
                .ok_or(FailureCategory::JobSpecific)?;
            return Ok(Some((decision, existing_fingerprint)));
        }

        Ok(None)
    }
}

fn normalize_key_patch(patch: NullablePatch<String>) -> AppResult<Option<Option<String>>> {
    match patch {
        NullablePatch::Missing => Ok(None),
        NullablePatch::Null => Ok(Some(None)),
        NullablePatch::Value(value) => {
            let value = value.trim();
            if value.is_empty() {
                return Err(AppError::invalid_input(
                    "API keys cannot be blank; use Clear instead",
                ));
            }
            Ok(Some(Some(value.to_owned())))
        }
    }
}

fn resulting_key_exists(
    patch: &Option<Option<String>>,
    currently_configured: bool,
    environment_name: &str,
) -> bool {
    match patch {
        Some(Some(_)) => true,
        Some(None) => std::env::var(environment_name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty()),
        None => currently_configured,
    }
}

fn emit_credentials_required(app: &AppHandle) {
    if let Err(error) = app.emit("todou://llm-credentials-required", ()) {
        tracing::warn!(%error, "could not emit AI credentials event");
    }
}

pub fn emit_suggestions_changed(app: &AppHandle) {
    if let Err(error) = app.emit("todou://dedupe-suggestions-changed", ()) {
        tracing::warn!(%error, "could not emit dedupe suggestions event");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_patch_distinguishes_keep_clear_and_replace() {
        let keep: SaveLlmSettingsInput = serde_json::from_value(serde_json::json!({})).unwrap();
        let clear: SaveLlmSettingsInput =
            serde_json::from_value(serde_json::json!({ "openaiApiKey": null })).unwrap();
        let replace: SaveLlmSettingsInput =
            serde_json::from_value(serde_json::json!({ "anthropicApiKey": "  secret  " })).unwrap();

        assert!(matches!(keep.openai_api_key, NullablePatch::Missing));
        assert!(matches!(clear.openai_api_key, NullablePatch::Null));
        assert_eq!(
            normalize_key_patch(replace.anthropic_api_key).unwrap(),
            Some(Some("secret".to_owned()))
        );
    }
}
