use super::*;
use crate::review_capture::CorrectionSignal;

pub(crate) fn run_judge(args: &[String], workspace: &Path) -> Result<()> {
    let json_mode = has_json(args);
    let clean = strip_flag(args, "--json");
    let sub = clean.first().map(String::as_str).unwrap_or("status");
    match sub {
        "models" => {
            let payload = list_judge_models();
            if json_mode {
                write_json(&payload)
            } else {
                let count = payload["models"].as_array().map(Vec::len).unwrap_or(0);
                println!("{count} judge-capable model{}", if count == 1 { "" } else { "s" });
                if let Some(models) = payload["models"].as_array() {
                    for model in models {
                        let provider = model["provider"].as_str().unwrap_or("");
                        let id = model["id"].as_str().unwrap_or("");
                        println!("{provider}:{id}");
                    }
                }
                Ok(())
            }
        }
        "decisions" => {
            let decisions = load_judge_decisions(workspace, parse_limit(&clean)?)?;
            let mut reversed = decisions.clone();
            reversed.reverse();
            if json_mode {
                write_json(&json!({ "total": decisions.len(), "decisions": reversed }))
            } else {
                println!("{} judge decision{}", decisions.len(), if decisions.len() == 1 { "" } else { "s" });
                for decision in reversed.iter().take(20) {
                    let verdict = decision.verdict.inject.as_deref().map(|id| format!("inject {id}")).unwrap_or_else(|| "abstain".to_owned());
                    println!(
                        "{}  {}  {}  {}  {}",
                        decision.timestamp,
                        decision.mode_,
                        verdict,
                        decision.verdict.confidence.map(|v| v.to_string()).unwrap_or_else(|| "?".to_owned()),
                        decision.verdict.reason.clone().unwrap_or_default()
                    );
                }
                Ok(())
            }
        }
        "reputation" => {
            let mut rows: Vec<_> = load_retrieval_reputation(workspace)?.into_iter().collect();
            rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let payload = json!({ "reputation": rows.iter().map(|(capsule_id, multiplier)| json!({ "capsuleId": capsule_id, "multiplier": multiplier })).collect::<Vec<_>>() });
            if json_mode {
                write_json(&payload)
            } else {
                println!("{} capsule reputation signal{}", rows.len(), if rows.len() == 1 { "" } else { "s" });
                for (capsule_id, multiplier) in rows {
                    println!("{capsule_id}  {multiplier:.3}");
                }
                Ok(())
            }
        }
        "set" => {
            let mode = option_value(&clean, "--mode");
            let model = option_value(&clean, "--model").or_else(|| {
                clean
                    .get(1)
                    .filter(|value| !value.starts_with("--"))
                    .map(String::as_str)
            });
            let mut patch = ArcConfigPatch::default();
            if let Some(mode) = mode {
                if mode != "embedding-only" && mode != "provider-judge" {
                    return Err(anyhow!("--mode must be embedding-only or provider-judge"));
                }
                patch.injection_judge_mode = Some(mode.to_owned());
            }
            if let Some(model) = model {
                patch.injection_judge_model = Some(parse_judge_model(model)?);
                if patch.injection_judge_mode.is_none() {
                    patch.injection_judge_mode = Some("provider-judge".to_owned());
                }
            }
            let config = save_arc_config(patch)?;
            if json_mode {
                write_json(&json!({ "configPath": arc_config_path(), "config": config }))
            } else {
                print_judge_config(&config);
                Ok(())
            }
        }
        "status" => {
            let config = load_arc_config()?;
            if json_mode {
                write_json(&json!({ "configPath": arc_config_path(), "config": config }))
            } else {
                print_judge_config(&config);
                Ok(())
            }
        }
        _ => Err(anyhow!("Usage: arc judge [status|models|decisions|reputation|set] [--json] [--mode embedding-only|provider-judge] [--model provider:id]")),
    }
}

pub(crate) fn load_arc_config() -> Result<ArcConfig> {
    let path = arc_config_path();
    if !path.exists() {
        return Ok(ArcConfig {
            version: 1,
            ..ArcConfig::default()
        });
    }
    let raw = fs::read_to_string(path).unwrap_or_default();
    let value = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
    let mut config = ArcConfig {
        version: 1,
        ..ArcConfig::default()
    };
    config.updated_at = value["updatedAt"]
        .as_str()
        .map(clean)
        .filter(|s| !s.is_empty());
    config.sidecar_copilot_command = value["sidecarCopilotCommand"]
        .as_str()
        .map(clean)
        .filter(|s| !s.is_empty());
    config.injection_judge_mode = match value["injectionJudgeMode"].as_str() {
        Some("provider-judge") => Some("provider-judge".to_owned()),
        Some("embedding-only") => Some("embedding-only".to_owned()),
        _ => None,
    };
    config.injection_judge_model = clean_judge_model(value.get("injectionJudgeModel"));
    config.injection_paused_until = value["injectionPausedUntil"]
        .as_str()
        .map(clean)
        .filter(|s| !s.is_empty());
    Ok(config)
}

pub(crate) fn save_arc_config(patch: ArcConfigPatch) -> Result<ArcConfig> {
    let mut config = load_arc_config()?;
    if patch.sidecar_copilot_command.is_some() {
        config.sidecar_copilot_command = patch
            .sidecar_copilot_command
            .map(|v| clean(&v))
            .filter(|v| !v.is_empty());
    }
    if patch.injection_judge_mode.is_some() {
        config.injection_judge_mode = patch.injection_judge_mode;
    }
    if patch.injection_judge_model.is_some() {
        config.injection_judge_model = patch.injection_judge_model;
    }
    if let Some(paused_until) = patch.injection_paused_until {
        config.injection_paused_until = paused_until.map(|v| clean(&v)).filter(|v| !v.is_empty());
    }
    config.version = 1;
    config.updated_at = Some(now_iso());
    write_pretty_json(&arc_config_path(), &config)?;
    Ok(config)
}

fn clean_judge_model(value: Option<&Value>) -> Option<JudgeModel> {
    let value = value?;
    let provider = value["provider"].as_str()?;
    let id = value["id"].as_str().map(clean).filter(|s| !s.is_empty())?;
    if provider == "copilot" || provider == "ollama" {
        Some(JudgeModel {
            provider: provider.to_owned(),
            id,
        })
    } else {
        None
    }
}

pub(crate) fn parse_judge_model(value: &str) -> Result<JudgeModel> {
    let Some((provider, id)) = value.split_once(':') else {
        return Err(anyhow!(
            "--model must be provider:id, for example ollama:gemma4:31b-cloud"
        ));
    };
    if provider != "copilot" && provider != "ollama" || id.trim().is_empty() {
        return Err(anyhow!(
            "--model must be provider:id, for example ollama:gemma4:31b-cloud"
        ));
    }
    Ok(JudgeModel {
        provider: provider.to_owned(),
        id: id.trim().to_owned(),
    })
}

fn print_judge_config(config: &ArcConfig) {
    let mode = config
        .injection_judge_mode
        .as_deref()
        .unwrap_or("embedding-only");
    let model = config
        .injection_judge_model
        .as_ref()
        .map(|model| format!("{}:{}", model.provider, model.id))
        .unwrap_or_else(|| "none".to_owned());
    println!("judge mode: {mode}");
    println!("judge model: {model}");
    println!("config: {}", arc_config_path().display());
}

pub(crate) fn list_judge_models() -> Value {
    let mut models = Vec::new();
    let mut errors = Map::new();
    let embedding_model_pattern =
        Regex::new(r"(?i)\b(?:embed|embedding|nomic-embed|bge|e5|gte)\b").unwrap();
    match list_copilot_models_from_help() {
        Ok(mut rows) => models.append(&mut rows),
        Err(error) => {
            errors.insert("copilot".to_owned(), Value::String(error.to_string()));
        }
    }
    match ureq::get("http://127.0.0.1:11434/api/tags")
        .timeout(Duration::from_secs(2))
        .call()
    {
        Ok(response) => {
            if let Ok(json) = response.into_json::<Value>() {
                if let Some(items) = json["models"].as_array() {
                    for item in items {
                        if let Some(id) = item["name"].as_str() {
                            if !embedding_model_pattern.is_match(id) {
                                models.push(json!({
                                    "provider": "ollama",
                                    "id": id,
                                    "name": id,
                                    "judgeCapable": true,
                                    "costHint": "local",
                                    "sizeHint": ollama_size_hint(id, item["size"].as_u64())
                                }));
                            }
                        }
                    }
                }
            }
        }
        Err(error) => {
            errors.insert("ollama".to_owned(), Value::String(error.to_string()));
        }
    }
    json!({ "generatedAt": now_iso(), "models": models, "errors": errors })
}

fn list_copilot_models_from_help() -> Result<Vec<Value>> {
    let output = Command::new("copilot")
        .args(["help", "config"])
        .output()
        .context("failed to run copilot help config")?;
    if !output.status.success() {
        return Err(anyhow!(
            "copilot help config exited {}",
            output.status.code().unwrap_or(1)
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut in_model_section = false;
    let mut rows = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("`model`:") {
            in_model_section = true;
            continue;
        }
        if in_model_section && trimmed.starts_with('`') && !trimmed.starts_with("`model`:") {
            break;
        }
        if !in_model_section {
            continue;
        }
        let Some(id) = trimmed.strip_prefix("- ") else {
            continue;
        };
        let id = id.trim().trim_matches('"');
        if id.is_empty() || id == "auto" || looks_like_embedder(id) {
            continue;
        }
        rows.push(json!({
            "provider": "copilot",
            "id": id,
            "name": id,
            "judgeCapable": true,
            "sizeHint": copilot_size_hint(id)
        }));
    }
    Ok(rows)
}

fn looks_like_embedder(id: &str) -> bool {
    Regex::new(r"(?i)\b(?:embed|embedding|nomic-embed|bge|e5|gte)\b")
        .unwrap()
        .is_match(id)
}

fn copilot_size_hint(id: &str) -> Option<String> {
    if id.contains("opus") || id.contains("pro") {
        Some("large".to_owned())
    } else if Regex::new(r"(?i)(^|[-_:])(mini|haiku|fable|flash)($|[-_:])")
        .unwrap()
        .is_match(id)
    {
        Some("small".to_owned())
    } else {
        None
    }
}

fn ollama_size_hint(id: &str, bytes: Option<u64>) -> Option<String> {
    if let Some(size) = model_size_from_name(id) {
        return Some(size);
    }
    bytes.map(human_bytes)
}

fn model_size_from_name(id: &str) -> Option<String> {
    Regex::new(r"(?i)(?:^|:|[-_])(\d+(?:\.\d+)?b)(?:$|[-_])")
        .unwrap()
        .captures(id)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_lowercase())
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn load_judge_decisions(workspace: &Path, limit: usize) -> Result<Vec<JudgeDecisionRecord>> {
    let values = read_jsonl_values(&judge_decisions_path(workspace))?;
    let mut order = Vec::new();
    let mut by_id: HashMap<String, JudgeDecisionRecord> = HashMap::new();
    for value in values {
        let Ok(row) = serde_json::from_value::<JudgeDecisionRecord>(value) else {
            continue;
        };
        if row.id.is_empty() || row.timestamp.is_empty() {
            continue;
        }
        if !by_id.contains_key(&row.id) {
            order.push(row.id.clone());
        }
        let merged = if let Some(previous) = by_id.get(&row.id) {
            merge_decision_record(previous.clone(), row)
        } else {
            row
        };
        by_id.insert(merged.id.clone(), merged);
    }
    let mut result = order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect::<Vec<_>>();
    if result.len() > limit {
        result = result.split_off(result.len() - limit);
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_judge_decision(
    workspace: &Path,
    session_id: Option<String>,
    prompt: &str,
    mode: &str,
    model: Option<JudgeModel>,
    candidates: Vec<JudgeCandidate>,
    verdict: JudgeVerdict,
    outcome: Option<JudgeOutcome>,
) -> Result<JudgeDecisionRecord> {
    let record = JudgeDecisionRecord {
        id: generated_id(),
        timestamp: now_iso(),
        workspace: workspace.to_string_lossy().to_string(),
        session_id,
        prompt_hash: hash_prompt(prompt),
        mode_: mode.to_owned(),
        model,
        candidates,
        verdict,
        outcome,
        outcome_reason: None,
    };
    append_jsonl(&judge_decisions_path(workspace), &record)?;
    update_reputation(&record, workspace)?;
    Ok(record)
}

pub(crate) fn reconcile_judge_outcome(
    workspace: &Path,
    session_id: &str,
    packet: &EvidencePacket,
    options: &ReviewOptions,
    result: &ReviewOutcome,
    correction: &CorrectionSignal,
) -> Result<()> {
    if options.judge_decision_ids.is_empty() {
        return Ok(());
    }
    let outcome = infer_injected_outcome(packet, result, correction);
    let reason = result
        .reason
        .clone()
        .unwrap_or_else(|| result.status.clone());
    let updated = record_judge_outcome(
        workspace,
        Some(session_id.to_owned()),
        &options.judge_decision_ids,
        &options.injected_capsule_ids,
        outcome.clone(),
        Some(reason.clone()),
    )?;
    if !updated.is_empty() {
        debug(
            workspace,
            "judge.outcome_reconciled",
            json!({
                "sessionId": session_id,
                "decisionIds": updated.iter().map(|decision| decision.id.clone()).collect::<Vec<_>>(),
                "outcome": outcome,
                "reason": reason
            }),
        )?;
    }
    Ok(())
}

fn infer_injected_outcome(
    packet: &EvidencePacket,
    result: &ReviewOutcome,
    correction: &CorrectionSignal,
) -> JudgeOutcome {
    let reason = result.reason.clone().unwrap_or_default().to_lowercase();
    let has_tool_evidence =
        !packet.tool_events.is_empty() || !packet.commands.is_empty() || !packet.paths.is_empty();
    if !has_tool_evidence
        || Regex::new(r"\b(no typed tool evidence|no captured events|no events)\b")
            .unwrap()
            .is_match(&reason)
    {
        return JudgeOutcome {
            injected: Some(true),
            used: Some("no".to_owned()),
            helped: Some("no".to_owned()),
        };
    }
    if correction.detected
        || packet.outcome.status == "failed"
        || packet.outcome.status == "aborted"
    {
        return JudgeOutcome {
            injected: Some(true),
            used: Some("yes".to_owned()),
            helped: Some("no".to_owned()),
        };
    }
    if result.status == "saved"
        || Regex::new(r"\b(validated existing capsule|already captured|confirmed existing)\b")
            .unwrap()
            .is_match(&reason)
    {
        return JudgeOutcome {
            injected: Some(true),
            used: Some("yes".to_owned()),
            helped: Some(
                if packet.outcome.status == "success" || packet.outcome.status == "partial" {
                    "yes"
                } else {
                    "unknown"
                }
                .to_owned(),
            ),
        };
    }
    JudgeOutcome {
        injected: Some(true),
        used: Some("unknown".to_owned()),
        helped: Some("unknown".to_owned()),
    }
}

fn record_judge_outcome(
    workspace: &Path,
    session_id: Option<String>,
    decision_ids: &[String],
    injected_capsule_ids: &[String],
    outcome: JudgeOutcome,
    reason: Option<String>,
) -> Result<Vec<JudgeDecisionRecord>> {
    let ids = decision_ids
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect::<HashSet<_>>();
    let injected = injected_capsule_ids
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect::<HashSet<_>>();
    let has_ids = !ids.is_empty();
    let has_session = session_id.as_ref().is_some_and(|id| !id.is_empty());
    let mut updated = Vec::new();
    for decision in load_judge_decisions(workspace, 1000)?
        .into_iter()
        .filter(|decision| {
            if ids.contains(&decision.id) {
                return true;
            }
            if has_ids {
                return false;
            }
            if has_session {
                return decision.session_id == session_id;
            }
            decision
                .verdict
                .inject
                .as_ref()
                .is_some_and(|id| injected.contains(id))
        })
        .filter(|decision| decision.mode_ == "provider-judge")
        .filter(|decision| has_unknown_outcome(decision.outcome.as_ref()))
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let verdict = decision.verdict.clone();
        let next = JudgeDecisionRecord {
            id: decision.id,
            timestamp: now_iso(),
            workspace: decision.workspace,
            session_id: decision.session_id,
            prompt_hash: decision.prompt_hash,
            mode_: decision.mode_,
            model: decision.model,
            candidates: decision.candidates,
            verdict: verdict.clone(),
            outcome: Some(JudgeOutcome {
                injected: outcome
                    .injected
                    .or_else(|| decision.outcome.as_ref().and_then(|value| value.injected))
                    .or_else(|| Some(verdict.inject.is_some())),
                used: outcome.used.clone().or_else(|| {
                    decision
                        .outcome
                        .as_ref()
                        .and_then(|value| value.used.clone())
                }),
                helped: outcome.helped.clone().or_else(|| {
                    decision
                        .outcome
                        .as_ref()
                        .and_then(|value| value.helped.clone())
                }),
            }),
            outcome_reason: reason.clone(),
        };
        append_jsonl(&judge_decisions_path(workspace), &next)?;
        update_reputation_from_outcome(&next, workspace)?;
        updated.push(next);
    }
    Ok(updated)
}

fn has_unknown_outcome(outcome: Option<&JudgeOutcome>) -> bool {
    let Some(outcome) = outcome else {
        return true;
    };
    outcome
        .used
        .as_deref()
        .is_none_or(|value| value == "unknown")
        || outcome
            .helped
            .as_deref()
            .is_none_or(|value| value == "unknown")
}

fn merge_decision_record(
    previous: JudgeDecisionRecord,
    next: JudgeDecisionRecord,
) -> JudgeDecisionRecord {
    JudgeDecisionRecord {
        id: next.id,
        timestamp: next.timestamp,
        workspace: next.workspace,
        session_id: next.session_id.or(previous.session_id),
        prompt_hash: if next.prompt_hash.is_empty() {
            previous.prompt_hash
        } else {
            next.prompt_hash
        },
        mode_: if next.mode_.is_empty() {
            previous.mode_
        } else {
            next.mode_
        },
        model: next.model.or(previous.model),
        candidates: if next.candidates.is_empty() {
            previous.candidates
        } else {
            next.candidates
        },
        verdict: if verdict_empty(&next.verdict) {
            previous.verdict
        } else {
            next.verdict
        },
        outcome: merge_outcome(previous.outcome, next.outcome),
        outcome_reason: next.outcome_reason.or(previous.outcome_reason),
    }
}

fn verdict_empty(verdict: &JudgeVerdict) -> bool {
    verdict.inject.is_none()
        && verdict.abstain.is_none()
        && verdict.confidence.is_none()
        && verdict.reason.is_none()
}

fn merge_outcome(
    previous: Option<JudgeOutcome>,
    next: Option<JudgeOutcome>,
) -> Option<JudgeOutcome> {
    match (previous, next) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(left), Some(right)) => Some(JudgeOutcome {
            injected: right.injected.or(left.injected),
            used: right.used.or(left.used),
            helped: right.helped.or(left.helped),
        }),
    }
}

fn update_reputation(record: &JudgeDecisionRecord, workspace: &Path) -> Result<()> {
    let mut state = read_reputation(workspace)?;
    let injected = record.verdict.inject.clone();
    for candidate in &record.candidates {
        let mut item = state
            .capsules
            .remove(&candidate.capsule_id)
            .unwrap_or_else(|| fresh_reputation(&candidate.capsule_id));
        item.score = decay_score(&item);
        item.retrieved += 1;
        item.score += 0.08;
        if Some(candidate.capsule_id.clone()) == injected {
            item.accepted += 1;
            item.score += 0.35 * confidence(record);
            item.pending_reject_prompt_hashes.clear();
        } else if record.verdict.abstain == Some(true) || injected.is_some() {
            if !item
                .pending_reject_prompt_hashes
                .contains(&record.prompt_hash)
            {
                item.pending_reject_prompt_hashes
                    .push(record.prompt_hash.clone());
            }
            if item.pending_reject_prompt_hashes.len() > 8 {
                let drain = item.pending_reject_prompt_hashes.len() - 8;
                item.pending_reject_prompt_hashes.drain(0..drain);
            }
            if item.pending_reject_prompt_hashes.len() >= 2 {
                item.rejected += 1;
                item.score -= 0.2 * confidence(record);
            }
        }
        if record.outcome.as_ref().and_then(|o| o.helped.as_deref()) == Some("yes")
            && Some(candidate.capsule_id.clone()) == injected
        {
            item.helped += 1;
            item.score += 0.6;
        }
        if record.outcome.as_ref().and_then(|o| o.helped.as_deref()) == Some("no")
            && Some(candidate.capsule_id.clone()) == injected
        {
            item.score -= 0.5;
        }
        item.score = clamp(item.score, -3.0, 3.0);
        item.updated_at = record.timestamp.clone();
        state.capsules.insert(candidate.capsule_id.clone(), item);
    }
    write_pretty_json(&retrieval_reputation_path(workspace), &state)
}

fn update_reputation_from_outcome(record: &JudgeDecisionRecord, workspace: &Path) -> Result<()> {
    let Some(capsule_id) = record.verdict.inject.clone() else {
        return Ok(());
    };
    let mut state = read_reputation(workspace)?;
    let mut item = state
        .capsules
        .remove(&capsule_id)
        .unwrap_or_else(|| fresh_reputation(&capsule_id));
    item.score = decay_score(&item);
    if record
        .outcome
        .as_ref()
        .and_then(|outcome| outcome.used.as_deref())
        == Some("yes")
    {
        item.score += 0.25;
    }
    if record
        .outcome
        .as_ref()
        .and_then(|outcome| outcome.used.as_deref())
        == Some("no")
    {
        item.score -= 0.2;
    }
    if record
        .outcome
        .as_ref()
        .and_then(|outcome| outcome.helped.as_deref())
        == Some("yes")
    {
        item.helped += 1;
        item.score += 0.6;
    }
    if record
        .outcome
        .as_ref()
        .and_then(|outcome| outcome.helped.as_deref())
        == Some("no")
    {
        item.score -= 0.5;
    }
    item.score = clamp(item.score, -3.0, 3.0);
    item.updated_at = record.timestamp.clone();
    state.capsules.insert(capsule_id, item);
    write_pretty_json(&retrieval_reputation_path(workspace), &state)
}

pub(crate) fn load_retrieval_reputation(workspace: &Path) -> Result<HashMap<String, f64>> {
    let state = read_reputation(workspace)?;
    Ok(state
        .capsules
        .values()
        .map(|item| {
            (
                item.capsule_id.clone(),
                multiplier_for_score(decay_score(item)),
            )
        })
        .collect())
}

fn read_reputation(workspace: &Path) -> Result<ReputationFile> {
    let path = retrieval_reputation_path(workspace);
    if !path.exists() {
        return Ok(ReputationFile {
            version: 1,
            capsules: HashMap::new(),
        });
    }
    let parsed = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ReputationFile>(&raw).ok())
        .unwrap_or(ReputationFile {
            version: 1,
            capsules: HashMap::new(),
        });
    Ok(ReputationFile {
        version: 1,
        capsules: parsed.capsules,
    })
}

fn fresh_reputation(capsule_id: &str) -> CapsuleReputation {
    CapsuleReputation {
        capsule_id: capsule_id.to_owned(),
        score: 0.0,
        retrieved: 0,
        accepted: 0,
        rejected: 0,
        helped: 0,
        pending_reject_prompt_hashes: Vec::new(),
        updated_at: now_iso(),
    }
}

fn decay_score(item: &CapsuleReputation) -> f64 {
    let Ok(updated) = DateTime::parse_from_rfc3339(&item.updated_at) else {
        return item.score;
    };
    let half_life_ms = reputation_half_life_days() * 24.0 * 60.0 * 60.0 * 1000.0;
    let age = (Utc::now().timestamp_millis() - updated.timestamp_millis()).max(0) as f64;
    item.score * 0.5_f64.powf(age / half_life_ms)
}

fn multiplier_for_score(score: f64) -> f64 {
    clamp(1.0 + score * 0.08, 0.75, 1.25)
}

fn reputation_half_life_days() -> f64 {
    env_number("AGENT_RUN_CACHE_REPUTATION_HALF_LIFE_DAYS", 30.0).max(0.0001)
}

fn confidence(record: &JudgeDecisionRecord) -> f64 {
    record
        .verdict
        .confidence
        .map(|value| clamp(value, 0.0, 1.0))
        .unwrap_or(0.5)
}

pub(crate) fn provider_judge_high_threshold() -> f64 {
    clamp(
        env_number("AGENT_RUN_CACHE_JUDGE_HIGH_THRESHOLD", 0.74),
        embedding_threshold(),
        1.0,
    )
}

pub(crate) fn provider_judge_confidence_threshold() -> f64 {
    clamp(
        env_number("AGENT_RUN_CACHE_JUDGE_CONFIDENCE_THRESHOLD", 0.65),
        0.0,
        1.0,
    )
}
