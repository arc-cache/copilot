use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenMeasurement {
    pub(crate) input_tokens: Option<u64>,
    pub(crate) output_tokens: Option<u64>,
    pub(crate) total_tokens: Option<u64>,
    pub(crate) source: String,
    pub(crate) scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CostMeasurement {
    pub(crate) amount: Option<f64>,
    pub(crate) currency: String,
    pub(crate) source: String,
    pub(crate) scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCallTelemetry {
    call_id: String,
    operation_fingerprint: String,
    name: String,
    started_at: String,
    duration_ms: Option<u64>,
    status: String,
    attempt: u64,
    retry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyWarning {
    code: String,
    message: String,
    observed: f64,
    limit: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetrievalTelemetry {
    decision: String,
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capsule_id: Option<String>,
    reason: String,
    #[serde(default)]
    weak_match_case: bool,
    weak_match_abstention: bool,
    capsule_was_stale: bool,
    stale_capsule_rejected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunTelemetryRecord {
    schema_version: u64,
    kind: String,
    recorded_at: String,
    runner: String,
    session_id: String,
    turn_id: String,
    started_at: String,
    ended_at: String,
    duration_ms: u64,
    status: String,
    stop_reason: String,
    model_latency: ModelLatency,
    tokens: TokenMeasurement,
    cost: CostMeasurement,
    tool_calls: Vec<ToolCallTelemetry>,
    failed_tool_count: u64,
    retry_count: u64,
    retrieval: RetrievalTelemetry,
    warnings: Vec<PolicyWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelLatency {
    first_response_ms: Option<u64>,
    total_ms: u64,
    source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewerCallTelemetryRecord {
    schema_version: u64,
    kind: String,
    recorded_at: String,
    runner: String,
    session_id: String,
    call_id: String,
    source: String,
    duration_ms: u64,
    status: String,
    tokens: TokenMeasurement,
    cost: CostMeasurement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    warnings: Vec<PolicyWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum TelemetryRecord {
    Run(RunTelemetryRecord),
    Reviewer(ReviewerCallTelemetryRecord),
}

impl TelemetryRecord {
    fn kind(&self) -> &str {
        match self {
            Self::Run(value) => &value.kind,
            Self::Reviewer(value) => &value.kind,
        }
    }

    fn session_id(&self) -> &str {
        match self {
            Self::Run(value) => &value.session_id,
            Self::Reviewer(value) => &value.session_id,
        }
    }

    fn warnings(&self) -> &[PolicyWarning] {
        match self {
            Self::Run(value) => &value.warnings,
            Self::Reviewer(value) => &value.warnings,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TelemetryPolicy {
    warnings: WarningPolicy,
    reviewer: ReviewerPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WarningPolicy {
    cost_usd_per_session: Option<f64>,
    slow_tool_ms: Option<u64>,
    repeated_failures: Option<u64>,
    retries_per_session: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewerPolicy {
    max_calls_per_session: Option<u64>,
    hard_cost_usd_per_session: Option<f64>,
    estimated_cost_usd_per_call: Option<f64>,
}

impl Default for TelemetryPolicy {
    fn default() -> Self {
        Self {
            warnings: WarningPolicy {
                cost_usd_per_session: None,
                slow_tool_ms: Some(30_000),
                repeated_failures: Some(2),
                retries_per_session: Some(3),
            },
            reviewer: ReviewerPolicy {
                max_calls_per_session: None,
                hard_cost_usd_per_session: None,
                estimated_cost_usd_per_call: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Percentiles {
    pub(crate) count: usize,
    pub(crate) p50: Option<u64>,
    pub(crate) p95: Option<u64>,
    pub(crate) p99: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LatencyMetrics {
    pub(crate) session: Percentiles,
    pub(crate) model_first_response: Percentiles,
    pub(crate) tool: Percentiles,
    pub(crate) reviewer: Percentiles,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenSummary {
    pub(crate) total: u64,
    pub(crate) provider: u64,
    pub(crate) estimated: u64,
    pub(crate) unknown_sessions: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CostSummary {
    pub(crate) known_usd: f64,
    pub(crate) provider_usd: f64,
    pub(crate) estimated_usd: f64,
    pub(crate) unknown_sessions: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsSummary {
    pub(crate) session_count: usize,
    pub(crate) turn_count: usize,
    pub(crate) latency_ms: LatencyMetrics,
    pub(crate) tool_calls: usize,
    pub(crate) failed_tools: usize,
    pub(crate) failed_tool_rate: f64,
    pub(crate) retries: u64,
    pub(crate) tokens: TokenSummary,
    pub(crate) cost: CostSummary,
    pub(crate) warnings: usize,
    pub(crate) warning_messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionMetrics {
    pub(crate) session_id: String,
    pub(crate) started_at: String,
    pub(crate) ended_at: String,
    pub(crate) duration_ms: u64,
    pub(crate) status: String,
    pub(crate) turns: usize,
    pub(crate) tool_calls: usize,
    pub(crate) failed_tools: usize,
    pub(crate) failed_tool_rate: f64,
    pub(crate) retries: u64,
    pub(crate) model_first_response_ms: Option<u64>,
    pub(crate) tokens: SessionMeasurement,
    pub(crate) cost: SessionCost,
    pub(crate) reviewer_calls: usize,
    pub(crate) warning_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionMeasurement {
    pub(crate) total: Option<u64>,
    pub(crate) source: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionCost {
    pub(crate) usd: Option<f64>,
    pub(crate) source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayEvaluationReport {
    generated_at: String,
    trace_count: usize,
    paired_run_count: usize,
    retrieval_precision: RatioEvaluation,
    weak_match_abstention: AbstentionEvaluation,
    stale_capsule_rejection: StaleEvaluation,
    telemetry_redaction: RedactionEvaluation,
    injected_memory_outcome: MemoryOutcomeEvaluation,
}

#[derive(Debug, Clone, Serialize)]
struct RatioEvaluation {
    value: Option<f64>,
    relevant: usize,
    evaluated: usize,
    injected: usize,
    method: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbstentionEvaluation {
    value: Option<f64>,
    abstained: usize,
    weak_match_cases: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StaleEvaluation {
    value: Option<f64>,
    rejected: usize,
    stale_cases: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RedactionEvaluation {
    passed: bool,
    records_scanned: usize,
    violations: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryOutcomeEvaluation {
    helped: usize,
    did_not_help: usize,
    inconclusive: usize,
    method: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsReport {
    generated_at: String,
    workspace: String,
    policy: Value,
    pub(crate) summary: MetricsSummary,
    pub(crate) sessions: Vec<SessionMetrics>,
    pub(crate) evaluations: ReplayEvaluationReport,
}

pub(crate) fn telemetry_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("telemetry.redacted.jsonl")
}

pub(crate) fn telemetry_policy_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("telemetry-policy.json")
}

pub(crate) fn load_telemetry_policy(workspace: &Path) -> Result<TelemetryPolicy> {
    let mut policy = TelemetryPolicy::default();
    if let Ok(text) = fs::read_to_string(telemetry_policy_path(workspace)) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            let warnings = value.get("warnings").unwrap_or(&Value::Null);
            let reviewer = value.get("reviewer").unwrap_or(&Value::Null);
            policy.warnings.cost_usd_per_session = optional_number(
                warnings.get("costUsdPerSession"),
                policy.warnings.cost_usd_per_session,
            );
            policy.warnings.slow_tool_ms =
                optional_u64(warnings.get("slowToolMs"), policy.warnings.slow_tool_ms);
            policy.warnings.repeated_failures = optional_u64(
                warnings.get("repeatedFailures"),
                policy.warnings.repeated_failures,
            );
            policy.warnings.retries_per_session = optional_u64(
                warnings.get("retriesPerSession"),
                policy.warnings.retries_per_session,
            );
            policy.reviewer.max_calls_per_session = optional_u64(
                reviewer.get("maxCallsPerSession"),
                policy.reviewer.max_calls_per_session,
            );
            policy.reviewer.hard_cost_usd_per_session = optional_number(
                reviewer.get("hardCostUsdPerSession"),
                policy.reviewer.hard_cost_usd_per_session,
            );
            policy.reviewer.estimated_cost_usd_per_call = optional_number(
                reviewer.get("estimatedCostUsdPerCall"),
                policy.reviewer.estimated_cost_usd_per_call,
            );
        }
    }
    policy.warnings.cost_usd_per_session = env_number(
        "AGENT_RUN_CACHE_WARN_COST_USD",
        policy.warnings.cost_usd_per_session,
    );
    policy.warnings.slow_tool_ms = env_u64(
        "AGENT_RUN_CACHE_WARN_SLOW_TOOL_MS",
        policy.warnings.slow_tool_ms,
    );
    policy.warnings.repeated_failures = env_u64(
        "AGENT_RUN_CACHE_WARN_REPEATED_FAILURES",
        policy.warnings.repeated_failures,
    );
    policy.warnings.retries_per_session = env_u64(
        "AGENT_RUN_CACHE_WARN_RETRIES",
        policy.warnings.retries_per_session,
    );
    policy.reviewer.max_calls_per_session = env_u64(
        "AGENT_RUN_CACHE_REVIEWER_MAX_CALLS",
        policy.reviewer.max_calls_per_session,
    );
    policy.reviewer.hard_cost_usd_per_session = env_number(
        "AGENT_RUN_CACHE_REVIEWER_HARD_COST_USD",
        policy.reviewer.hard_cost_usd_per_session,
    );
    policy.reviewer.estimated_cost_usd_per_call = env_number(
        "AGENT_RUN_CACHE_REVIEWER_ESTIMATED_COST_USD_PER_CALL",
        policy.reviewer.estimated_cost_usd_per_call,
    );
    Ok(policy)
}

pub(crate) fn record_run_from_events(
    events: &[ArcEvent],
    workspace: &Path,
    session_id: &str,
) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let records = load_records(workspace)?;
    if records
        .iter()
        .any(|record| record.kind() == "run" && record.session_id() == session_id)
    {
        return Ok(());
    }
    let started_ms = events
        .iter()
        .filter_map(|event| timestamp_ms(&event.timestamp))
        .min()
        .unwrap_or_else(now_ms);
    let ended_ms = events
        .iter()
        .filter_map(|event| timestamp_ms(&event.timestamp))
        .max()
        .unwrap_or(started_ms);
    let prompt_ms = events
        .iter()
        .filter(|event| event.type_ == "user_prompt")
        .filter_map(|event| timestamp_ms(&event.timestamp))
        .min()
        .unwrap_or(started_ms);
    let response_ms = events
        .iter()
        .filter(|event| event.type_ == "assistant_message" || event.type_ == "tool_start")
        .filter_map(|event| timestamp_ms(&event.timestamp))
        .find(|value| *value >= prompt_ms);
    let tools = tool_calls(events, session_id);
    let failed_tool_count = tools.iter().filter(|tool| tool.status == "failed").count() as u64;
    let retry_count = tools.iter().filter(|tool| tool.retry).count() as u64;
    let tokens = usage_tokens(events).unwrap_or_else(|| estimated_tokens(events));
    let cost = usage_cost(events).unwrap_or_else(unknown_cost);
    let retrieval = retrieval_for_session(workspace, session_id)?;
    let (status, stop_reason) = run_outcome(events, failed_tool_count);
    let mut record = RunTelemetryRecord {
        schema_version: 1,
        kind: "run".to_owned(),
        recorded_at: now_iso(),
        runner: events
            .first()
            .map(|event| event.runner.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "copilot".to_owned()),
        session_id: sanitize_label(session_id, 200),
        turn_id: sanitize_label(session_id, 240),
        started_at: ms_iso(started_ms),
        ended_at: ms_iso(ended_ms),
        duration_ms: ended_ms.saturating_sub(started_ms),
        status,
        stop_reason,
        model_latency: ModelLatency {
            first_response_ms: response_ms.map(|value| value.saturating_sub(prompt_ms)),
            total_ms: ended_ms.saturating_sub(prompt_ms),
            source: "observed".to_owned(),
        },
        tokens,
        cost,
        tool_calls: tools,
        failed_tool_count,
        retry_count,
        retrieval,
        warnings: Vec::new(),
    };
    record.warnings = run_warnings(&record, &load_telemetry_policy(workspace)?);
    append_jsonl(&telemetry_path(workspace), &record)
}

pub(crate) fn reviewer_budget_reason(workspace: &Path, session_id: &str) -> Result<Option<String>> {
    let policy = load_telemetry_policy(workspace)?;
    let records = load_records(workspace)?;
    let calls = reviewer_calls(&records, session_id);
    let completed = calls
        .iter()
        .filter(|call| call.status != "blocked")
        .collect::<Vec<_>>();
    if let Some(limit) = policy.reviewer.max_calls_per_session {
        if completed.len() as u64 >= limit {
            let reason = format!(
                "ARC reviewer hard call limit reached ({}/{limit}).",
                completed.len()
            );
            record_blocked_reviewer(
                workspace,
                session_id,
                &reason,
                completed.len() as f64,
                limit as f64,
            )?;
            return Ok(Some(reason));
        }
    }
    if let Some(limit) = policy.reviewer.hard_cost_usd_per_session {
        let used = completed
            .iter()
            .filter_map(|call| call.cost.amount)
            .sum::<f64>();
        let next = policy.reviewer.estimated_cost_usd_per_call.unwrap_or(0.0);
        if used + next >= limit {
            let reason = format!(
                "ARC reviewer hard cost limit reached (${:.4}/${limit:.4}).",
                used + next
            );
            record_blocked_reviewer(workspace, session_id, &reason, used + next, limit)?;
            return Ok(Some(reason));
        }
    }
    Ok(None)
}

pub(crate) fn record_reviewer_call(
    workspace: &Path,
    session_id: &str,
    source: &str,
    duration_ms: u64,
    status: &str,
    input: &str,
    output: &str,
    reason: Option<&str>,
) -> Result<()> {
    let policy = load_telemetry_policy(workspace)?;
    let cost = match policy.reviewer.estimated_cost_usd_per_call {
        Some(amount) => CostMeasurement {
            amount: Some(amount),
            currency: "USD".to_owned(),
            source: "estimate".to_owned(),
            scope: "turn".to_owned(),
        },
        None => CostMeasurement {
            amount: None,
            currency: "USD".to_owned(),
            source: "unknown".to_owned(),
            scope: "turn".to_owned(),
        },
    };
    let chars = input.chars().count() + output.chars().count();
    let mut record = ReviewerCallTelemetryRecord {
        schema_version: 1,
        kind: "reviewer_call".to_owned(),
        recorded_at: now_iso(),
        runner: "arc-reviewer".to_owned(),
        session_id: sanitize_label(session_id, 200),
        call_id: generated_id(),
        source: sanitize_label(source, 80),
        duration_ms,
        status: sanitize_label(status, 20),
        tokens: TokenMeasurement {
            input_tokens: Some(token_estimate(input)),
            output_tokens: Some(token_estimate(output)),
            total_tokens: Some(((chars + 3) / 4) as u64),
            source: "estimate".to_owned(),
            scope: "turn".to_owned(),
        },
        cost,
        reason: reason.map(|value| sanitize_label(value, 500)),
        warnings: Vec::new(),
    };
    if let (Some(limit), Some(amount)) = (policy.warnings.cost_usd_per_session, record.cost.amount)
    {
        let before = known_session_cost(&load_records(workspace)?, session_id);
        let after = before + amount;
        if before < limit && after >= limit {
            record.warnings.push(warning(
                "cost",
                &format!("Session cost reached ${after:.4} (warning budget ${limit:.4})."),
                after,
                limit,
            ));
        }
    }
    append_jsonl(&telemetry_path(workspace), &record)
}

pub(crate) fn build_metrics_report(workspace: &Path) -> Result<MetricsReport> {
    let records = load_records(workspace)?;
    let runs = records
        .iter()
        .filter_map(|record| match record {
            TelemetryRecord::Run(value) if value.kind == "run" => Some(value.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let all_reviewer = records
        .iter()
        .filter_map(|record| match record {
            TelemetryRecord::Reviewer(value) if value.kind == "reviewer_call" => {
                Some(value.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut ids = records
        .iter()
        .map(|record| record.session_id().to_owned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    ids.sort();
    let mut sessions = ids
        .iter()
        .filter_map(|id| session_metrics(id, &runs, &all_reviewer))
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.ended_at.cmp(&left.ended_at));
    let tools = runs
        .iter()
        .flat_map(|run| run.tool_calls.iter())
        .collect::<Vec<_>>();
    let completed_reviewer = all_reviewer
        .iter()
        .filter(|call| call.status != "blocked")
        .collect::<Vec<_>>();
    let failed_tools = tools.iter().filter(|tool| tool.status == "failed").count();
    let provider_tokens: u64 = runs
        .iter()
        .filter(|run| run.tokens.source == "provider")
        .filter_map(|run| run.tokens.total_tokens)
        .sum();
    let estimated_tokens: u64 = runs
        .iter()
        .filter(|run| run.tokens.source == "estimate")
        .filter_map(|run| run.tokens.total_tokens)
        .sum();
    let reviewer_tokens = completed_reviewer
        .iter()
        .filter_map(|call| call.tokens.total_tokens)
        .sum::<u64>();
    let provider_cost = runs
        .iter()
        .filter(|run| run.cost.source == "provider")
        .filter_map(|run| run.cost.amount)
        .sum::<f64>();
    let estimated_cost = runs
        .iter()
        .filter(|run| run.cost.source == "estimate")
        .filter_map(|run| run.cost.amount)
        .sum::<f64>()
        + completed_reviewer
            .iter()
            .filter(|call| call.cost.source == "estimate")
            .filter_map(|call| call.cost.amount)
            .sum::<f64>();
    let policy = load_telemetry_policy(workspace)?;
    let summary = MetricsSummary {
        session_count: sessions.len(),
        turn_count: runs.len(),
        latency_ms: LatencyMetrics {
            session: percentiles(sessions.iter().map(|session| Some(session.duration_ms))),
            model_first_response: percentiles(
                runs.iter().map(|run| run.model_latency.first_response_ms),
            ),
            tool: percentiles(tools.iter().map(|tool| tool.duration_ms)),
            reviewer: percentiles(completed_reviewer.iter().map(|call| Some(call.duration_ms))),
        },
        tool_calls: tools.len(),
        failed_tools,
        failed_tool_rate: ratio(failed_tools, tools.len()),
        retries: runs.iter().map(|run| run.retry_count).sum(),
        tokens: TokenSummary {
            total: provider_tokens + estimated_tokens + reviewer_tokens,
            provider: provider_tokens,
            estimated: estimated_tokens + reviewer_tokens,
            unknown_sessions: sessions
                .iter()
                .filter(|session| session.tokens.total.is_none())
                .count(),
        },
        cost: CostSummary {
            known_usd: round_money(provider_cost + estimated_cost),
            provider_usd: round_money(provider_cost),
            estimated_usd: round_money(estimated_cost),
            unknown_sessions: sessions
                .iter()
                .filter(|session| session.cost.usd.is_none())
                .count(),
        },
        warnings: records.iter().map(|record| record.warnings().len()).sum(),
        warning_messages: records
            .iter()
            .rev()
            .flat_map(|record| {
                record
                    .warnings()
                    .iter()
                    .map(|warning| warning.message.clone())
            })
            .take(8)
            .collect(),
    };
    Ok(MetricsReport {
        generated_at: now_iso(),
        workspace: workspace.to_string_lossy().to_string(),
        policy: json!({ "path": telemetry_policy_path(workspace), "warnings": policy.warnings, "reviewer": policy.reviewer }),
        summary,
        sessions,
        evaluations: replay_report(workspace, &runs, records.len())?,
    })
}

pub(crate) fn sanitized_metrics_aggregate(workspace: &Path) -> Result<Value> {
    let report = build_metrics_report(workspace)?;
    Ok(json!({
        "generatedAt": report.generated_at,
        "summary": report.summary,
        "evaluations": report.evaluations,
        "policy": report.policy.get("warnings").map(|warnings| json!({ "warnings": warnings, "reviewer": report.policy.get("reviewer") })).unwrap_or(Value::Null)
    }))
}

fn load_records(workspace: &Path) -> Result<Vec<TelemetryRecord>> {
    Ok(read_jsonl_values(&telemetry_path(workspace))?
        .into_iter()
        .filter_map(|value| match value.get("kind").and_then(Value::as_str) {
            Some("run") => serde_json::from_value(value).ok().map(TelemetryRecord::Run),
            Some("reviewer_call") => serde_json::from_value(value)
                .ok()
                .map(TelemetryRecord::Reviewer),
            _ => None,
        })
        .collect())
}

fn tool_calls(events: &[ArcEvent], session_id: &str) -> Vec<ToolCallTelemetry> {
    let mut starts: Vec<(usize, &ArcEvent, String)> = Vec::new();
    let mut completed = HashSet::new();
    let mut attempts: HashMap<String, u64> = HashMap::new();
    let mut tools = Vec::new();
    for event in events {
        if event.type_ == "tool_start" {
            starts.push((starts.len(), event, tool_fingerprint(event, session_id)));
            continue;
        }
        if event.type_ != "tool_end" {
            continue;
        }
        let matched = starts
            .iter()
            .find(|(index, start, _)| {
                !completed.contains(index)
                    && event.tool_use_id.is_some()
                    && event.tool_use_id == start.tool_use_id
            })
            .or_else(|| {
                starts.iter().find(|(index, start, _)| {
                    !completed.contains(index)
                        && event.command.is_some()
                        && event.command == start.command
                })
            })
            .or_else(|| {
                starts
                    .iter()
                    .find(|(index, _, _)| !completed.contains(index))
            });
        if let Some((index, _, _)) = matched {
            completed.insert(*index);
        }
        let fingerprint = matched
            .map(|(_, _, value)| value.clone())
            .unwrap_or_else(|| tool_fingerprint(event, session_id));
        let attempt = attempts.entry(fingerprint.clone()).or_insert(0);
        *attempt += 1;
        let started_at = matched
            .map(|(_, start, _)| start.timestamp.clone())
            .unwrap_or_else(|| event.timestamp.clone());
        tools.push(ToolCallTelemetry {
            call_id: hash24(&format!(
                "{session_id}\0{}\0{}",
                event.tool_use_id.as_deref().unwrap_or(""),
                tools.len()
            )),
            operation_fingerprint: fingerprint,
            name: sanitize_tool_name(
                event
                    .tool_name
                    .as_deref()
                    .or_else(|| matched.and_then(|(_, start, _)| start.tool_name.as_deref())),
            ),
            started_at: started_at.clone(),
            duration_ms: duration_between(&started_at, &event.timestamp),
            status: tool_status(event),
            attempt: *attempt,
            retry: *attempt > 1,
        });
    }
    for (index, start, fingerprint) in starts
        .into_iter()
        .filter(|(index, _, _)| !completed.contains(index))
    {
        let attempt = attempts.entry(fingerprint.clone()).or_insert(0);
        *attempt += 1;
        tools.push(ToolCallTelemetry {
            call_id: hash24(&format!(
                "{session_id}\0{}\0{index}",
                start.tool_use_id.as_deref().unwrap_or("")
            )),
            operation_fingerprint: fingerprint,
            name: sanitize_tool_name(start.tool_name.as_deref()),
            started_at: start.timestamp.clone(),
            duration_ms: None,
            status: "unknown".to_owned(),
            attempt: *attempt,
            retry: *attempt > 1,
        });
    }
    tools
}

fn retrieval_for_session(workspace: &Path, session_id: &str) -> Result<RetrievalTelemetry> {
    let event = load_memory_events(workspace)?
        .into_iter()
        .rev()
        .find(|event| {
            event.session_id.as_deref() == Some(session_id)
                && matches!(
                    event.r#type.as_str(),
                    "capsule.injected" | "capsule.retrieval"
                )
        });
    let Some(event) = event else {
        return Ok(RetrievalTelemetry {
            decision: "unknown".to_owned(),
            source: "unknown".to_owned(),
            capsule_id: None,
            reason: "no recorded retrieval decision".to_owned(),
            weak_match_case: false,
            weak_match_abstention: false,
            capsule_was_stale: false,
            stale_capsule_rejected: false,
        });
    };
    let details = event.details.unwrap_or(Value::Null);
    let decision = details
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or(if event.r#type == "capsule.injected" {
            "injected"
        } else {
            "abstained"
        })
        .to_owned();
    let reason = sanitize_label(
        details
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("recorded retrieval decision"),
        500,
    );
    let stale = details
        .get("capsuleWasStale")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(RetrievalTelemetry {
        decision: decision.clone(),
        source: sanitize_label(
            details
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            40,
        ),
        capsule_id: event.capsule_id.map(|value| sanitize_label(&value, 200)),
        weak_match_case: weak_match_reason(&reason),
        weak_match_abstention: decision == "abstained" && weak_match_reason(&reason),
        stale_capsule_rejected: decision == "abstained"
            && (stale || stale_rejection_reason(&reason)),
        capsule_was_stale: stale,
        reason,
    })
}

fn session_metrics(
    session_id: &str,
    runs: &[RunTelemetryRecord],
    reviewers: &[ReviewerCallTelemetryRecord],
) -> Option<SessionMetrics> {
    let selected = runs
        .iter()
        .filter(|run| run.session_id == session_id)
        .collect::<Vec<_>>();
    let calls = reviewers
        .iter()
        .filter(|call| call.session_id == session_id)
        .collect::<Vec<_>>();
    if selected.is_empty() && calls.is_empty() {
        return None;
    }
    let start = selected
        .iter()
        .filter_map(|run| timestamp_ms(&run.started_at))
        .chain(
            calls
                .iter()
                .filter_map(|call| timestamp_ms(&call.recorded_at)),
        )
        .min()
        .unwrap_or_else(now_ms);
    let end = selected
        .iter()
        .filter_map(|run| timestamp_ms(&run.ended_at))
        .chain(
            calls
                .iter()
                .filter_map(|call| timestamp_ms(&call.recorded_at)),
        )
        .max()
        .unwrap_or(start);
    let tools = selected
        .iter()
        .flat_map(|run| run.tool_calls.iter())
        .collect::<Vec<_>>();
    let failed = tools.iter().filter(|tool| tool.status == "failed").count();
    let token_values = selected
        .iter()
        .filter_map(|run| run.tokens.total_tokens)
        .chain(
            calls
                .iter()
                .filter(|call| call.status != "blocked")
                .filter_map(|call| call.tokens.total_tokens),
        )
        .collect::<Vec<_>>();
    let cost_values = selected
        .iter()
        .filter_map(|run| run.cost.amount)
        .chain(
            calls
                .iter()
                .filter(|call| call.status != "blocked")
                .filter_map(|call| call.cost.amount),
        )
        .collect::<Vec<_>>();
    let token_sources = selected
        .iter()
        .map(|run| run.tokens.source.as_str())
        .chain(
            calls
                .iter()
                .filter(|call| call.status != "blocked")
                .map(|call| call.tokens.source.as_str()),
        )
        .filter(|source| *source != "unknown")
        .collect::<HashSet<_>>();
    let cost_sources = selected
        .iter()
        .map(|run| run.cost.source.as_str())
        .chain(
            calls
                .iter()
                .filter(|call| call.status != "blocked")
                .map(|call| call.cost.source.as_str()),
        )
        .filter(|source| *source != "unknown")
        .collect::<HashSet<_>>();
    Some(SessionMetrics {
        session_id: session_id.to_owned(),
        started_at: ms_iso(start),
        ended_at: ms_iso(end),
        duration_ms: end.saturating_sub(start),
        status: selected
            .last()
            .map(|run| run.status.clone())
            .unwrap_or_else(|| "unknown".to_owned()),
        turns: selected.len(),
        tool_calls: tools.len(),
        failed_tools: failed,
        failed_tool_rate: ratio(failed, tools.len()),
        retries: selected.iter().map(|run| run.retry_count).sum(),
        model_first_response_ms: selected
            .iter()
            .filter_map(|run| run.model_latency.first_response_ms)
            .next(),
        tokens: SessionMeasurement {
            total: (!token_values.is_empty()).then(|| token_values.iter().sum()),
            source: mixed_source(&token_sources),
        },
        cost: SessionCost {
            usd: (!cost_values.is_empty()).then(|| round_money(cost_values.iter().sum())),
            source: mixed_source(&cost_sources),
        },
        reviewer_calls: calls.iter().filter(|call| call.status != "blocked").count(),
        warning_count: selected.iter().map(|run| run.warnings.len()).sum::<usize>()
            + calls.iter().map(|call| call.warnings.len()).sum::<usize>(),
    })
}

fn replay_report(
    workspace: &Path,
    runs: &[RunTelemetryRecord],
    record_count: usize,
) -> Result<ReplayEvaluationReport> {
    let trace_root = cache_dir(workspace).join("traces");
    let trace_count = fs::read_dir(trace_root)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
                })
                .count()
        })
        .unwrap_or(0);
    let paired = runs.len().min(trace_count);
    let injected = runs
        .iter()
        .filter(|run| run.retrieval.decision == "injected")
        .collect::<Vec<_>>();
    let helped = injected
        .iter()
        .filter(|run| run.status == "success" && run.failed_tool_count == 0 && run.retry_count == 0)
        .count();
    let did_not_help = injected.iter().filter(|run| run.status == "failed").count();
    let inconclusive = injected.len().saturating_sub(helped + did_not_help);
    let evaluated = helped + did_not_help;
    let weak = runs
        .iter()
        .filter(|run| run.retrieval.weak_match_case)
        .collect::<Vec<_>>();
    let weak_abstained = weak
        .iter()
        .filter(|run| run.retrieval.decision == "abstained")
        .count();
    let stale = runs
        .iter()
        .filter(|run| run.retrieval.capsule_was_stale || run.retrieval.stale_capsule_rejected)
        .collect::<Vec<_>>();
    let violations = load_records(workspace)?
        .iter()
        .filter(|record| !record_is_redacted(record))
        .count();
    Ok(ReplayEvaluationReport {
        generated_at: now_iso(), trace_count, paired_run_count: paired,
        retrieval_precision: RatioEvaluation { value: optional_ratio(helped, evaluated), relevant: helped, evaluated, injected: injected.len(), method: "Observed proxy: an injected trace is relevant when it ends successfully without failed or retried tools; ambiguous recoveries are excluded.".to_owned() },
        weak_match_abstention: AbstentionEvaluation { value: optional_ratio(weak_abstained, weak.len()), abstained: weak_abstained, weak_match_cases: weak.len() },
        stale_capsule_rejection: StaleEvaluation { value: optional_ratio(stale.iter().filter(|run| run.retrieval.decision == "abstained").count(), stale.len()), rejected: stale.iter().filter(|run| run.retrieval.decision == "abstained").count(), stale_cases: stale.len() },
        telemetry_redaction: RedactionEvaluation { passed: violations == 0, records_scanned: record_count, violations },
        injected_memory_outcome: MemoryOutcomeEvaluation { helped, did_not_help, inconclusive, method: "Deterministic trace proxy, not a causal claim: clean successful reuse counts as helped, failed runs as not helped, and recovered failures as inconclusive.".to_owned() },
    })
}

fn run_warnings(record: &RunTelemetryRecord, policy: &TelemetryPolicy) -> Vec<PolicyWarning> {
    let mut warnings = Vec::new();
    if let Some(limit) = policy.warnings.slow_tool_ms {
        if let Some(worst) = record
            .tool_calls
            .iter()
            .filter_map(|tool| tool.duration_ms)
            .max()
            .filter(|value| *value > limit)
        {
            warnings.push(warning(
                "slow_tool",
                &format!("A tool call exceeded the {limit}ms warning budget (worst {worst}ms)."),
                worst as f64,
                limit as f64,
            ));
        }
    }
    if let Some(limit) = policy.warnings.repeated_failures {
        let mut failures = HashMap::<&str, u64>::new();
        for tool in record
            .tool_calls
            .iter()
            .filter(|tool| tool.status == "failed")
        {
            *failures.entry(&tool.operation_fingerprint).or_default() += 1;
        }
        let observed = failures.values().copied().max().unwrap_or(0);
        if observed >= limit {
            warnings.push(warning(
                "repeated_failures",
                &format!("A tool operation failed {observed} times (warning budget {limit})."),
                observed as f64,
                limit as f64,
            ));
        }
    }
    if let Some(limit) = policy.warnings.retries_per_session {
        if record.retry_count >= limit {
            warnings.push(warning(
                "excessive_retries",
                &format!(
                    "Session retries reached {} (warning budget {limit}).",
                    record.retry_count
                ),
                record.retry_count as f64,
                limit as f64,
            ));
        }
    }
    if let (Some(limit), Some(cost)) = (policy.warnings.cost_usd_per_session, record.cost.amount) {
        if cost >= limit {
            warnings.push(warning(
                "cost",
                &format!("Session cost reached ${cost:.4} (warning budget ${limit:.4})."),
                cost,
                limit,
            ));
        }
    }
    warnings
}

fn record_blocked_reviewer(
    workspace: &Path,
    session_id: &str,
    reason: &str,
    observed: f64,
    limit: f64,
) -> Result<()> {
    let record = ReviewerCallTelemetryRecord {
        schema_version: 1,
        kind: "reviewer_call".to_owned(),
        recorded_at: now_iso(),
        runner: "arc-reviewer".to_owned(),
        session_id: sanitize_label(session_id, 200),
        call_id: generated_id(),
        source: "policy".to_owned(),
        duration_ms: 0,
        status: "blocked".to_owned(),
        tokens: unknown_tokens(),
        cost: CostMeasurement {
            amount: None,
            currency: "USD".to_owned(),
            source: "unknown".to_owned(),
            scope: "turn".to_owned(),
        },
        reason: Some(sanitize_label(reason, 500)),
        warnings: vec![warning("reviewer_hard_limit", reason, observed, limit)],
    };
    append_jsonl(&telemetry_path(workspace), &record)
}

fn reviewer_calls<'a>(
    records: &'a [TelemetryRecord],
    session_id: &str,
) -> Vec<&'a ReviewerCallTelemetryRecord> {
    records
        .iter()
        .filter_map(|record| match record {
            TelemetryRecord::Reviewer(value) if value.session_id == session_id => Some(value),
            _ => None,
        })
        .collect()
}

fn known_session_cost(records: &[TelemetryRecord], session_id: &str) -> f64 {
    records
        .iter()
        .filter(|record| record.session_id() == session_id)
        .filter_map(|record| match record {
            TelemetryRecord::Run(value) => value.cost.amount,
            TelemetryRecord::Reviewer(value) if value.status != "blocked" => value.cost.amount,
            _ => None,
        })
        .sum()
}

fn usage_tokens(events: &[ArcEvent]) -> Option<TokenMeasurement> {
    let mut input = 0u64;
    let mut output = 0u64;
    let mut total = 0u64;
    let mut saw_input = false;
    let mut saw_output = false;
    let mut saw_total = false;
    for raw in events.iter().filter_map(|event| event.raw.as_ref()) {
        if let Some(value) = find_number(raw, &input_token_keys()) {
            input += value.max(0.0) as u64;
            saw_input = true;
        }
        if let Some(value) = find_number(raw, &output_token_keys()) {
            output += value.max(0.0) as u64;
            saw_output = true;
        }
        if let Some(value) = find_number(raw, &total_token_keys()) {
            total += value.max(0.0) as u64;
            saw_total = true;
        }
    }
    if !saw_total && (saw_input || saw_output) {
        total = input + output;
        saw_total = true;
    }
    saw_total.then(|| TokenMeasurement {
        input_tokens: saw_input.then_some(input),
        output_tokens: saw_output.then_some(output),
        total_tokens: Some(total),
        source: "provider".to_owned(),
        scope: "session".to_owned(),
    })
}

fn usage_cost(events: &[ArcEvent]) -> Option<CostMeasurement> {
    let amounts = events
        .iter()
        .filter_map(|event| event.raw.as_ref())
        .filter_map(|raw| find_number(raw, &cost_keys()))
        .collect::<Vec<_>>();
    (!amounts.is_empty()).then(|| CostMeasurement {
        amount: Some(amounts.iter().sum()),
        currency: "USD".to_owned(),
        source: "provider".to_owned(),
        scope: "session".to_owned(),
    })
}

fn find_number(value: &Value, keys: &HashSet<String>) -> Option<f64> {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if keys.contains(&normalized_key(key)) {
                    if let Some(number) = value
                        .as_f64()
                        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                    {
                        return Some(number);
                    }
                }
            }
            map.values().find_map(|value| find_number(value, keys))
        }
        Value::Array(items) => items.iter().find_map(|value| find_number(value, keys)),
        _ => None,
    }
}

fn key_set(values: &[&str]) -> HashSet<String> {
    values.iter().map(|value| normalized_key(value)).collect()
}
fn input_token_keys() -> HashSet<String> {
    key_set(&[
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
        "gen_ai.usage.input_tokens",
    ])
}
fn output_token_keys() -> HashSet<String> {
    key_set(&[
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
        "gen_ai.usage.output_tokens",
    ])
}
fn total_token_keys() -> HashSet<String> {
    key_set(&["totalTokens", "total_tokens", "gen_ai.usage.total_tokens"])
}
fn cost_keys() -> HashSet<String> {
    key_set(&[
        "costUsd",
        "cost_usd",
        "totalCostUsd",
        "total_cost_usd",
        "gen_ai.usage.cost_usd",
    ])
}
fn normalized_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn estimated_tokens(events: &[ArcEvent]) -> TokenMeasurement {
    let input = events
        .iter()
        .filter(|event| event.type_ == "user_prompt")
        .filter_map(|event| event.text.as_deref())
        .map(token_estimate)
        .sum();
    let output = events
        .iter()
        .filter(|event| event.type_ == "assistant_message")
        .filter_map(|event| event.text.as_deref())
        .map(token_estimate)
        .sum();
    TokenMeasurement {
        input_tokens: Some(input),
        output_tokens: Some(output),
        total_tokens: Some(input + output),
        source: "estimate".to_owned(),
        scope: "session".to_owned(),
    }
}

fn token_estimate(value: &str) -> u64 {
    ((value.chars().count() + 3) / 4) as u64
}
fn unknown_tokens() -> TokenMeasurement {
    TokenMeasurement {
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        source: "unknown".to_owned(),
        scope: "turn".to_owned(),
    }
}
fn unknown_cost() -> CostMeasurement {
    CostMeasurement {
        amount: None,
        currency: "USD".to_owned(),
        source: "unknown".to_owned(),
        scope: "session".to_owned(),
    }
}

fn run_outcome(events: &[ArcEvent], failed_tools: u64) -> (String, String) {
    let end = events
        .iter()
        .rev()
        .find(|event| event.type_ == "session_end");
    let text = end
        .and_then(|event| event.text.as_deref())
        .unwrap_or("")
        .to_lowercase();
    if text.contains("cancel") || text.contains("abort") {
        return ("cancelled".to_owned(), "session cancelled".to_owned());
    }
    if text.contains("fail") || text.contains("error") {
        return (
            "failed".to_owned(),
            "session ended with failure signal".to_owned(),
        );
    }
    if end.is_some() && failed_tools == 0 {
        return ("success".to_owned(), "session completed".to_owned());
    }
    if failed_tools > 0 {
        return ("failed".to_owned(), "tool failure observed".to_owned());
    }
    (
        "unknown".to_owned(),
        "no terminal outcome signal".to_owned(),
    )
}

fn tool_fingerprint(event: &ArcEvent, session_id: &str) -> String {
    let shape = redact_sensitive(&format!(
        "{}\0{}",
        event.tool_name.as_deref().unwrap_or("tool"),
        event.command.as_deref().unwrap_or("")
    ));
    hash24(&format!(
        "{session_id}\0{}",
        truncate(&collapse_whitespace(&shape), 1000)
    ))
}
fn sanitize_tool_name(value: Option<&str>) -> String {
    sanitize_label(value.unwrap_or("tool"), 80)
}
fn sanitize_label(value: &str, max: usize) -> String {
    redact_sensitive(value)
        .replace(['\n', '\r', '\t'], " ")
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}
fn tool_status(event: &ArcEvent) -> String {
    event
        .tool_status
        .clone()
        .filter(|value| value == "success" || value == "failed")
        .unwrap_or_else(|| {
            event
                .exit_code
                .map(|code| if code == 0 { "success" } else { "failed" }.to_owned())
                .unwrap_or_else(|| "unknown".to_owned())
        })
}
fn duration_between(start: &str, end: &str) -> Option<u64> {
    Some(timestamp_ms(end)?.saturating_sub(timestamp_ms(start)?))
}
fn timestamp_ms(value: &str) -> Option<u64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis().max(0) as u64)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn ms_iso(value: u64) -> String {
    Utc.timestamp_millis_opt(value as i64)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn ratio(value: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        value as f64 / total as f64
    }
}
fn optional_ratio(value: usize, total: usize) -> Option<f64> {
    (total > 0).then(|| ratio(value, total))
}
fn round_money(value: f64) -> f64 {
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    if rounded == 0.0 {
        0.0
    } else {
        rounded
    }
}
fn weak_match_reason(value: &str) -> bool {
    let value = value.to_lowercase();
    ["weak", "below", "no matching", "abstain", "declined"]
        .iter()
        .any(|needle| value.contains(needle))
}
fn stale_rejection_reason(value: &str) -> bool {
    let value = value.to_lowercase();
    value.contains("stale") && value.contains("reject")
}
fn warning(code: &str, message: &str, observed: f64, limit: f64) -> PolicyWarning {
    PolicyWarning {
        code: code.to_owned(),
        message: sanitize_label(message, 500),
        observed,
        limit,
    }
}
fn mixed_source(values: &HashSet<&str>) -> String {
    if values.len() > 1 {
        "mixed".to_owned()
    } else {
        values
            .iter()
            .next()
            .copied()
            .unwrap_or("unknown")
            .to_owned()
    }
}
fn percentiles<I: Iterator<Item = Option<u64>>>(values: I) -> Percentiles {
    let mut values = values.flatten().collect::<Vec<_>>();
    values.sort();
    Percentiles {
        count: values.len(),
        p50: percentile(&values, 0.50),
        p95: percentile(&values, 0.95),
        p99: percentile(&values, 0.99),
    }
}
fn percentile(values: &[u64], value: f64) -> Option<u64> {
    if values.is_empty() {
        None
    } else {
        Some(
            values[((values.len() as f64 * value).ceil() as usize)
                .saturating_sub(1)
                .min(values.len() - 1)],
        )
    }
}
fn record_is_redacted(record: &TelemetryRecord) -> bool {
    serde_json::to_string(record)
        .map(|text| {
            redact_sensitive(&text) == text
                && ![
                    "\"command\":",
                    "\"path\":",
                    "\"prompt\":",
                    "\"output\":",
                    "\"raw\":",
                ]
                .iter()
                .any(|needle| text.contains(needle))
        })
        .unwrap_or(false)
}
fn optional_number(value: Option<&Value>, fallback: Option<f64>) -> Option<f64> {
    match value {
        Some(Value::Null) => None,
        Some(value) => value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= 0.0)
            .or(fallback),
        None => fallback,
    }
}
fn optional_u64(value: Option<&Value>, fallback: Option<u64>) -> Option<u64> {
    match value {
        Some(Value::Null) => None,
        Some(value) => value.as_u64().or(fallback),
        None => fallback,
    }
}
fn env_number(name: &str, fallback: Option<f64>) -> Option<f64> {
    env::var(name)
        .ok()
        .and_then(|value| {
            if matches!(value.as_str(), "off" | "none" | "null") {
                Some(None)
            } else {
                value
                    .parse::<f64>()
                    .ok()
                    .filter(|number| number.is_finite() && *number >= 0.0)
                    .map(Some)
            }
        })
        .unwrap_or(fallback)
}
fn env_u64(name: &str, fallback: Option<u64>) -> Option<u64> {
    env::var(name)
        .ok()
        .and_then(|value| {
            if matches!(value.as_str(), "off" | "none" | "null") {
                Some(None)
            } else {
                value.parse::<u64>().ok().map(Some)
            }
        })
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(type_: &str, timestamp: &str) -> ArcEvent {
        ArcEvent {
            id: generated_id(),
            runner: "copilot".to_owned(),
            session_id: "telemetry-session".to_owned(),
            workspace: "/tmp/telemetry".to_owned(),
            timestamp: timestamp.to_owned(),
            type_: type_.to_owned(),
            source: "test".to_owned(),
            ..ArcEvent::default()
        }
    }

    #[test]
    fn provider_usage_wins_and_the_ledger_omits_trace_content() {
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path();
        let mut prompt = event("user_prompt", "2026-01-01T00:00:00.000Z");
        prompt.text = Some("private prompt".to_owned());
        let mut tool_start = event("tool_start", "2026-01-01T00:00:01.000Z");
        tool_start.tool_name = Some("shell".to_owned());
        tool_start.tool_use_id = Some("call-1".to_owned());
        tool_start.command = Some("curl https://example.invalid --header token=secret".to_owned());
        let mut tool_end = event("tool_end", "2026-01-01T00:00:03.000Z");
        tool_end.tool_name = Some("shell".to_owned());
        tool_end.tool_use_id = Some("call-1".to_owned());
        tool_end.command = tool_start.command.clone();
        tool_end.tool_status = Some("success".to_owned());
        let mut assistant = event("assistant_message", "2026-01-01T00:00:04.000Z");
        assistant.text = Some("private answer".to_owned());
        assistant.raw = Some(json!({
            "usage": { "input_tokens": 7, "output_tokens": 5, "total_tokens": 12, "cost_usd": 0.25 }
        }));
        let end = event("session_end", "2026-01-01T00:00:05.000Z");
        record_run_from_events(
            &[prompt, tool_start, tool_end, assistant, end],
            workspace,
            "telemetry-session",
        )
        .unwrap();

        let text = fs::read_to_string(telemetry_path(workspace)).unwrap();
        assert!(!text.contains("private prompt"));
        assert!(!text.contains("private answer"));
        assert!(!text.contains("example.invalid"));
        assert!(!text.contains("token=secret"));
        let report = build_metrics_report(workspace).unwrap();
        assert_eq!(report.summary.tool_calls, 1);
        assert_eq!(report.summary.tokens.provider, 12);
        assert_eq!(report.summary.tokens.estimated, 0);
        assert_eq!(report.summary.cost.provider_usd, 0.25);
        assert_eq!(report.summary.latency_ms.tool.p50, Some(2_000));
    }

    #[test]
    fn reviewer_hard_call_budget_blocks_before_execution() {
        let workspace = tempfile::tempdir().unwrap();
        let workspace = workspace.path();
        fs::create_dir_all(cache_dir(workspace)).unwrap();
        fs::write(
            telemetry_policy_path(workspace),
            r#"{"reviewer":{"maxCallsPerSession":0}}"#,
        )
        .unwrap();
        let reason = reviewer_budget_reason(workspace, "budget-session")
            .unwrap()
            .unwrap();
        assert!(reason.contains("hard call limit"));
        let records = load_records(workspace).unwrap();
        assert!(
            matches!(&records[0], TelemetryRecord::Reviewer(value) if value.status == "blocked")
        );
    }
}
