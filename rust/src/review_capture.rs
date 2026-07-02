use super::*;

pub(crate) fn import_copilot_transcript(
    path: &Path,
    workspace: &Path,
    fallback_session_id: &str,
) -> Result<Vec<ArcEvent>> {
    let events = read_copilot_transcript_events(path, workspace, fallback_session_id)?;
    let session_id = events
        .first()
        .map(|event| event.session_id.clone())
        .unwrap_or_else(|| fallback_session_id.to_owned());
    save_trace_events(&events, &session_id, workspace)?;
    Ok(events)
}

pub(crate) fn import_copilot_otel(
    path: &Path,
    workspace: &Path,
    fallback_session_id: &str,
) -> Result<Vec<ArcEvent>> {
    let events = read_copilot_otel_events(path, workspace, fallback_session_id)?;
    let session_id = events
        .first()
        .map(|event| event.session_id.clone())
        .unwrap_or_else(|| fallback_session_id.to_owned());
    save_trace_events(&events, &session_id, workspace)?;
    debug(
        workspace,
        "otel.imported",
        json!({ "sessionId": session_id, "eventCount": events.len(), "path": path }),
    )?;
    Ok(events)
}

pub(crate) fn harvest_session(session_id: &str, workspace: &Path) -> Result<bool> {
    let transcript = copilot_transcript_path(session_id);
    if !transcript.exists() {
        debug(
            workspace,
            "copilot.transcript_missing",
            json!({ "sessionId": session_id, "transcript": transcript }),
        )?;
        debug(
            workspace,
            "review.skipped",
            json!({ "sessionId": session_id, "reason": "transcript missing", "source": "copilot-transcript" }),
        )?;
        return Ok(false);
    }
    let events = read_copilot_transcript_events(&transcript, workspace, session_id)?;
    if is_arc_sidecar_session(&events) {
        debug(
            workspace,
            "copilot.sidecar_session_skipped",
            json!({ "sessionId": session_id, "eventCount": events.len() }),
        )?;
        debug(
            workspace,
            "review.skipped",
            json!({ "sessionId": session_id, "reason": "arc sidecar session", "source": "copilot-transcript", "eventCount": events.len() }),
        )?;
        return Ok(false);
    }
    save_trace_events(&events, session_id, workspace)?;
    debug(
        workspace,
        "transcript.harvested",
        json!({ "sessionId": session_id, "eventCount": events.len(), "transcript": transcript }),
    )?;
    review_events(&events, workspace, session_id, "auto")?;
    Ok(true)
}

fn copilot_state_dir() -> PathBuf {
    env::var("AGENT_RUN_CACHE_COPILOT_STATE_DIR")
        .map(PathBuf::from)
        .map(absolutize)
        .unwrap_or_else(|_| home_dir().join(".copilot/session-state"))
}

/// Harvest the most recent Copilot session that has not been captured yet.
///
/// `arc split` exits when the user force-closes the zellij session (Ctrl+q),
/// which kills Copilot before it can fire its `SessionEnd` hook. Without this
/// catch-up, a full split session produces no trace. We scan Copilot's session
/// state, newest first, and harvest the first session that lacks a saved trace
/// and is not one of ARC's own sidecar invocations.
pub(crate) fn harvest_latest_session(workspace: &Path) -> Result<Option<String>> {
    let entries = match fs::read_dir(copilot_state_dir()) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };
    let mut sessions: Vec<(std::time::SystemTime, String)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("events.jsonl").exists() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let mtime = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        sessions.push((mtime, id));
    }
    sessions.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, id) in sessions {
        if trace_path(&id, workspace).exists() {
            continue;
        }
        if harvest_session(&id, workspace)? {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn read_copilot_transcript_events(
    path: &Path,
    workspace: &Path,
    fallback_session_id: &str,
) -> Result<Vec<ArcEvent>> {
    let raw_events = read_jsonl_values(path)?;
    if raw_events.iter().all(is_stored_arc_event) {
        return Ok(raw_events
            .iter()
            .enumerate()
            .map(|(index, raw)| {
                normalize_stored_arc_event(raw, index, workspace, fallback_session_id)
            })
            .collect());
    }
    let session_id =
        session_id_from_events(&raw_events).unwrap_or_else(|| fallback_session_id.to_owned());
    Ok(raw_events
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            normalize_copilot_record(raw, index, &session_id, workspace, "copilot-transcript")
        })
        .collect())
}

fn read_copilot_otel_events(
    path: &Path,
    workspace: &Path,
    fallback_session_id: &str,
) -> Result<Vec<ArcEvent>> {
    let records = read_jsonl_values(path)?;
    Ok(normalize_otel_records(
        &records,
        workspace,
        fallback_session_id,
    ))
}

fn normalize_otel_records(
    records: &[Value],
    workspace: &Path,
    fallback_session_id: &str,
) -> Vec<ArcEvent> {
    let spans = records
        .iter()
        .filter(|record| record.get("type").and_then(Value::as_str) == Some("span"))
        .collect::<Vec<_>>();
    let session_id =
        session_id_from_spans(&spans).unwrap_or_else(|| fallback_session_id.to_owned());
    let mut events = Vec::new();
    let mut seen_user_messages = HashSet::new();
    let mut seen_assistant_messages = HashSet::new();
    let mut sequence = 0usize;
    for span in spans {
        let attributes = span
            .get("attributes")
            .filter(|value| value.is_object())
            .unwrap_or(&Value::Null);
        let operation = string_attr(attributes, "gen_ai.operation.name").unwrap_or_default();
        let name = value_string(span.get("name")).unwrap_or_default();
        if operation == "chat" || name.starts_with("chat ") {
            for message in parse_otel_messages(attributes.get("gen_ai.input.messages")) {
                if message.get("role").and_then(Value::as_str) != Some("user") {
                    continue;
                }
                let text = strip_injected_prompt(&otel_message_text(&message));
                if text.is_empty() {
                    continue;
                }
                let key = stable_message_key(&text);
                if !seen_user_messages.insert(key) {
                    continue;
                }
                events.push(ArcEvent {
                    id: format!("{session_id}-otel-{sequence}"),
                    runner: "copilot".to_owned(),
                    session_id: session_id.clone(),
                    workspace: workspace.to_string_lossy().to_string(),
                    timestamp: timestamp_from(span.get("startTime"), sequence + 1),
                    type_: "user_prompt".to_owned(),
                    source: "copilot-otel".to_owned(),
                    text: Some(text.clone()),
                    raw_type: Some(if name.is_empty() {
                        "chat".to_owned()
                    } else {
                        name.clone()
                    }),
                    raw: Some(json!({ "role": "user", "content": text })),
                    ..ArcEvent::default()
                });
                sequence += 1;
            }
            for message in parse_otel_messages(attributes.get("gen_ai.output.messages")) {
                if message.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                let text = otel_message_text(&message);
                if text.is_empty() {
                    continue;
                }
                let key = stable_message_key(&text);
                if !seen_assistant_messages.insert(key) {
                    continue;
                }
                events.push(ArcEvent {
                    id: format!("{session_id}-otel-{sequence}"),
                    runner: "copilot".to_owned(),
                    session_id: session_id.clone(),
                    workspace: workspace.to_string_lossy().to_string(),
                    timestamp: timestamp_from(
                        span.get("endTime").or_else(|| span.get("startTime")),
                        sequence + 1,
                    ),
                    type_: "assistant_message".to_owned(),
                    source: "copilot-otel".to_owned(),
                    text: Some(text.clone()),
                    raw_type: Some(if name.is_empty() {
                        "chat".to_owned()
                    } else {
                        name.clone()
                    }),
                    raw: Some(json!({ "role": "assistant", "content": text })),
                    ..ArcEvent::default()
                });
                sequence += 1;
            }
            continue;
        }
        if operation == "execute_tool" || name.starts_with("execute_tool ") {
            let tool_name = string_attr(attributes, "gen_ai.tool.name")
                .or_else(|| name.strip_prefix("execute_tool ").map(str::to_owned))
                .unwrap_or_default();
            let tool_use_id = string_attr(attributes, "gen_ai.tool.call.id")
                .or_else(|| value_string(span.get("spanId")));
            let argument_text =
                string_attr(attributes, "gen_ai.tool.call.arguments").unwrap_or_default();
            let result_text =
                string_attr(attributes, "gen_ai.tool.call.result").unwrap_or_default();
            let command = command_from_otel_tool(&tool_name, &argument_text);
            let exit_code = exit_code_from_otel_text(&result_text);
            let status_code = span
                .get("status")
                .and_then(|status| status.get("code"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let tool_status = if let Some(code) = exit_code {
                if code == 0 {
                    "success"
                } else {
                    "failed"
                }
            } else if status_code != 0 {
                "failed"
            } else {
                "success"
            };
            let parsed_arguments = parse_json_value(&argument_text)
                .unwrap_or_else(|| Value::String(argument_text.clone()));
            let raw_type = Some(if name.is_empty() {
                "execute_tool".to_owned()
            } else {
                name.clone()
            });
            events.push(ArcEvent {
                id: format!("{session_id}-otel-{sequence}"),
                runner: "copilot".to_owned(),
                session_id: session_id.clone(),
                workspace: workspace.to_string_lossy().to_string(),
                timestamp: timestamp_from(span.get("startTime"), sequence + 1),
                type_: "tool_start".to_owned(),
                source: "copilot-otel".to_owned(),
                tool_name: Some(tool_name.clone()),
                tool_use_id: tool_use_id.clone(),
                command: Some(command.clone()),
                raw_type: raw_type.clone(),
                raw: Some(json!({ "toolName": tool_name, "arguments": parsed_arguments })),
                ..ArcEvent::default()
            });
            sequence += 1;
            events.push(ArcEvent {
                id: format!("{session_id}-otel-{sequence}"),
                runner: "copilot".to_owned(),
                session_id: session_id.clone(),
                workspace: workspace.to_string_lossy().to_string(),
                timestamp: timestamp_from(span.get("endTime").or_else(|| span.get("startTime")), sequence + 1),
                type_: "tool_end".to_owned(),
                source: "copilot-otel".to_owned(),
                tool_name: Some(tool_name.clone()),
                tool_use_id,
                command: Some(command),
                text: Some(truncate(&result_text, 12000)),
                tool_status: Some(tool_status.to_owned()),
                exit_code,
                raw_type,
                raw: Some(json!({
                    "toolName": tool_name,
                    "arguments": parse_json_value(&argument_text).unwrap_or(Value::String(argument_text)),
                    "result": truncate(&result_text, 12000),
                    "status": span.get("status").cloned()
                })),
                ..ArcEvent::default()
            });
            sequence += 1;
        }
    }
    events.sort_by(|left, right| {
        left.timestamp
            .cmp(&right.timestamp)
            .then_with(|| left.id.cmp(&right.id))
    });
    events
}

fn normalize_copilot_record(
    raw: &Value,
    index: usize,
    session_id: &str,
    workspace: &Path,
    source: &str,
) -> ArcEvent {
    let raw_type = value_string(raw.get("type")).unwrap_or_else(|| "unknown".to_owned());
    let data = raw
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(&Value::Null);
    let timestamp = value_string(raw.get("timestamp")).unwrap_or_else(now_iso);
    let mut event = ArcEvent {
        id: value_string(raw.get("id")).unwrap_or_else(|| format!("{session_id}-{index}")),
        runner: "copilot".to_owned(),
        session_id: session_id.to_owned(),
        workspace: workspace.to_string_lossy().to_string(),
        timestamp,
        type_: "unknown".to_owned(),
        source: source.to_owned(),
        raw_type: Some(raw_type.clone()),
        raw: Some(raw.clone()),
        ..ArcEvent::default()
    };
    if raw_type == "session.start" {
        event.type_ = "session_start".to_owned();
        return event;
    }
    if raw_type == "session.shutdown" {
        event.type_ = "session_end".to_owned();
        event.text = Some(truncate(&data.to_string(), 2000));
        return event;
    }
    if raw_type == "assistant.message" {
        event.type_ = "assistant_message".to_owned();
        event.text = Some(text_value(data.get("content")).unwrap_or_default());
        return event;
    }
    if raw_type == "user.message" {
        event.type_ = "user_prompt".to_owned();
        event.text = Some(user_message_text(data));
        return event;
    }
    if raw_type == "hook.start"
        && data.get("hookType").and_then(Value::as_str) == Some("userPromptSubmitted")
    {
        if let Some(prompt) = data
            .get("input")
            .and_then(|input| input.get("prompt"))
            .and_then(Value::as_str)
        {
            event.type_ = "user_prompt".to_owned();
            event.text = Some(prompt.to_owned());
            return event;
        }
    }
    let tool_name = text_value(data.get("toolName"))
        .or_else(|| text_value(data.get("name")))
        .or_else(|| text_value(data.get("command")))
        .unwrap_or_default();
    let command = command_from(data);
    if raw_type.contains("tool")
        && (!tool_name.is_empty() || !command.is_empty() || raw_type.contains("complete"))
    {
        let complete = raw_type.contains("end") || raw_type.contains("complete");
        let result_text = text_value(data.get("result"))
            .or_else(|| text_value(data.get("toolResult")))
            .unwrap_or_else(|| truncate(&data.to_string(), 3000));
        let exit_code = exit_code_from_text(&result_text);
        let success = data.get("success").and_then(Value::as_bool);
        let tool_status = if let Some(code) = exit_code {
            if code == 0 {
                "success"
            } else {
                "failed"
            }
        } else if success == Some(false) {
            "failed"
        } else if success == Some(true) {
            "success"
        } else {
            "unknown"
        };
        event.type_ = if complete { "tool_end" } else { "tool_start" }.to_owned();
        event.tool_name = Some(if tool_name.is_empty() {
            "tool".to_owned()
        } else {
            tool_name
        });
        event.tool_use_id = text_value(data.get("toolUseId"))
            .or_else(|| text_value(data.get("toolCallId")))
            .or_else(|| text_value(data.get("id")))
            .or_else(|| text_value(data.get("callId")))
            .filter(|value| !value.is_empty());
        event.command = if command.is_empty() {
            None
        } else {
            Some(command)
        };
        event.text = Some(if complete {
            result_text
        } else {
            truncate(&data.to_string(), 3000)
        });
        event.tool_status = Some(tool_status.to_owned());
        event.exit_code = exit_code;
        return event;
    }
    event.text = Some(truncate(&data.to_string(), 1000));
    event
}

fn normalize_stored_arc_event(
    raw: &Value,
    index: usize,
    workspace: &Path,
    fallback_session_id: &str,
) -> ArcEvent {
    let session_id =
        value_string(raw.get("sessionId")).unwrap_or_else(|| fallback_session_id.to_owned());
    let event_type = value_string(raw.get("type"))
        .filter(|value| is_arc_event_type(value))
        .unwrap_or_else(|| "unknown".to_owned());
    if event_type == "unknown" {
        if let Some(upgraded_raw) = raw.get("raw").filter(|value| value.is_object()) {
            let mut upgraded = normalize_copilot_record(
                upgraded_raw,
                index,
                &session_id,
                workspace,
                "copilot-transcript",
            );
            if upgraded.type_ != "unknown" {
                if let Some(id) = value_string(raw.get("id")) {
                    upgraded.id = id;
                }
                if let Some(timestamp) = value_string(raw.get("timestamp")) {
                    upgraded.timestamp = timestamp;
                }
                return upgraded;
            }
        }
    }
    ArcEvent {
        id: value_string(raw.get("id")).unwrap_or_else(|| format!("{session_id}-{index}")),
        runner: "copilot".to_owned(),
        session_id,
        workspace: workspace.to_string_lossy().to_string(),
        timestamp: value_string(raw.get("timestamp")).unwrap_or_else(now_iso),
        type_: event_type,
        source: value_string(raw.get("source")).unwrap_or_else(|| "copilot-transcript".to_owned()),
        text: value_string(raw.get("text")),
        tool_name: value_string(raw.get("toolName")),
        tool_use_id: value_string(raw.get("toolUseId")),
        command: value_string(raw.get("command")),
        path: value_string(raw.get("path")),
        tool_status: value_string(raw.get("toolStatus"))
            .filter(|value| matches!(value.as_str(), "success" | "failed" | "unknown")),
        exit_code: raw.get("exitCode").and_then(Value::as_i64),
        raw_type: value_string(raw.get("rawType")),
        raw: raw.get("raw").cloned(),
    }
}

pub(crate) fn review_events(
    events: &[ArcEvent],
    workspace: &Path,
    fallback_session_id: &str,
    intent: &str,
) -> Result<ReviewOutcome> {
    let session_id = events
        .first()
        .map(|event| event.session_id.clone())
        .unwrap_or_else(|| fallback_session_id.to_owned());
    if is_arc_sidecar_session(events) {
        debug(
            workspace,
            "review.skipped",
            json!({ "sessionId": session_id, "reason": "arc sidecar session", "eventCount": events.len() }),
        )?;
        return Ok(ReviewOutcome {
            status: "skipped".to_owned(),
            reason: Some("arc sidecar session".to_owned()),
            capsule_ids: Vec::new(),
        });
    }
    if events.is_empty() || session_id == "unknown" {
        debug(
            workspace,
            "review.skipped",
            json!({ "reason": "no events or session id", "eventCount": events.len() }),
        )?;
        return Ok(ReviewOutcome {
            status: "skipped".to_owned(),
            reason: Some("no events or session id".to_owned()),
            capsule_ids: Vec::new(),
        });
    }
    if let Some(reviewed) = already_reviewed(&session_id, workspace)? {
        debug(
            workspace,
            "review.skipped",
            json!({ "sessionId": session_id, "reason": "already reviewed", "status": reviewed.status, "eventCount": reviewed.event_count }),
        )?;
        return Ok(outcome_from_review(&reviewed));
    }
    match review_events_unlocked(events, workspace, &session_id, intent) {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            let _ = record_review(
                workspace,
                ReviewRecord {
                    session_id,
                    workspace: workspace.to_string_lossy().to_string(),
                    trace_hash: trace_hash(events),
                    event_count: events.len(),
                    status: "failed".to_owned(),
                    capsule_id: None,
                    reason: Some(error.to_string()),
                    turn_id: None,
                    rejection_path: None,
                    runner_status: None,
                    injected_capsule_ids: None,
                    created_at: now_iso(),
                },
            );
            Err(error)
        }
    }
}

fn review_events_unlocked(
    events: &[ArcEvent],
    workspace: &Path,
    session_id: &str,
    intent: &str,
) -> Result<ReviewOutcome> {
    let packet = build_evidence_packet(events, workspace, session_id);
    let hash = trace_hash(events);
    let correction = correction_signal(events);
    let options = review_options_for_session(events, workspace, session_id)?;
    let review_input = strong_review_input(&packet, intent)?;
    let recurrence = recurrence_context(&review_input, workspace, session_id)?;
    debug(
        workspace,
        "review.queued",
        json!({ "sessionId": session_id, "eventCount": events.len(), "outcome": packet.outcome.status }),
    )?;
    if !options.injected_capsule_ids.is_empty() {
        debug(
            workspace,
            "review.injected_context",
            json!({ "sessionId": session_id, "injectedCapsuleIds": options.injected_capsule_ids }),
        )?;
    }
    let review = review_packet(
        &packet,
        &review_input,
        workspace,
        intent,
        &options,
        recurrence.as_ref(),
    )?;
    let capsule_inputs = review_capsules(review.as_ref());
    let outcome_allowed_capsules = capsule_inputs
        .iter()
        .filter(|capsule| capsule_allowed_for_outcome(capsule, &packet.outcome.status))
        .cloned()
        .collect::<Vec<_>>();
    let action_risk_allowed_capsules = outcome_allowed_capsules
        .iter()
        .filter(|capsule| capsule_allowed_for_action_risk(capsule, &options))
        .cloned()
        .collect::<Vec<_>>();
    let action_risk_allowed_count = action_risk_allowed_capsules.len();
    let saveable = if correction.detected {
        action_risk_allowed_capsules
            .iter()
            .filter(|capsule| capsule_allowed_for_correction(capsule))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        action_risk_allowed_capsules.clone()
    };
    let rejected = capsule_inputs
        .len()
        .saturating_sub(outcome_allowed_capsules.len());
    let action_risk_rejected = outcome_allowed_capsules
        .len()
        .saturating_sub(action_risk_allowed_count);
    let correction_rejected = if correction.detected {
        action_risk_allowed_count.saturating_sub(saveable.len())
    } else {
        0
    };
    if rejected > 0 {
        debug(
            workspace,
            "review.capsules_rejected",
            json!({ "sessionId": session_id, "rejected": rejected, "outcome": packet.outcome.status }),
        )?;
        record_memory_event(
            workspace,
            "capsule.rejected",
            Some(session_id.to_owned()),
            None,
            None,
            Some(
                json!({ "reason": "review outcome gate", "rejected": rejected, "outcome": packet.outcome.status }),
            ),
        )?;
    }
    if action_risk_rejected > 0 {
        debug(
            workspace,
            "review.capsules_rejected",
            json!({ "sessionId": session_id, "rejected": action_risk_rejected, "actionRisk": options.action_risk }),
        )?;
        record_memory_event(
            workspace,
            "capsule.rejected",
            Some(session_id.to_owned()),
            None,
            None,
            Some(json!({
                "reason": "action-risk consult abstention blocked broad action capsule",
                "rejected": action_risk_rejected,
                "actionRisk": options.action_risk,
                "consultApplied": options.consult_applied,
                "consultCapsuleId": options.consult_capsule_id,
                "consultAbstainReason": options.consult_abstain_reason
            })),
        )?;
    }
    if correction_rejected > 0 {
        debug(
            workspace,
            "review.capsules_rejected",
            json!({ "sessionId": session_id, "rejected": correction_rejected, "correctionSignal": true }),
        )?;
        record_memory_event(
            workspace,
            "capsule.rejected",
            Some(session_id.to_owned()),
            None,
            None,
            Some(json!({
                "reason": "correction signal requires caution or project-fact capture",
                "rejected": correction_rejected,
                "correctionSignal": true,
                "correctionReasons": correction.reasons.clone()
            })),
        )?;
    }
    if !saveable.is_empty() {
        let mut saved = Vec::new();
        for mut capsule_value in saveable {
            if let Some(map) = capsule_value.as_object_mut() {
                map.insert(
                    "sourceSessionId".to_owned(),
                    Value::String(session_id.to_owned()),
                );
                map.insert(
                    "workspace".to_owned(),
                    Value::String(workspace.to_string_lossy().to_string()),
                );
                map.insert("runner".to_owned(), Value::String(packet.runner.clone()));
                map.insert(
                    "outcomeStatus".to_owned(),
                    Value::String(packet.outcome.status.clone()),
                );
                if let Some(recurrence) = recurrence.as_ref() {
                    add_recurrence_provenance(map, recurrence, session_id);
                }
            }
            let capsule: Capsule = serde_json::from_value(capsule_value)?;
            if let Some(saved_capsule) = save_capsule(capsule, workspace)? {
                let _ = ensure_embeddings_for_capsules(vec![saved_capsule.clone()], workspace);
                saved.push(saved_capsule.id);
            }
        }
        if saved.is_empty() {
            let reason = "review proposed no persistable capsules";
            record_review(
                workspace,
                review_record(
                    session_id,
                    workspace,
                    &hash,
                    events.len(),
                    "no_capsule",
                    None,
                    Some(reason),
                ),
            )?;
            debug(
                workspace,
                "sidecar.no_capsule",
                json!({ "sessionId": session_id, "reason": reason }),
            )?;
            record_memory_event(
                workspace,
                "capsule.rejected",
                Some(session_id.to_owned()),
                None,
                None,
                Some(
                    json!({ "reason": reason, "outcome": packet.outcome.status, "eventCount": events.len() }),
                ),
            )?;
            record_declined_draft(
                workspace,
                &review_input,
                session_id,
                &packet.outcome.status,
                reason,
            )?;
            let result = ReviewOutcome {
                status: "no_capsule".to_owned(),
                reason: Some(reason.to_owned()),
                capsule_ids: Vec::new(),
            };
            reconcile_judge_outcome(
                workspace,
                session_id,
                &packet,
                &options,
                &result,
                &correction,
            )?;
            return Ok(result);
        }
        record_review(
            workspace,
            review_record(
                session_id,
                workspace,
                &hash,
                events.len(),
                "saved",
                Some(saved.join(",")),
                None,
            ),
        )?;
        record_memory_event(
            workspace,
            "capsule.finalized",
            Some(session_id.to_owned()),
            None,
            None,
            Some(
                json!({ "capsuleIds": saved, "eventCount": events.len(), "outcome": packet.outcome.status }),
            ),
        )?;
        let result = ReviewOutcome {
            status: "saved".to_owned(),
            reason: None,
            capsule_ids: saved,
        };
        reconcile_judge_outcome(
            workspace,
            session_id,
            &packet,
            &options,
            &result,
            &correction,
        )?;
        return Ok(result);
    }
    let review_reason = review
        .as_ref()
        .and_then(|value| value.get("reason"))
        .and_then(Value::as_str);
    let reason = if action_risk_rejected > 0 {
        "action-risk consult abstention blocked broad action capsule".to_owned()
    } else if correction_rejected > 0 {
        "correction signal requires caution or project-fact capture".to_owned()
    } else if correction.detected && plain_validation_reason(review_reason) {
        "correction signal cannot be recorded as plain validation".to_owned()
    } else {
        review_reason.unwrap_or("no review").to_owned()
    };
    record_review(
        workspace,
        review_record(
            session_id,
            workspace,
            &hash,
            events.len(),
            "no_capsule",
            None,
            Some(&reason),
        ),
    )?;
    debug(
        workspace,
        "sidecar.no_capsule",
        json!({ "sessionId": session_id, "reason": reason }),
    )?;
    record_memory_event(
        workspace,
        "capsule.rejected",
        Some(session_id.to_owned()),
        None,
        None,
        Some(json!({
            "reason": reason,
            "outcome": packet.outcome.status,
            "eventCount": events.len(),
            "correctionSignal": if correction.detected { Some(true) } else { None },
            "correctionReasons": if correction.detected { Some(correction.reasons.clone()) } else { None }
        })),
    )?;
    record_declined_draft(
        workspace,
        &review_input,
        session_id,
        &packet.outcome.status,
        &reason,
    )?;
    let result = ReviewOutcome {
        status: "no_capsule".to_owned(),
        reason: Some(reason),
        capsule_ids: Vec::new(),
    };
    reconcile_judge_outcome(
        workspace,
        session_id,
        &packet,
        &options,
        &result,
        &correction,
    )?;
    Ok(result)
}

fn review_packet(
    packet: &EvidencePacket,
    review_input: &Value,
    workspace: &Path,
    intent: &str,
    options: &ReviewOptions,
    recurrence: Option<&ReviewRecurrence>,
) -> Result<Option<Value>> {
    if intent == "auto" && recurrence.is_none() {
        if let Some(gated) = review_gate_from_observer(packet, workspace)? {
            return Ok(Some(gated));
        }
    }
    let original_packet = serde_json::to_value(packet)?;
    let existing_capsules =
        review_candidate_capsules(&original_packet, workspace, &options.injected_capsule_ids)?;
    let review_context = review_context_from_options(options, recurrence);
    if let Ok(command) = env::var("AGENT_RUN_CACHE_REVIEWER_COMMAND") {
        if !command.trim().is_empty() {
            let command_input = review_context
                .as_ref()
                .map(|context| review_input_with_context(review_input, context))
                .unwrap_or_else(|| review_input.clone());
            let input = serde_json::to_string(&command_input)?;
            let output = run_shell_command(&command, &input)?;
            let parsed = extract_json_object(&output)?;
            record_sidecar_exchange(workspace, "review", "command", &input, &output, &parsed)?;
            debug(
                workspace,
                "sidecar.review.command",
                json!({ "bytes": output.len() }),
            )?;
            return Ok(Some(parsed));
        }
    }
    if model_sidecar_setting()? == "off" {
        debug(
            workspace,
            "sidecar.review.skipped",
            json!({ "reason": "AGENT_RUN_CACHE_MODEL_SIDECAR=off" }),
        )?;
        return Ok(None);
    }
    let Some(runner) = sidecar_runner_for(&packet.runner)? else {
        let reason = format!(
            "strong review skipped: no same-runner model sidecar is configured for {}",
            packet.runner
        );
        debug(
            workspace,
            "sidecar.review.skipped",
            json!({ "reason": reason, "packetRunner": packet.runner, "modelSidecar": env::var("AGENT_RUN_CACHE_MODEL_SIDECAR").unwrap_or_else(|_| "auto".to_owned()) }),
        )?;
        return Ok(Some(json!({ "shouldSave": false, "reason": reason })));
    };
    let prompt = review_prompt(review_input, &existing_capsules, review_context.as_ref());
    let output = run_model_sidecar(&prompt, workspace, &runner)?;
    let parsed = extract_json_object(&output)?;
    record_sidecar_exchange(workspace, "review", &runner, &prompt, &output, &parsed)?;
    debug(
        workspace,
        &format!("sidecar.review.{runner}"),
        json!({ "bytes": output.len() }),
    )?;
    Ok(Some(parsed))
}

fn review_input_with_context(review_input: &Value, review_context: &Value) -> Value {
    let mut next = review_input.clone();
    if let Value::Object(map) = &mut next {
        map.insert("reviewContext".to_owned(), review_context.clone());
    }
    next
}

fn review_context_from_options(
    options: &ReviewOptions,
    recurrence: Option<&ReviewRecurrence>,
) -> Option<Value> {
    let mut map = Map::new();
    optional_insert(
        &mut map,
        "consultApplied",
        options.consult_applied.map(Value::Bool),
    );
    optional_insert(
        &mut map,
        "consultCapsuleId",
        options.consult_capsule_id.clone().map(Value::String),
    );
    optional_insert(
        &mut map,
        "consultAbstainReason",
        options.consult_abstain_reason.clone().map(Value::String),
    );
    optional_insert(
        &mut map,
        "actionRisk",
        options.action_risk.clone().map(Value::String),
    );
    if !options.injected_capsule_ids.is_empty() {
        map.insert(
            "injectedCapsuleIds".to_owned(),
            json!(options.injected_capsule_ids),
        );
    }
    if !options.judge_decision_ids.is_empty() {
        map.insert(
            "judgeDecisionIds".to_owned(),
            json!(options.judge_decision_ids),
        );
    }
    if let Some(recurrence) = recurrence {
        map.insert(
            "recurrence".to_owned(),
            json!({
                "mergeKey": recurrence.merge_key,
                "recurrenceCount": recurrence.count,
                "priorDeclineReason": recurrence.prior_reason,
                "priorSessionIds": recurrence.prior_session_ids
            }),
        );
    }
    (!map.is_empty()).then_some(Value::Object(map))
}

#[derive(Debug, Clone)]
struct ReviewRecurrence {
    merge_key: String,
    count: usize,
    prior_reason: String,
    prior_session_ids: Vec<String>,
}

fn strong_review_input(packet: &EvidencePacket, intent: &str) -> Result<Value> {
    if intent != "auto"
        || env::var("AGENT_RUN_CACHE_REVIEW_FULL_PACKET")
            .ok()
            .as_deref()
            == Some("1")
    {
        return Ok(serde_json::to_value(packet)?);
    }
    let source_event_ids = packet
        .tool_events
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();
    let mut goal_hash_parts = vec![packet.session_id.clone(), packet.event_count.to_string()];
    goal_hash_parts.extend(source_event_ids.clone());
    Ok(json!({
        "packetKind": "assembled_draft",
        "runner": packet.runner,
        "sessionId": packet.session_id,
        "workspace": packet.workspace,
        "createdAt": now_iso(),
        "goalId": &sha256_hex(&goal_hash_parts.join("\n"))[..12],
        "mergeKey": draft_merge_key(packet),
        "span": {
            "startEventId": source_event_ids.first(),
            "endEventId": source_event_ids.last(),
            "eventCount": packet.event_count
        },
        "goal": packet.prompts.last().cloned().unwrap_or_default(),
        "prompts": packet.prompts.iter().rev().take(5).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
        "evidenceSnippets": evidence_snippets_from_packet(packet),
        "commands": packet.commands,
        "parameters": unique_strings(
            packet.paths
                .iter()
                .cloned()
                .chain(packet.prompts.iter().flat_map(|prompt| parameter_hints_from_prompt(prompt)))
                .collect()
        ).into_iter().take(24).collect::<Vec<_>>(),
        "paths": packet.paths,
        "outcome": packet.outcome,
        "observations": [],
        "sourceEventIds": source_event_ids
    }))
}

fn draft_merge_key(packet: &EvidencePacket) -> String {
    let source = if packet.commands.iter().any(|value| !value.trim().is_empty()) {
        packet
            .commands
            .iter()
            .rev()
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
    } else {
        packet
            .prompts
            .iter()
            .rev()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
    };
    let normalized = source
        .into_iter()
        .rev()
        .map(|value| {
            let portable = portable_snippet_text(&redact_sensitive(&value), &packet.workspace);
            portable
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if normalized.is_empty() {
        String::new()
    } else {
        format!("draft:{}", &sha256_hex(&normalized)[..20])
    }
}

fn recurrence_context(
    review_input: &Value,
    workspace: &Path,
    session_id: &str,
) -> Result<Option<ReviewRecurrence>> {
    let merge_key = review_input
        .get("mergeKey")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if merge_key.is_empty() {
        return Ok(None);
    }
    let mut prior_session_ids = Vec::new();
    let mut seen = HashSet::new();
    let mut prior_reason = String::new();
    for value in read_jsonl_values(&declined_path(workspace))? {
        let Ok(record) = serde_json::from_value::<DeclinedDraftRecord>(value) else {
            continue;
        };
        if record.merge_key != merge_key
            || record.session_id == session_id
            || !seen.insert(record.session_id.clone())
        {
            continue;
        }
        prior_reason = record.reason;
        prior_session_ids.push(record.session_id);
    }
    if prior_session_ids.is_empty() {
        return Ok(None);
    }
    Ok(Some(ReviewRecurrence {
        merge_key: merge_key.to_owned(),
        count: prior_session_ids.len() + 1,
        prior_reason,
        prior_session_ids,
    }))
}

fn review_prompt(
    packet: &Value,
    existing_capsules: &[Capsule],
    review_context: Option<&Value>,
) -> String {
    if packet.get("packetKind").and_then(Value::as_str) == Some("assembled_draft") {
        return assembled_draft_review_prompt(packet, existing_capsules, review_context);
    }
    let context_block = review_context_prompt_block(review_context);
    format!(
        r#"You are the Agent Run Cache sidecar.

Your job is to decide whether a completed coding-agent session produced one or more reusable workflow capsules.
Return JSON only. Do not include Markdown.

Rules:
- Save only if the session shows a reusable method, route, script, command sequence, resolver, or project fact that would help a future similar session.
- Use packet.outcome. A failed or aborted session must not become a positive workflow. For failed sessions, save only project facts, cautions, or dead ends unless the evidence clearly shows a later verified successful recovery.
- Never cite a failed tool/read as positive evidence, provenance, reusable command, validation proof, or successful binding source. Failed reads belong in failureBoundary or workflow.failedAttempts, unless the capsule is explicitly about the missing/failed artifact.
- The capsule must stand alone. If the user supplied a markdown/runbook/script file, treat that file as provenance; infer the reusable method so a teammate without the file can still benefit.
- Provide a stable mergeKey for the reusable method. The same method with different targets, files, branches, or commands should reuse the same mergeKey when the workflow shape is the same.
- Use artifactSources for user-supplied runbooks/scripts whose extracted content may be useful later. Use workflow.bindingSources only for current files/configs/tools that must be verified fresh.
- Use repository-relative paths for bindingSources, provenance, artifactSources, validation probes, and instructions when a path is inside the current workspace.
- Do not copy secrets. If a command contains credentials, describe the parameter instead.
- Do not copy private IPs, MAC addresses, token values, personal home paths, or full remote URLs. Use stable placeholders such as <private-ip>, <mac-address>, <token>, <home>, and <url>.
- Do not merge unrelated work. If the packet contains distinct useful episodes, return multiple capsules. If it contains one useful method, return one capsule.
- If the session corrected an earlier bad route, set supersedes or failureBoundary so retrieval can prefer the corrected route and avoid the dead end.
- Fill validationProvenance with how the work was checked: local test, syntax only, CI image, remote health check, manual SSH verification, not verified, or similar.
- For SSH, SCP, rsync, Docker, or other remote-operation workflows, capture bounded noninteractive probes and timeouts when the evidence supports them. Treat password prompts, hung commands, transient refused connections, and shell quoting failures as failedAttempts or failureBoundary evidence.
- Code outside you will only validate JSON, store it, and budget context. You own the semantic decision.

Return this JSON shape:
{{
  "shouldSave": true,
  "capsules": [
    {{
      "title": "short title",
      "kind": "workflow | command | project_fact | runbook",
      "mergeKey": "stable workflow identity, not a one-off target name",
      "summary": "what was learned",
      "reusable": true,
      "confidence": 0.0,
      "reuseWhen": ["when future prompt/context matches"],
      "doNotReuseWhen": ["when it should stay silent"],
      "evidence": ["concrete proof from the trace"],
      "provenance": ["files or artifacts that informed the workflow"],
      "artifactSources": ["source files/runbooks/scripts whose useful content was extracted, if any"],
      "supersedes": ["ids or stable names of weaker/failed capsules this replaces, if known"],
      "confidenceReason": "why the confidence score is justified",
      "failureBoundary": ["where this should not be generalized or which failure it avoids"],
      "validationProvenance": ["how the trace verified the result"],
      "outcomeStatus": "success | partial | failed | aborted | unknown",
      "nextRunInstruction": "compact instruction to give the next agent first",
      "workflow": {{
        "purpose": "what this workflow accomplishes",
        "parameters": ["values to resolve fresh next time"],
        "bindingSources": ["files/configs/tools to inspect fresh if needed"],
        "steps": ["ordered reusable steps"],
        "commands": ["reusable command shapes with placeholders if needed"],
        "successCriteria": ["how to know it worked"],
        "failedAttempts": ["dead ends to avoid"],
        "validationProbe": ["smallest cheap check before reuse"]
      }}
    }}
  ],
  "capsule": {{
    "title": "short title",
    "kind": "workflow | command | project_fact | runbook",
    "mergeKey": "stable workflow identity, not a one-off target name",
    "summary": "what was learned",
    "reusable": true,
    "confidence": 0.0,
    "reuseWhen": ["when future prompt/context matches"],
    "doNotReuseWhen": ["when it should stay silent"],
    "evidence": ["concrete proof from the trace"],
    "provenance": ["files or artifacts that informed the workflow"],
    "artifactSources": ["source files/runbooks/scripts whose useful content was extracted, if any"],
    "supersedes": ["ids or stable names of weaker/failed capsules this replaces, if known"],
    "confidenceReason": "why the confidence score is justified",
    "failureBoundary": ["where this should not be generalized or which failure it avoids"],
    "validationProvenance": ["how the trace verified the result"],
    "outcomeStatus": "success | partial | failed | aborted | unknown",
    "nextRunInstruction": "compact instruction to give the next agent first",
    "workflow": {{
      "purpose": "what this workflow accomplishes",
      "parameters": ["values to resolve fresh next time"],
      "bindingSources": ["files/configs/tools to inspect fresh if needed"],
      "steps": ["ordered reusable steps"],
      "commands": ["reusable command shapes with placeholders if needed"],
      "successCriteria": ["how to know it worked"],
      "failedAttempts": ["dead ends to avoid"],
      "validationProbe": ["smallest cheap check before reuse"]
    }}
  }}
}}

Use "capsules" for new output. "capsule" is accepted only for backward compatibility.
If nothing durable was learned, return {{"shouldSave": false, "reason": "..."}}.
{}{}

Evidence packet:
{}"#,
        existing_capsule_context(existing_capsules),
        context_block,
        truncate(&serde_json::to_string(packet).unwrap_or_default(), 60000)
    )
}

fn review_context_prompt_block(review_context: Option<&Value>) -> String {
    let Some(context) = review_context else {
        return String::new();
    };
    let mut block = format!(
        "\nARC review context from pre-turn retrieval:\n{}\nIf actionRisk is present, do not save a broad live-action capsule from this turn. Save only a narrow interpretation, caution, or project fact unless the trace also shows explicit live-action intent and successful validation.\n",
        truncate(&serde_json::to_string(context).unwrap_or_default(), 2000)
    );
    if let Some(recurrence) = context.get("recurrence") {
        let count = recurrence
            .get("recurrenceCount")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let reason = recurrence
            .get("priorDeclineReason")
            .and_then(Value::as_str)
            .unwrap_or("no reason recorded");
        block.push_str(&format!(
            "This method has been observed {count} times across sessions (previously declined: {}). Recurrence is evidence of reusability; prefer saving with provenance noting both sessions. You still own the save or decline decision.\n",
            truncate(reason, 500)
        ));
    }
    block
}

fn assembled_draft_review_prompt(
    packet: &Value,
    existing_capsules: &[Capsule],
    review_context: Option<&Value>,
) -> String {
    let context_block = review_context_prompt_block(review_context);
    format!(
        r#"You are the Agent Run Cache sidecar.

ARC's local loop assembled this draft at a goal boundary. The draft is not a capsule and it is not authoritative prose; it is a compact evidence object made from typed events and local observations.

Your job is to decide whether the completed goal produced one or more reusable workflow capsules.
Return JSON only. Do not include Markdown.

Rules:
- Save only if the draft shows a reusable method, route, command shape, resolver, project fact, caution, or dead end that would help a future similar session.
- The local loop is not allowed to author capsules. You own the durable save/decline and capsule prose.
- Treat commands as verbatim observed commands. Do not invent commands, paths, tools, or validation that are not present in the draft.
- Use packet.outcome. A failed or aborted goal must not become a positive workflow. For failed goals, save only project facts, cautions, or dead ends unless the evidence clearly shows a later verified successful recovery.
- Never cite a failed tool/read as positive evidence, provenance, reusable command, validation proof, or successful binding source. Failed reads belong in failureBoundary or workflow.failedAttempts, unless the capsule is explicitly about the missing/failed artifact.
- The capsule must stand alone. If the user supplied a markdown/runbook/script file, treat that file as provenance; infer the reusable method so a teammate without the file can still benefit.
- Provide a stable mergeKey for the reusable method. The same method with different targets, files, branches, or commands should reuse the same mergeKey when the workflow shape is the same.
- Prefer extending or superseding an existing workflow over minting a parallel project_fact that restates the same method.
- Use artifactSources for user-supplied runbooks/scripts whose useful content may be useful later. Use workflow.bindingSources only for current files/configs/tools that must be verified fresh.
- Use repository-relative paths for bindingSources, provenance, artifactSources, validation probes, and instructions when a path is inside the current workspace.
- Do not copy secrets. If a command contains credentials, describe the parameter instead.
- Do not copy private IPs, MAC addresses, token values, personal home paths, or full remote URLs. Use stable placeholders such as <private-ip>, <mac-address>, <token>, <home>, and <url>.
- If nothing durable was learned, return {{"shouldSave": false, "reason": "..."}}.
{}{}

Return the same JSON shape as normal ARC reviews:
{{
  "shouldSave": true,
  "capsules": [
    {{
      "title": "short title",
      "kind": "workflow | command | project_fact | runbook",
      "mergeKey": "stable workflow identity, not a one-off target name",
      "summary": "what was learned",
      "reusable": true,
      "confidence": 0.0,
      "reuseWhen": ["when future prompt/context matches"],
      "doNotReuseWhen": ["when it should stay silent"],
      "evidence": ["concrete proof from the trace"],
      "provenance": ["files or artifacts that informed the workflow"],
      "artifactSources": ["source files/runbooks/scripts whose useful content was extracted, if any"],
      "supersedes": ["ids or stable names of weaker/failed capsules this replaces, if known"],
      "confidenceReason": "why the confidence score is justified",
      "failureBoundary": ["where this should not be generalized or which failure it avoids"],
      "validationProvenance": ["how the trace verified the result"],
      "outcomeStatus": "success | partial | failed | aborted | unknown",
      "nextRunInstruction": "compact instruction to give the next agent first",
      "workflow": {{
        "purpose": "what this workflow accomplishes",
        "parameters": ["values to resolve fresh next time"],
        "bindingSources": ["files/configs/tools to inspect fresh if needed"],
        "steps": ["ordered reusable steps"],
        "commands": ["reusable command shapes with placeholders if needed"],
        "successCriteria": ["how to know it worked"],
        "failedAttempts": ["dead ends to avoid"],
        "validationProbe": ["smallest cheap check before reuse"]
      }}
    }}
  ]
}}

Assembled draft:
{}"#,
        existing_capsule_context(existing_capsules),
        context_block,
        truncate(&serde_json::to_string(packet).unwrap_or_default(), 40000)
    )
}

struct LocalObserverResult {
    decision: Value,
    source: String,
    fallback_error: Option<String>,
}

fn review_gate_from_observer(packet: &EvidencePacket, workspace: &Path) -> Result<Option<Value>> {
    let Some(result) = safe_observer_decision_review(packet, workspace)? else {
        return Ok(None);
    };
    if let Some(error) = &result.fallback_error {
        debug(
            workspace,
            "local_observer.fallback",
            json!({ "task": "review", "error": error }),
        )?;
    }
    let decision = result.decision;
    debug(
        workspace,
        "local_observer.decision",
        json!({
            "task": "review",
            "source": result.source,
            "shouldCallStrongModel": decision.get("shouldCallStrongModel").cloned().unwrap_or(Value::Null),
            "shouldShowMemoryUi": decision.get("shouldShowMemoryUi").cloned().unwrap_or(Value::Null),
            "confidence": decision.get("confidence").cloned().unwrap_or(Value::Null),
            "reason": decision.get("reason").cloned().unwrap_or(Value::Null),
            "providerClass": decision.get("providerClass").cloned().unwrap_or(Value::Null)
        }),
    )?;
    if decision
        .get("shouldCallStrongModel")
        .and_then(Value::as_bool)
        == Some(false)
    {
        let review = decision
            .get("review")
            .filter(|review| review.get("shouldSave").and_then(Value::as_bool) == Some(false))
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "shouldSave": false,
                    "reason": decision
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("local observer found no durable reusable memory")
                })
            });
        debug(
            workspace,
            "local_observer.review_declined",
            json!({
                "reason": review.get("reason").cloned().unwrap_or(Value::Null),
                "confidence": decision.get("confidence").cloned().unwrap_or(Value::Null),
                "showMemoryUi": decision.get("shouldShowMemoryUi").cloned().unwrap_or(Value::Null)
            }),
        )?;
        return Ok(Some(review));
    }
    debug(
        workspace,
        "local_observer.review_escalated",
        json!({
            "reason": decision.get("reason").cloned().unwrap_or(Value::Null),
            "confidence": decision.get("confidence").cloned().unwrap_or(Value::Null),
            "providerClass": decision.get("providerClass").cloned().unwrap_or(Value::Null)
        }),
    )?;
    Ok(None)
}

fn safe_observer_decision_review(
    packet: &EvidencePacket,
    workspace: &Path,
) -> Result<Option<LocalObserverResult>> {
    let setting = observer_env_value("LOCAL_OBSERVER", "auto").to_lowercase();
    if setting == "off" {
        return Ok(None);
    }
    let command = observer_env_value("LOCAL_OBSERVER_COMMAND", "");
    if setting != "builtin" && !command.is_empty() {
        let input = serde_json::to_string(&json!({
            "task": "review",
            "workspace": workspace.to_string_lossy(),
            "packet": compact_observer_review_packet(packet)
        }))?;
        match run_local_observer_command(&command, &input) {
            Ok(output) => {
                let parsed = normalize_external_observer_decision(extract_json_object(&output)?);
                return Ok(Some(LocalObserverResult {
                    decision: parsed,
                    source: "command".to_owned(),
                    fallback_error: None,
                }));
            }
            Err(error) => {
                return Ok(Some(LocalObserverResult {
                    decision: builtin_review_decision(packet),
                    source: "builtin-fallback".to_owned(),
                    fallback_error: Some(error.to_string()),
                }));
            }
        }
    }
    Ok(Some(LocalObserverResult {
        decision: builtin_review_decision(packet),
        source: "builtin".to_owned(),
        fallback_error: None,
    }))
}

fn observer_env_value(suffix: &str, fallback: &str) -> String {
    env::var(format!("AGENT_RUN_CACHE_{suffix}"))
        .or_else(|_| env::var(format!("ARC_{suffix}")))
        .unwrap_or_else(|_| fallback.to_owned())
        .trim()
        .to_owned()
}

fn compact_observer_review_packet(packet: &EvidencePacket) -> Value {
    json!({
        "runner": packet.runner,
        "sessionId": packet.session_id,
        "eventCount": packet.event_count,
        "outcome": packet.outcome,
        "prompts": tail_strings(&packet.prompts, 3),
        "assistantMessages": tail_strings(&packet.assistant_messages, 4)
            .into_iter()
            .map(|message| truncate(&message, 1200))
            .collect::<Vec<_>>(),
        "commands": tail_strings(&packet.commands, 20),
        "paths": tail_strings(&packet.paths, 20),
        "episodes": packet.episodes.iter().rev().take(4).cloned().collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|episode| json!({
                "prompt": truncate(&episode.prompt, 800),
                "assistantMessages": tail_strings(&episode.assistant_messages, 3)
                    .into_iter()
                    .map(|message| truncate(&message, 1000))
                    .collect::<Vec<_>>(),
                "commands": tail_strings(&episode.commands, 12),
                "paths": tail_strings(&episode.paths, 12),
                "outcome": episode.outcome
            }))
            .collect::<Vec<_>>()
    })
}

fn tail_strings(values: &[String], limit: usize) -> Vec<String> {
    values
        .iter()
        .rev()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn normalize_external_observer_decision(mut decision: Value) -> Value {
    let Value::Object(map) = &mut decision else {
        return decision;
    };
    if !map.contains_key("shouldCallStrongModel") {
        match map.get("route").and_then(Value::as_str) {
            Some("call-strong-model") => {
                map.insert("shouldCallStrongModel".to_owned(), Value::Bool(true));
            }
            Some("handled-locally") => {
                map.insert("shouldCallStrongModel".to_owned(), Value::Bool(false));
            }
            _ => {}
        }
    }
    if !map.contains_key("review")
        && map.get("reviewVerdict").and_then(Value::as_str) == Some("not-worth-saving")
    {
        let reason = map.get("reason").cloned().unwrap_or(Value::Null);
        map.insert(
            "review".to_owned(),
            json!({ "shouldSave": false, "reason": reason }),
        );
    }
    decision
}

fn builtin_review_decision(packet: &EvidencePacket) -> Value {
    let commands = packet
        .commands
        .iter()
        .filter(|command| !command.trim().is_empty())
        .collect::<Vec<_>>();
    let prompts = packet
        .prompts
        .iter()
        .filter(|prompt| !prompt.trim().is_empty())
        .collect::<Vec<_>>();
    let status = packet.outcome.status.as_str();
    let tool_events = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_start" || event.type_ == "tool_end")
        .collect::<Vec<_>>();
    let has_tool_evidence = !commands.is_empty() || !tool_events.is_empty();
    let successful_tool = tool_events.iter().any(|event| {
        event.type_ == "tool_end"
            && (event.tool_status.as_deref() == Some("success") || event.exit_code == Some(0))
    });
    if prompts
        .iter()
        .map(|prompt| prompt.as_str())
        .collect::<String>()
        .trim()
        .is_empty()
    {
        return decline_review_decision(0.98, "empty prompt");
    }
    if !has_tool_evidence && packet.event_count <= 5 {
        return decline_review_decision(0.92, "tiny turn without tool evidence");
    }
    if !has_tool_evidence {
        return decline_review_decision(0.9, "no typed tool evidence");
    }
    if all_tool_events_read_only(&tool_events) {
        return decline_review_decision(0.88, "read-only tool inspection; no reusable workflow");
    }
    if (status == "aborted" || status == "failed") && !successful_tool {
        return decline_review_decision(
            0.88,
            &format!("{status} turn without successful tool evidence"),
        );
    }
    if tool_events.iter().all(|event| event.type_ == "tool_start") {
        return decline_review_decision(0.84, "tool activity has no completed outcome");
    }
    json!({
        "shouldCallStrongModel": true,
        "shouldShowMemoryUi": true,
        "providerClass": "configured",
        "confidence": 0.74,
        "reason": "typed tool evidence with an outcome; call strong reviewer"
    })
}

fn decline_review_decision(confidence: f64, reason: &str) -> Value {
    json!({
        "shouldCallStrongModel": false,
        "shouldShowMemoryUi": false,
        "confidence": confidence,
        "reason": reason,
        "review": { "shouldSave": false, "reason": reason }
    })
}

fn all_tool_events_read_only(events: &[&ArcEvent]) -> bool {
    let tool_events = events
        .iter()
        .filter(|event| event.type_ == "tool_start" || event.type_ == "tool_end")
        .collect::<Vec<_>>();
    if tool_events.is_empty() {
        return false;
    }
    tool_events.iter().all(|event| {
        let name = event.tool_name.as_deref().unwrap_or("").to_lowercase();
        matches!(
            name.as_str(),
            "read" | "read_file" | "search" | "grep" | "glob" | "list"
        ) || name.contains("read")
            || name.contains("search")
    })
}

fn run_local_observer_command(command: &str, input: &str) -> Result<String> {
    let mut child = Command::new(env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()))
        .args(["-lc", command])
        .current_dir(env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("AGENT_RUN_CACHE_IN_LOCAL_OBSERVER", "1")
        .spawn()
        .with_context(|| "failed to run local observer command")?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(input.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(anyhow!(
            "local observer command failed with {}\n{}",
            output.status.code().unwrap_or(1),
            truncate(&String::from_utf8_lossy(&output.stderr), 4000)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn review_candidate_capsules(
    packet: &Value,
    workspace: &Path,
    injected_capsule_ids: &[String],
) -> Result<Vec<Capsule>> {
    let capsules = load_capsules(workspace)?;
    if capsules.is_empty() {
        return Ok(Vec::new());
    }
    let injected = injected_capsule_ids
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect::<HashSet<_>>();
    let query = review_candidate_text(packet);
    let query_tokens = review_candidate_tokens(&query);
    let mut scored = capsules
        .into_iter()
        .enumerate()
        .map(|(index, capsule)| {
            let score = if injected.contains(&capsule.id) {
                100.0
            } else {
                review_candidate_score(&capsule, &query_tokens)
            };
            (index, capsule, score)
        })
        .filter(|(_, capsule, score)| *score > 0.18 || injected.contains(&capsule.id))
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| {
        right
            .2
            .partial_cmp(&left.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    let candidates = scored
        .into_iter()
        .take(5)
        .map(|(_, capsule, _)| capsule)
        .collect::<Vec<_>>();
    if !candidates.is_empty() {
        debug(
            workspace,
            "sidecar.review_candidates",
            json!({
                "count": candidates.len(),
                "injected": candidates
                    .iter()
                    .filter(|capsule| injected.contains(&capsule.id))
                    .map(|capsule| capsule.id.clone())
                    .collect::<Vec<_>>()
            }),
        )?;
    }
    Ok(candidates)
}

fn review_candidate_text(packet: &Value) -> String {
    if packet.get("packetKind").and_then(Value::as_str) == Some("assembled_draft") {
        return [
            value_string(packet.get("goal")).unwrap_or_default(),
            value_array_strings(packet.get("prompts")).join(" "),
            value_array_strings(packet.get("commands")).join(" "),
            value_array_strings(packet.get("parameters")).join(" "),
            value_array_strings(packet.get("paths")).join(" "),
            value_array_strings(packet.get("evidenceSnippets")).join(" "),
        ]
        .join(" ");
    }
    let episode_text = packet
        .get("episodes")
        .and_then(Value::as_array)
        .map(|episodes| {
            episodes
                .iter()
                .map(|episode| {
                    [
                        value_string(episode.get("prompt")).unwrap_or_default(),
                        value_array_strings(episode.get("assistantMessages")).join(" "),
                        value_array_strings(episode.get("commands")).join(" "),
                        value_array_strings(episode.get("paths")).join(" "),
                    ]
                    .join(" ")
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    [
        value_array_strings(packet.get("prompts")).join(" "),
        value_array_strings(packet.get("assistantMessages")).join(" "),
        value_array_strings(packet.get("commands")).join(" "),
        value_array_strings(packet.get("paths")).join(" "),
        episode_text,
    ]
    .join(" ")
}

fn review_candidate_score(capsule: &Capsule, query_tokens: &HashSet<String>) -> f64 {
    if query_tokens.is_empty() {
        return 0.0;
    }
    let capsule_text = [
        capsule.kind.clone(),
        capsule.merge_key.clone(),
        capsule.title.clone(),
        capsule.summary.clone(),
        capsule.next_run_instruction.clone(),
        capsule.reuse_when.join(" "),
        capsule.workflow.purpose.clone(),
        capsule.workflow.parameters.join(" "),
        capsule.workflow.binding_sources.join(" "),
        capsule.workflow.steps.join(" "),
        capsule.workflow.commands.join(" "),
        capsule.workflow.failed_attempts.join(" "),
        capsule.workflow.validation_probe.join(" "),
    ]
    .join(" ");
    let capsule_tokens = review_candidate_tokens(&capsule_text);
    if capsule_tokens.is_empty() {
        return 0.0;
    }
    let hits = capsule_tokens
        .iter()
        .filter(|token| query_tokens.contains(*token))
        .count();
    hits as f64 / capsule_tokens.len().min(query_tokens.len()) as f64
}

fn review_candidate_tokens(value: &str) -> HashSet<String> {
    let generic = [
        "and",
        "are",
        "ask",
        "before",
        "binding",
        "bindings",
        "capsule",
        "check",
        "command",
        "commands",
        "config",
        "configuration",
        "current",
        "file",
        "files",
        "from",
        "future",
        "into",
        "local",
        "method",
        "next",
        "path",
        "probe",
        "prompt",
        "resolve",
        "resolved",
        "reusable",
        "run",
        "session",
        "source",
        "sources",
        "step",
        "steps",
        "target",
        "test",
        "testing",
        "that",
        "the",
        "this",
        "through",
        "use",
        "used",
        "user",
        "values",
        "verify",
        "workflow",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    Regex::new(r"[^a-z0-9_./:-]+")
        .unwrap()
        .split(&value.to_lowercase())
        .flat_map(|part| {
            let clean = part
                .trim_matches(|c: char| !matches!(c, 'a'..='z' | '0'..='9' | '_'))
                .to_owned();
            if clean.is_empty() {
                return Vec::new();
            }
            let mut parts = vec![clean.clone()];
            if let Some(basename) = clean.split('/').rfind(|part| !part.is_empty()) {
                if basename != clean {
                    parts.push(basename.to_owned());
                }
            }
            parts.extend(
                Regex::new(r"[./:-]+")
                    .unwrap()
                    .split(&clean)
                    .filter(|piece| !piece.is_empty())
                    .map(str::to_owned),
            );
            parts
        })
        .map(|token| {
            if token == "userknownhostsfile" {
                "known_hosts".to_owned()
            } else {
                token
            }
        })
        .filter(|token| token.len() >= 3 && !generic.contains(token.as_str()))
        .filter(|token| !Regex::new(r"^\d+$").unwrap().is_match(token))
        .collect()
}

fn existing_capsule_context(capsules: &[Capsule]) -> String {
    if capsules.is_empty() {
        return String::new();
    }
    let compact = capsules
        .iter()
        .map(|capsule| {
            json!({
                "id": capsule.id,
                "title": capsule.title,
                "kind": capsule.kind,
                "mergeKey": capsule.merge_key,
                "summary": capsule.summary,
                "nextRunInstruction": capsule.next_run_instruction,
                "bindingSources": capsule.workflow.binding_sources,
                "commandShapes": capsule.workflow.commands.iter().take(3).cloned().collect::<Vec<_>>(),
                "failedAttempts": capsule.workflow.failed_attempts.iter().take(4).cloned().collect::<Vec<_>>(),
                "failureBoundary": capsule.failure_boundary.iter().take(4).cloned().collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    format!(
        r#"

Existing capsule candidates from this workspace:
{}

Candidate rules:
- If the completed session mainly reused, validated, or slightly refined one of these candidates, do not mint a parallel capsule with a new mergeKey.
- If nothing materially new was learned beyond confirming an existing capsule still works, return {{"shouldSave": false, "reason": "validated existing capsule"}}.
- If a useful correction or stronger command shape was learned, emit one capsule for the same workflow and reuse the existing candidate's mergeKey when it is the same method.
- Use supersedes only when the new capsule should retire a weaker or wrong route; for a normal refinement, prefer the same mergeKey so storage updates the existing capsule."#,
        truncate(&serde_json::to_string(&compact).unwrap_or_default(), 12000)
    )
}

pub(crate) fn value_array_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn build_evidence_packet(
    events: &[ArcEvent],
    workspace: &Path,
    session_id: &str,
) -> EvidencePacket {
    let prompts = unique_strings(
        events
            .iter()
            .filter(|event| event.type_ == "user_prompt")
            .filter_map(|event| event.text.clone())
            .collect(),
    );
    let assistant_messages = unique_strings(
        events
            .iter()
            .filter(|event| event.type_ == "assistant_message")
            .filter_map(|event| event.text.clone())
            .collect(),
    );
    let tool_events = events
        .iter()
        .filter(|event| event.type_ == "tool_start" || event.type_ == "tool_end")
        .cloned()
        .collect::<Vec<_>>();
    let commands = unique_strings(
        tool_events
            .iter()
            .filter_map(|event| event.command.clone())
            .collect(),
    )
    .into_iter()
    .take(40)
    .collect::<Vec<_>>();
    let paths = unique_strings(events.iter().flat_map(paths_from_event).collect())
        .into_iter()
        .take(80)
        .collect::<Vec<_>>();
    let assistant_tail = assistant_messages
        .iter()
        .rev()
        .take(20)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let tool_tail = tool_events
        .iter()
        .rev()
        .take(80)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    EvidencePacket {
        runner: events
            .iter()
            .find(|event| !event.runner.is_empty())
            .map(|event| event.runner.clone())
            .unwrap_or_else(|| "copilot".to_owned()),
        session_id: session_id.to_owned(),
        workspace: workspace.to_string_lossy().to_string(),
        created_at: now_iso(),
        episodes: build_episodes(events),
        prompts,
        assistant_messages: assistant_tail,
        tool_events: tool_tail,
        commands,
        paths,
        event_count: events.len(),
        outcome: classify_outcome(events),
    }
}

fn build_episodes(events: &[ArcEvent]) -> Vec<EvidenceEpisode> {
    let mut episodes = Vec::new();
    let mut current: Option<EvidenceEpisode> = None;
    for event in events {
        if event.type_ == "user_prompt" {
            if let Some(mut prior) = current.take() {
                if prior.assistant_messages.is_empty()
                    && prior.commands.is_empty()
                    && prior.tool_events.is_empty()
                {
                    prior.prompt = event.text.clone().unwrap_or(prior.prompt);
                    current = Some(prior);
                    continue;
                }
                episodes.push(trim_episode(prior));
            }
            current = Some(EvidenceEpisode {
                prompt: event.text.clone().unwrap_or_default(),
                assistant_messages: Vec::new(),
                commands: Vec::new(),
                paths: Vec::new(),
                tool_events: Vec::new(),
                outcome: unknown_outcome(),
            });
            continue;
        }
        let Some(episode) = current.as_mut() else {
            continue;
        };
        if event.type_ == "assistant_message" {
            if let Some(text) = &event.text {
                episode.assistant_messages.push(text.clone());
            }
        }
        if event.type_ == "tool_start" || event.type_ == "tool_end" {
            episode.tool_events.push(event.clone());
            if let Some(command) = &event.command {
                episode.commands.push(command.clone());
            }
        }
        episode.paths.extend(paths_from_event(event));
    }
    if let Some(episode) = current {
        episodes.push(trim_episode(episode));
    }
    episodes
        .into_iter()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn trim_episode(episode: EvidenceEpisode) -> EvidenceEpisode {
    let mut episode_events = episode.tool_events.clone();
    for (index, message) in episode.assistant_messages.iter().enumerate() {
        episode_events.push(ArcEvent {
            id: format!("episode-text-{index}"),
            runner: "copilot".to_owned(),
            session_id: "episode".to_owned(),
            workspace: String::new(),
            timestamp: "1970-01-01T00:00:00.000Z".to_owned(),
            type_: "assistant_message".to_owned(),
            source: "episode".to_owned(),
            text: Some(message.clone()),
            ..ArcEvent::default()
        });
    }
    EvidenceEpisode {
        prompt: episode.prompt,
        assistant_messages: unique_strings(episode.assistant_messages)
            .into_iter()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
        commands: unique_strings(episode.commands)
            .into_iter()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
        paths: unique_strings(episode.paths).into_iter().take(24).collect(),
        tool_events: episode
            .tool_events
            .into_iter()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
        outcome: classify_outcome(&episode_events),
    }
}

fn classify_outcome(events: &[ArcEvent]) -> EvidenceOutcome {
    let assistant_tail = events
        .iter()
        .filter(|event| event.type_ == "assistant_message")
        .filter_map(|event| event.text.clone())
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let final_assistant = assistant_tail
        .last()
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    let tool_tail = events
        .iter()
        .filter(|event| event.type_ == "tool_end")
        .rev()
        .take(20)
        .cloned()
        .collect::<Vec<_>>();
    let text = assistant_tail
        .iter()
        .cloned()
        .chain(tool_tail.iter().map(|event| {
            format!(
                "{}\n{}",
                event.command.clone().unwrap_or_default(),
                event.text.clone().unwrap_or_default()
            )
        }))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    let success_signals = collect_signals(
        &text,
        &[
            "done",
            "succeeded",
            "successfully",
            "passed",
            "verified",
            "working",
            "deployed",
            "stopped",
            "fixed",
            "completed",
            "health ok",
            "exit code: 0",
            "exit code 0",
        ],
    );
    let mut failure_signals = collect_signals(
        &text,
        &[
            "failed",
            "failure",
            "not reachable",
            "network is unreachable",
            "permission denied",
            "timed out",
            "timeout",
            "connection refused",
            "no route to host",
            "exit code: 1",
            "exit code 1",
            "exit code: 255",
            "exit code 255",
            "command not found",
            "syntax error",
            "could not",
            "couldn't",
            "cannot",
        ],
    );
    let mut aborted_signals = collect_signals(
        &text,
        &[
            "stopped by user",
            "user stopped",
            "aborted",
            "cancelled",
            "canceled",
            "interrupted",
            "stop_bash",
        ],
    );
    for event in tool_tail {
        if event.tool_status.as_deref() == Some("failed")
            || event.exit_code.is_some_and(|code| code != 0)
        {
            failure_signals.push(
                event
                    .exit_code
                    .map(|code| format!("tool exit code {code}"))
                    .unwrap_or_else(|| "tool reported failure".to_owned()),
            );
        }
        if event.tool_name.as_deref() == Some("stop_bash") {
            aborted_signals.push("stop_bash tool used".to_owned());
        }
    }
    let status = outcome_status(
        &success_signals,
        &failure_signals,
        &aborted_signals,
        &final_assistant,
    );
    let reasons = [
        (!success_signals.is_empty()).then(|| {
            format!(
                "success signals: {}",
                unique_strings(success_signals.clone())
                    .into_iter()
                    .take(4)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
        (!failure_signals.is_empty()).then(|| {
            format!(
                "failure signals: {}",
                unique_strings(failure_signals.clone())
                    .into_iter()
                    .take(4)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
        (!aborted_signals.is_empty()).then(|| {
            format!(
                "aborted signals: {}",
                unique_strings(aborted_signals.clone())
                    .into_iter()
                    .take(4)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    EvidenceOutcome {
        confidence: match status.as_str() {
            "unknown" => 0.25,
            "partial" => 0.55,
            _ => 0.7,
        },
        status,
        reasons,
        success_signals: unique_strings(success_signals)
            .into_iter()
            .take(12)
            .collect(),
        failure_signals: unique_strings(failure_signals)
            .into_iter()
            .take(12)
            .collect(),
        aborted_signals: unique_strings(aborted_signals)
            .into_iter()
            .take(12)
            .collect(),
    }
}

fn outcome_status(
    success_signals: &[String],
    failure_signals: &[String],
    aborted_signals: &[String],
    final_assistant: &str,
) -> String {
    if !aborted_signals.is_empty() && success_signals.is_empty() {
        return "aborted".to_owned();
    }
    if !success_signals.is_empty()
        && !failure_signals.is_empty()
        && final_assistant_claims_success(final_assistant)
    {
        return "success".to_owned();
    }
    if !success_signals.is_empty() && !failure_signals.is_empty() {
        return "partial".to_owned();
    }
    if !success_signals.is_empty() {
        return "success".to_owned();
    }
    if !failure_signals.is_empty() {
        return "failed".to_owned();
    }
    if !aborted_signals.is_empty() {
        return "partial".to_owned();
    }
    "unknown".to_owned()
}

fn final_assistant_claims_success(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let strong =
        Regex::new(r"\b(succeeded|successfully|verified|completed|works|working|fixed|passed)\b")
            .unwrap()
            .is_match(text);
    if !strong {
        return false;
    }
    let unresolved = Regex::new(r"\b(failed|failure|not reachable|network is unreachable|permission denied|timed out|timeout|connection refused|no route to host|exit code:?\s*(1|255)|command not found|syntax error|could not|couldn't|cannot)\b")
        .unwrap()
        .is_match(text);
    !unresolved
        || Regex::new(r"\b(non[- ]blocking|eventually|after retry|recovered|still completed|completed successfully|probe still completed)\b")
            .unwrap()
            .is_match(text)
}

fn unknown_outcome() -> EvidenceOutcome {
    EvidenceOutcome {
        status: "unknown".to_owned(),
        confidence: 0.25,
        reasons: Vec::new(),
        success_signals: Vec::new(),
        failure_signals: Vec::new(),
        aborted_signals: Vec::new(),
    }
}

fn collect_signals(text: &str, needles: &[&str]) -> Vec<String> {
    needles
        .iter()
        .filter(|needle| text.contains(**needle))
        .map(|needle| (*needle).to_owned())
        .collect()
}

fn paths_from_event(event: &ArcEvent) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(path) = &event.path {
        if looks_like_path(path) {
            values.push(path.trim().to_owned());
        }
    }
    if let Some(raw) = &event.raw {
        visit_strings(raw, &mut |value| {
            if looks_like_path(value) {
                values.push(value.trim().to_owned());
            }
        });
    }
    values
}

fn visit_strings<F: FnMut(&str)>(value: &Value, fn_: &mut F) {
    match value {
        Value::String(text) => fn_(text),
        Value::Array(items) => {
            for item in items {
                visit_strings(item, fn_);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                visit_strings(item, fn_);
            }
        }
        _ => {}
    }
}

fn looks_like_path(value: &str) -> bool {
    let text = value.trim();
    text.contains('/')
        && text.len() <= 260
        && !text.contains('\n')
        && !text.contains('\r')
        && !text.contains('\t')
        && text.split(' ').count() <= 1
        && text.split('/').filter(|part| !part.is_empty()).count() >= 2
}

fn evidence_snippets_from_packet(packet: &EvidencePacket) -> Vec<String> {
    let starts_by_id = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_start")
        .filter_map(|event| tool_event_id(event).map(|id| (id, event)))
        .collect::<HashMap<_, _>>();
    let completed_ids = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_end")
        .filter_map(tool_event_id)
        .collect::<HashSet<_>>();
    let completed_commands = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_end")
        .filter_map(|event| {
            let start = tool_event_id(event).and_then(|id| starts_by_id.get(&id).copied());
            (event.exit_code.is_some()
                || event.command.is_some()
                || start.is_some_and(|value| value.command.is_some()))
            .then(|| snippet_from_command_result(event, start, &packet.workspace))
        })
        .collect::<Vec<_>>();
    let command_event_ids = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_end")
        .filter_map(|event| {
            let id = tool_event_id(event)?;
            let start = starts_by_id.get(&id).copied();
            (event.exit_code.is_some()
                || event.command.is_some()
                || start.is_some_and(|value| value.command.is_some()))
            .then_some(id)
        })
        .collect::<HashSet<_>>();
    let failed_results = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_end" && tool_event_failed(event))
        .filter(|event| {
            tool_event_id(event)
                .map(|id| !command_event_ids.contains(&id))
                .unwrap_or(true)
        })
        .filter_map(|event| snippet_from_tool_end(event, &packet.workspace, 700, true))
        .collect::<Vec<_>>();
    let incomplete_commands = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_start" && event.command.is_some())
        .filter(|event| {
            tool_event_id(event)
                .map(|id| !completed_ids.contains(&id))
                .unwrap_or(true)
        })
        .filter_map(|event| snippet_from_incomplete_command(event, &packet.workspace))
        .collect::<Vec<_>>();
    let generic_results = packet
        .tool_events
        .iter()
        .filter(|event| event.type_ == "tool_end" && !tool_event_failed(event))
        .filter(|event| {
            tool_event_id(event)
                .map(|id| !command_event_ids.contains(&id))
                .unwrap_or(true)
        })
        .filter_map(|event| snippet_from_tool_end(event, &packet.workspace, 350, false))
        .collect::<Vec<_>>();

    let mut snippets = Vec::new();
    snippets.extend(tail_items(completed_commands, 4));
    snippets.extend(tail_items(failed_results, 3));
    snippets.extend(tail_items(incomplete_commands, 2));
    snippets.extend(tail_items(generic_results, 4));
    snippets.extend(
        packet
            .assistant_messages
            .iter()
            .rev()
            .filter(|message| !message.trim().is_empty())
            .take(2)
            .map(|message| clean_snippet(&format!("assistant: {message}"), 400, &packet.workspace))
            .filter(|value| !value.is_empty()),
    );
    bound_evidence_snippets(unique_strings(snippets))
}

fn tool_event_id(event: &ArcEvent) -> Option<String> {
    event.tool_use_id.clone().or_else(|| {
        event
            .raw
            .as_ref()
            .and_then(|raw| raw.get("data"))
            .and_then(|data| data.get("toolCallId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn tool_event_failed(event: &ArcEvent) -> bool {
    event.tool_status.as_deref() == Some("failed")
        || event.exit_code.is_some_and(|exit_code| exit_code != 0)
}

fn tail_items<T>(items: Vec<T>, limit: usize) -> Vec<T> {
    let skip = items.len().saturating_sub(limit);
    items.into_iter().skip(skip).collect()
}

fn snippet_from_command_result(
    event: &ArcEvent,
    start: Option<&ArcEvent>,
    workspace: &str,
) -> String {
    let status = event
        .tool_status
        .clone()
        .unwrap_or_else(|| match event.exit_code {
            Some(0) => "success".to_owned(),
            Some(_) => "failed".to_owned(),
            None => "unknown".to_owned(),
        });
    let result = event
        .exit_code
        .map(|exit_code| format!("exit code {exit_code}"))
        .unwrap_or_else(|| format!("status {status}"));
    let command = event
        .command
        .as_ref()
        .or_else(|| start.and_then(|value| value.command.as_ref()))
        .map(|value| clean_snippet(value, 260, workspace))
        .unwrap_or_else(|| event.tool_name.as_deref().unwrap_or("command").to_owned());
    let output = event
        .text
        .as_deref()
        .map(|text| clean_tail_snippet(text, 420, workspace))
        .filter(|value| !value.is_empty())
        .map(|value| format!("\noutput tail:\n{value}"))
        .unwrap_or_default();
    clean_snippet(
        &format!("{status} command result ({result}): {command}{output}"),
        700,
        workspace,
    )
}

fn snippet_from_incomplete_command(event: &ArcEvent, workspace: &str) -> Option<String> {
    let command = event.command.as_ref()?;
    Some(clean_snippet(
        &format!(
            "incomplete command (no completion event observed): {}",
            clean_snippet(command, 340, workspace)
        ),
        400,
        workspace,
    ))
}

fn snippet_from_tool_end(
    event: &ArcEvent,
    workspace: &str,
    max_length: usize,
    use_tail: bool,
) -> Option<String> {
    let label = event.tool_name.as_deref().unwrap_or("tool");
    let status = event
        .tool_status
        .clone()
        .unwrap_or_else(|| match event.exit_code {
            Some(0) => "success".to_owned(),
            Some(_) => "failed".to_owned(),
            None => "unknown".to_owned(),
        });
    let command = event
        .command
        .as_ref()
        .map(|value| portable_snippet_text(value, workspace))
        .unwrap_or_else(|| label.to_owned());
    let text = event.text.as_ref().map_or_else(String::new, |text| {
        let excerpt = if use_tail {
            clean_tail_snippet(text, max_length.saturating_sub(100), workspace)
        } else {
            clean_snippet(text, max_length.saturating_sub(100), workspace)
        };
        format!("\n{excerpt}")
    });
    let snippet = clean_snippet(
        &format!("{status} {label}: {command}{text}"),
        max_length,
        workspace,
    );
    if snippet.is_empty() {
        None
    } else {
        Some(snippet)
    }
}

fn bound_evidence_snippets(snippets: Vec<String>) -> Vec<String> {
    let mut bounded = Vec::new();
    let mut used = 0usize;
    for snippet in snippets {
        let remaining = 6000usize.saturating_sub(used);
        if remaining == 0 {
            break;
        }
        let next = if snippet.len() > remaining {
            format!(
                "{}...",
                snippet
                    .chars()
                    .take(remaining.saturating_sub(3))
                    .collect::<String>()
                    .trim_end()
            )
        } else {
            snippet
        };
        used += next.len();
        bounded.push(next);
    }
    bounded
}

fn clean_snippet(value: &str, max_length: usize, workspace: &str) -> String {
    let compact = redact_sensitive(&portable_snippet_text(value, workspace))
        .replace('\r', "")
        .replace("\n\n\n", "\n\n")
        .trim()
        .to_owned();
    if compact.len() <= max_length {
        return compact;
    }
    format!(
        "{}...",
        compact
            .chars()
            .take(max_length.saturating_sub(3))
            .collect::<String>()
            .trim_end()
    )
}

fn clean_tail_snippet(value: &str, max_length: usize, workspace: &str) -> String {
    let compact = redact_sensitive(&portable_snippet_text(value, workspace))
        .replace('\r', "")
        .replace("\n\n\n", "\n\n")
        .trim()
        .to_owned();
    let length = compact.chars().count();
    if length <= max_length {
        return compact;
    }
    format!(
        "...{}",
        compact
            .chars()
            .skip(length.saturating_sub(max_length.saturating_sub(3)))
            .collect::<String>()
            .trim_start()
    )
}

fn portable_snippet_text(value: &str, workspace: &str) -> String {
    let root = PathBuf::from(workspace);
    let root = root.to_string_lossy();
    value
        .replace(&format!("{root}/"), "")
        .replace(root.as_ref(), ".")
}

fn parameter_hints_from_prompt(prompt: &str) -> Vec<String> {
    prompt
        .split_whitespace()
        .filter(|token| token.contains('/') || token.contains('=') || token.starts_with("--"))
        .map(|token| token.trim_end_matches(&['.', ',', ';', ':'][..]).to_owned())
        .filter(|value| !value.is_empty())
        .take(12)
        .collect()
}

fn review_capsules(review: Option<&Value>) -> Vec<Value> {
    let Some(review) = review else {
        return Vec::new();
    };
    if review.get("shouldSave").and_then(Value::as_bool) == Some(false) {
        return Vec::new();
    }
    if let Some(capsules) = review.get("capsules").and_then(Value::as_array) {
        if !capsules.is_empty() {
            return capsules
                .iter()
                .filter(|value| value.is_object())
                .cloned()
                .collect();
        }
    }
    review
        .get("capsule")
        .filter(|value| value.is_object())
        .cloned()
        .into_iter()
        .collect()
}

fn capsule_allowed_for_outcome(capsule: &Value, status: &str) -> bool {
    if status != "failed" && status != "aborted" {
        return true;
    }
    let kind = capsule
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    if kind.contains("fact") || kind.contains("dead_end") || kind.contains("caution") {
        return true;
    }
    let failed_attempts = capsule
        .get("workflow")
        .and_then(|value| value.get("failedAttempts"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let success_criteria = capsule
        .get("workflow")
        .and_then(|value| value.get("successCriteria"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    failed_attempts > 0 && success_criteria == 0
}

fn capsule_allowed_for_action_risk(capsule: &Value, options: &ReviewOptions) -> bool {
    if options.action_risk.is_none() {
        return true;
    }
    !review_capsule_has_live_action(capsule)
}

pub(crate) struct CorrectionSignal {
    pub(crate) detected: bool,
    reasons: Vec<String>,
}

fn correction_signal(events: &[ArcEvent]) -> CorrectionSignal {
    let prompt = events
        .iter()
        .filter(|event| event.type_ == "user_prompt")
        .filter_map(|event| event.text.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    let assistant = events
        .iter()
        .filter(|event| event.type_ == "assistant_message")
        .filter_map(|event| event.text.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    let mut reasons = Vec::new();
    if Regex::new(r"\b(where did .{1,80} come from|why did (?:you|we) .{0,80}(?:not|instead)|what made (?:you|us)|are you sure|wait so|that(?:'s| is) wrong|wrong because|not (?:an?|the) existing|not follow)\b")
        .unwrap()
        .is_match(&prompt)
    {
        reasons.push("user challenged or corrected the prior assumption".to_owned());
    }
    if Regex::new(r"\b(my addition|i added|i introduced|i assumed|you(?:'re| are) right|i was wrong|not (?:an?|the) existing|not (?:a )?pattern|does not use|did not come from)\b")
        .unwrap()
        .is_match(&assistant)
    {
        reasons.push("assistant acknowledged a correction or narrowed prior claim".to_owned());
    }
    CorrectionSignal {
        detected: !reasons.is_empty(),
        reasons,
    }
}

fn plain_validation_reason(reason: Option<&str>) -> bool {
    Regex::new(r"(?i)\b(validated|confirmed|already captured|existing capsule)\b")
        .unwrap()
        .is_match(reason.unwrap_or(""))
}

fn capsule_allowed_for_correction(capsule: &Value) -> bool {
    let kind = capsule
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    (kind.contains("fact") || kind.contains("caution") || kind.contains("dead_end"))
        && !review_capsule_has_live_action(capsule)
}

fn review_capsule_has_live_action(capsule: &Value) -> bool {
    let commands = capsule
        .get("workflow")
        .and_then(|value| value.get("commands"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let probes = capsule
        .get("workflow")
        .and_then(|value| value.get("validationProbe"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let text = commands
        .chain(probes)
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    Regex::new(r"\b(?:ssh|scp|rsync|kubectl|external-runner)\b")
        .unwrap()
        .is_match(&text)
        || Regex::new(r"\bdocker\s+exec\b").unwrap().is_match(&text)
}

fn already_reviewed(session_id: &str, workspace: &Path) -> Result<Option<ReviewRecord>> {
    let values = read_jsonl_values(&reviewed_path(workspace))?;
    Ok(values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<ReviewRecord>(value).ok())
        .find(|record| {
            record.session_id == session_id
                && record.workspace == workspace.to_string_lossy()
                && record.status != "failed"
        }))
}

fn outcome_from_review(record: &ReviewRecord) -> ReviewOutcome {
    ReviewOutcome {
        status: record.status.clone(),
        reason: record.reason.clone(),
        capsule_ids: record
            .capsule_id
            .as_deref()
            .unwrap_or("")
            .split(',')
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    }
}

fn review_record(
    session_id: &str,
    workspace: &Path,
    trace_hash: &str,
    event_count: usize,
    status: &str,
    capsule_id: Option<String>,
    reason: Option<&str>,
) -> ReviewRecord {
    ReviewRecord {
        session_id: session_id.to_owned(),
        workspace: workspace.to_string_lossy().to_string(),
        trace_hash: trace_hash.to_owned(),
        event_count,
        status: status.to_owned(),
        capsule_id,
        reason: reason.map(str::to_owned),
        turn_id: None,
        rejection_path: None,
        runner_status: None,
        injected_capsule_ids: None,
        created_at: now_iso(),
    }
}

fn record_review(workspace: &Path, record: ReviewRecord) -> Result<()> {
    append_jsonl(&reviewed_path(workspace), &record)
}

fn record_declined_draft(
    workspace: &Path,
    review_input: &Value,
    session_id: &str,
    outcome: &str,
    reason: &str,
) -> Result<()> {
    let merge_key = review_input
        .get("mergeKey")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if merge_key.is_empty() {
        return Ok(());
    }
    let record = DeclinedDraftRecord {
        id: format!(
            "declined-{}",
            &sha256_hex(&format!("{session_id}\n{merge_key}"))[..16]
        ),
        merge_key: merge_key.to_owned(),
        created_at: now_iso(),
        session_id: session_id.to_owned(),
        outcome: outcome.to_owned(),
        reason: reason.to_owned(),
    };
    append_jsonl(&declined_path(workspace), &record)
}

fn add_recurrence_provenance(
    capsule: &mut Map<String, Value>,
    recurrence: &ReviewRecurrence,
    session_id: &str,
) {
    let provenance = capsule
        .entry("provenance".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Value::Array(values) = provenance {
        values.push(Value::String(format!(
            "recurrenceCount: {}",
            recurrence.count
        )));
    }
    let source_session_ids = capsule
        .entry("sourceSessionIds".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Value::Array(values) = source_session_ids {
        for source_session_id in recurrence
            .prior_session_ids
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(session_id))
        {
            if !values
                .iter()
                .any(|value| value.as_str() == Some(source_session_id))
            {
                values.push(Value::String(source_session_id.to_owned()));
            }
        }
    }
}

pub(crate) fn record_sidecar_exchange(
    workspace: &Path,
    kind: &str,
    source: &str,
    input: &str,
    output: &str,
    parsed: &Value,
) -> Result<()> {
    append_jsonl(
        &sidecar_path(workspace),
        &json!({
            "timestamp": now_iso(),
            "kind": kind,
            "source": source,
            "inputHash": sha256_hex(input),
            "outputHash": sha256_hex(output),
            "inputBytes": input.len(),
            "outputBytes": output.len(),
            "inputPreview": truncate(&redact_sensitive(input), 20000),
            "outputPreview": truncate(&redact_sensitive(output), 12000),
            "parsed": parsed
        }),
    )
}

fn run_shell_command(command: &str, input: &str) -> Result<String> {
    run_process_capture(
        &env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()),
        &["-lc".to_owned(), command.to_owned()],
        env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        input,
    )
}

fn model_sidecar_setting() -> Result<String> {
    let value = env::var("AGENT_RUN_CACHE_MODEL_SIDECAR")
        .unwrap_or_else(|_| "auto".to_owned())
        .trim()
        .to_owned();
    let value = if value.is_empty() {
        "auto".to_owned()
    } else {
        value
    };
    if matches!(value.as_str(), "auto" | "off" | "opencode" | "copilot") {
        Ok(value)
    } else {
        Err(anyhow!(
            "AGENT_RUN_CACHE_MODEL_SIDECAR must be auto, opencode, copilot, or off."
        ))
    }
}

fn sidecar_runner_for(packet_runner: &str) -> Result<Option<String>> {
    let setting = model_sidecar_setting()?;
    if setting == "off" {
        return Ok(None);
    }
    if setting != "auto" {
        return Ok(Some(setting));
    }
    if packet_runner == "opencode" || packet_runner == "copilot" {
        Ok(Some(packet_runner.to_owned()))
    } else {
        Ok(None)
    }
}

fn run_model_sidecar(prompt: &str, workspace: &Path, runner: &str) -> Result<String> {
    match runner {
        "opencode" => run_process_capture(
            &opencode_bin(),
            &["run".to_owned(), prompt.to_owned()],
            workspace.to_path_buf(),
            "",
        ),
        "copilot" => run_copilot_sidecar(prompt, workspace, None),
        other => Err(anyhow!("unsupported model sidecar runner: {other}")),
    }
}

pub(crate) fn run_judge_sidecar(
    prompt: &str,
    workspace: &Path,
    model: &JudgeModel,
) -> Result<String> {
    match model.provider.as_str() {
        "ollama" => run_ollama_judge(prompt, &model.id),
        "copilot" => run_copilot_sidecar(prompt, workspace, Some(&model.id)),
        provider => Err(anyhow!("unsupported judge provider: {provider}")),
    }
}

fn run_ollama_judge(prompt: &str, model: &str) -> Result<String> {
    let base = env::var("OLLAMA_HOST")
        .unwrap_or_else(|_| "http://127.0.0.1:11434".to_owned())
        .trim_end_matches('/')
        .to_owned();
    let response = ureq::post(&format!("{base}/api/chat"))
        .timeout(Duration::from_millis(sidecar_timeout_ms()))
        .set("content-type", "application/json")
        .send_json(json!({
            "model": model,
            "stream": false,
            "format": "json",
            "options": { "temperature": 0 },
            "messages": [{ "role": "user", "content": prompt }]
        }))
        .context("Ollama judge request failed")?;
    let payload = response
        .into_json::<Value>()
        .context("Ollama judge returned invalid JSON")?;
    payload
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .or_else(|| payload.get("response").and_then(Value::as_str))
        .map(str::trim)
        .filter(|output| !output.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("Ollama judge returned an empty response"))
}

fn sidecar_timeout_ms() -> u64 {
    env::var("AGENT_RUN_CACHE_SIDECAR_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(120_000)
}

fn run_copilot_sidecar(prompt: &str, workspace: &Path, model: Option<&str>) -> Result<String> {
    let mut args = vec![
        "-p".to_owned(),
        prompt.to_owned(),
        "--allow-all".to_owned(),
        "--disable-builtin-mcps".to_owned(),
        "--no-auto-update".to_owned(),
        "--output-format".to_owned(),
        "json".to_owned(),
    ];
    if let Some(model) = model.filter(|value| !value.is_empty() && *value != "auto") {
        args.push("--model".to_owned());
        args.push(model.to_owned());
    }
    let (command, args) = copilot_sidecar_command(args)?;
    let output = run_process_capture(&command, &args, workspace.to_path_buf(), "")?;
    Ok(copilot_json_output_content(&output).unwrap_or(output))
}

fn copilot_json_output_content(output: &str) -> Option<String> {
    let mut content = None;
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant.message") {
            continue;
        }
        let Some(text) = value
            .get("data")
            .and_then(|data| data.get("content"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        content = Some(text.to_owned());
    }
    content
}

fn copilot_sidecar_command(args: Vec<String>) -> Result<(String, Vec<String>)> {
    if let Ok(command) = env::var("AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND") {
        if !command.trim().is_empty() {
            return command_from_string(&command, args, "AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND");
        }
    }
    if let Some(command) = load_arc_config()?.sidecar_copilot_command {
        if !command.trim().is_empty() {
            return command_from_string(&command, args, "ARC config sidecarCopilotCommand");
        }
    }
    if let Ok(command) = env::var("AGENT_RUN_CACHE_COPILOT_COMMAND") {
        if !command.trim().is_empty() {
            return command_from_string(&command, args, "AGENT_RUN_CACHE_COPILOT_COMMAND");
        }
    }
    Ok((
        env::var("AGENT_RUN_CACHE_COPILOT_BIN").unwrap_or_else(|_| "copilot".to_owned()),
        args,
    ))
}

fn command_from_string(
    full_command: &str,
    args: Vec<String>,
    env_name: &str,
) -> Result<(String, Vec<String>)> {
    let mut parts = split_command(full_command)?;
    if parts.is_empty() {
        return Err(anyhow!("{env_name} did not contain a command."));
    }
    let command = parts.remove(0);
    let mut final_args = parts;
    if command == "ollama"
        && final_args.first().map(String::as_str) == Some("launch")
        && !final_args.iter().any(|arg| arg == "--")
    {
        final_args.push("--".to_owned());
    }
    final_args.extend(args);
    Ok((command, final_args))
}

fn split_command(command: &str) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if escaped {
        current.push('\\');
    }
    if quote.is_some() {
        return Err(anyhow!("Copilot command has an unterminated quote."));
    }
    if !current.is_empty() {
        parts.push(current);
    }
    Ok(parts)
}

fn run_process_capture(
    command: &str,
    args: &[String],
    cwd: PathBuf,
    input: &str,
) -> Result<String> {
    let mut child = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("AGENT_RUN_CACHE_IN_SIDECAR", "1")
        .spawn()
        .with_context(|| format!("failed to run sidecar command: {command}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(input.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(anyhow!(
            "{} failed with {}\n{}",
            command,
            output.status.code().unwrap_or(1),
            truncate(&String::from_utf8_lossy(&output.stderr), 4000)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn save_trace_events(events: &[ArcEvent], session_id: &str, workspace: &Path) -> Result<PathBuf> {
    let path = trace_path(session_id, workspace);
    write_jsonl(&path, events)?;
    debug(
        workspace,
        "trace.saved",
        json!({ "sessionId": session_id, "eventCount": events.len(), "path": path }),
    )?;
    Ok(path)
}

fn trace_hash(events: &[ArcEvent]) -> String {
    let mut hash = Sha256::new();
    for event in events {
        hash.update(event.id.as_bytes());
        hash.update([0]);
        hash.update(event.raw_type.as_deref().unwrap_or("").as_bytes());
        hash.update([0]);
        hash.update(event.timestamp.as_bytes());
        hash.update([0]);
    }
    hex::encode(hash.finalize())
}

fn is_arc_sidecar_session(events: &[ArcEvent]) -> bool {
    let markers = [
        "You are the Agent Run Cache sidecar",
        "You are the Agent Run Cache consulting sidecar",
        "You are the live Agent Run Cache observer sidecar",
    ];
    events.iter().any(|event| {
        event
            .text
            .as_deref()
            .is_some_and(|text| markers.iter().any(|marker| text.contains(marker)))
    })
}

fn is_stored_arc_event(raw: &Value) -> bool {
    raw.get("sessionId").is_some_and(Value::is_string)
        && raw.get("type").is_some_and(Value::is_string)
        && raw.get("timestamp").is_some_and(Value::is_string)
        && raw.get("source").is_some_and(Value::is_string)
}

fn session_id_from_events(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        event
            .get("data")
            .and_then(|data| data.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn session_id_from_spans(spans: &[&Value]) -> Option<String> {
    spans.iter().find_map(|span| {
        span.get("attributes")
            .and_then(|attributes| attributes.get("gen_ai.conversation.id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.is_empty())
    })
}

fn parse_otel_messages(value: Option<&Value>) -> Vec<Value> {
    let parsed = match value {
        Some(Value::String(text)) => parse_json_value(text).unwrap_or(Value::Null),
        Some(value) => value.clone(),
        None => Value::Null,
    };
    parsed
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_object())
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn otel_message_text(message: &Value) -> String {
    message
        .get("parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| {
                    part.get("type").and_then(Value::as_str) == Some("text")
                        || part.get("content").is_some()
                        || part.get("text").is_some()
                })
                .filter_map(|part| {
                    string_attr(part, "content").or_else(|| string_attr(part, "text"))
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_owned()
        })
        .unwrap_or_default()
}

fn command_from_otel_tool(tool_name: &str, argument_text: &str) -> String {
    if let Some(Value::Object(record)) = parse_json_value(argument_text) {
        if let Some(direct) = record
            .get("command")
            .and_then(Value::as_str)
            .or_else(|| record.get("cmd").and_then(Value::as_str))
            .or_else(|| record.get("script").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
        {
            return direct.to_owned();
        }
        if let Some(path) = record
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| record.get("file_path").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
        {
            return format!("{tool_name} {path}");
        }
        let compact = serde_json::to_string(&Value::Object(record)).unwrap_or_default();
        return if compact.len() > 500 {
            format!("{tool_name} {}...", truncate(&compact, 500))
        } else {
            format!("{tool_name} {compact}")
        };
    }
    tool_name.to_owned()
}

fn exit_code_from_otel_text(text: &str) -> Option<i64> {
    let re = Regex::new(r"(?i)\bexit\s+code:?\s+(-?\d+)\b").unwrap();
    if let Some(capture) = re.captures(text) {
        return capture.get(1).and_then(|value| value.as_str().parse().ok());
    }
    let re = Regex::new(r"(?i)\bexited\s+with\s+(-?\d+)\b").unwrap();
    re.captures(text)
        .and_then(|capture| capture.get(1))
        .and_then(|value| value.as_str().parse().ok())
}

fn timestamp_from(value: Option<&Value>, sequence: usize) -> String {
    if let Some(Value::Array(parts)) = value {
        if let Some(seconds) = parts.first().and_then(Value::as_f64) {
            let nanos = parts.get(1).and_then(Value::as_f64).unwrap_or(0.0);
            let millis = seconds * 1000.0 + (nanos / 1_000_000.0).floor() + sequence as f64;
            if millis.is_finite() && millis >= 0.0 {
                let system_time = UNIX_EPOCH + Duration::from_millis(millis as u64);
                return DateTime::<Utc>::from(system_time)
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
            }
        }
    }
    if let Some(text) = value.and_then(Value::as_str) {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
            let millis = parsed.timestamp_millis() + sequence as i64;
            if millis >= 0 {
                let system_time = UNIX_EPOCH + Duration::from_millis(millis as u64);
                return DateTime::<Utc>::from(system_time)
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
            }
        }
    }
    let system_time = SystemTime::now() + Duration::from_millis(sequence as u64);
    DateTime::<Utc>::from(system_time).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn stable_message_key(text: &str) -> String {
    collapse_whitespace(&text.to_lowercase())
}

fn strip_injected_prompt(value: &str) -> String {
    let user_task = "\n\nUser task:\n";
    let stripped = value
        .rfind(user_task)
        .map(|index| &value[index + user_task.len()..])
        .unwrap_or(value);
    let reminder = "\n\n<system_reminder>";
    stripped
        .find(reminder)
        .map(|index| stripped[..index].trim().to_owned())
        .unwrap_or_else(|| stripped.trim().to_owned())
}

fn parse_json_value(value: &str) -> Option<Value> {
    if value.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(value).ok()
}

fn string_attr(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

fn is_arc_event_type(value: &str) -> bool {
    matches!(
        value,
        "session_start"
            | "user_prompt"
            | "assistant_message"
            | "tool_start"
            | "tool_end"
            | "awaiting_input"
            | "session_end"
            | "unknown"
    )
}

fn user_message_text(data: &Value) -> String {
    let content = text_value(data.get("content")).unwrap_or_default();
    let marker = "\n\nUser task:\n";
    if let Some(index) = content.rfind(marker) {
        return strip_trailing_system_text(&content[index + marker.len()..]);
    }
    strip_trailing_system_text(&content)
}

fn strip_trailing_system_text(value: &str) -> String {
    let marker = "\n\n<system_reminder>";
    if let Some(index) = value.find(marker) {
        value[..index].trim().to_owned()
    } else {
        value.trim().to_owned()
    }
}

fn command_from(data: &Value) -> String {
    if let Some(command) = text_value(data.get("command")).filter(|value| !value.is_empty()) {
        return command;
    }
    let args = data
        .get("arguments")
        .or_else(|| data.get("args"))
        .or_else(|| data.get("input"));
    args.and_then(|value| {
        text_value(value.get("command"))
            .or_else(|| text_value(value.get("cmd")))
            .or_else(|| text_value(value.get("script")))
    })
    .unwrap_or_default()
}

fn text_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| text_value(Some(item)))
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(map) => text_value(map.get("text"))
            .or_else(|| text_value(map.get("content")))
            .or_else(|| text_value(map.get("message"))),
        _ => None,
    }
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| value.as_str().map(str::to_owned))
}

fn exit_code_from_text(text: &str) -> Option<i64> {
    let re = Regex::new(r"(?i)\bexit\s+code:?\s+(-?\d+)\b").unwrap();
    if let Some(capture) = re.captures(text) {
        return capture.get(1).and_then(|value| value.as_str().parse().ok());
    }
    let re = Regex::new(r"(?i)\bexited\s+with\s+exit\s+code\s+(-?\d+)\b").unwrap();
    re.captures(text)
        .and_then(|capture| capture.get(1))
        .and_then(|value| value.as_str().parse().ok())
}

#[cfg(test)]
mod split_harvest_tests {
    use super::*;
    use std::fs;

    // Reproduces the arc split bug: a Copilot session that never fires its
    // SessionEnd hook (the split is force-closed with Ctrl+q, killing Copilot)
    // produced no trace. harvest_latest_session must capture it anyway.
    #[test]
    fn harvests_session_that_never_fired_session_end() {
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("copilot-state");
        let session_id = "split-session-1";
        let session_dir = state_dir.join(session_id);
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("events.jsonl"),
            "{\"sessionId\":\"split-session-1\",\"type\":\"prompt\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"source\":\"copilot-transcript\",\"text\":\"ran a split session\"}\n",
        )
        .unwrap();

        let workspace = tmp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        std::env::set_var("AGENT_RUN_CACHE_COPILOT_STATE_DIR", &state_dir);

        // Before the fix nothing harvested this session, so no trace exists.
        assert!(!trace_path(session_id, &workspace).exists());

        let harvested = harvest_latest_session(&workspace).unwrap();

        std::env::remove_var("AGENT_RUN_CACHE_COPILOT_STATE_DIR");

        assert_eq!(harvested.as_deref(), Some(session_id));
        assert!(
            trace_path(session_id, &workspace).exists(),
            "split session should be harvested into a trace even though SessionEnd never fired"
        );
    }

    #[test]
    fn assembled_draft_preserves_completed_command_exit_and_output_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let trace = tmp.path().join("synthetic-trace.jsonl");
        let session_id = "evidence-session";
        let mut records = vec![json!({
            "type": "user.message",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "data": { "content": "verify the build" }
        })];
        for index in 0..12 {
            records.push(json!({
                "type": "tool.execution_complete",
                "timestamp": "2026-01-01T00:00:01.000Z",
                "data": {
                    "toolCallId": format!("read-{index}"),
                    "success": true,
                    "result": { "content": "source listing ".repeat(100) }
                }
            }));
        }
        records.push(json!({
            "type": "tool.execution_start",
            "timestamp": "2026-01-01T00:00:02.000Z",
            "data": {
                "toolCallId": "command-1",
                "toolName": "bash",
                "arguments": { "command": "run-build --check" }
            }
        }));
        records.push(json!({
            "type": "tool.execution_complete",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "data": {
                "toolCallId": "command-1",
                "success": true,
                "result": {
                    "content": format!(
                        "{}\nBUILD_OUTPUT_CONFIRMED\n<shellId: 1 completed with exit code 0>",
                        "old output\n".repeat(100)
                    )
                }
            }
        }));
        fs::write(
            &trace,
            records
                .iter()
                .map(|record| serde_json::to_string(record).unwrap())
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let events = read_copilot_transcript_events(&trace, &workspace, session_id).unwrap();
        let packet = build_evidence_packet(&events, &workspace, session_id);
        let draft = strong_review_input(&packet, "auto").unwrap();
        let evidence = draft
            .get("evidenceSnippets")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(
            draft.get("packetKind").and_then(Value::as_str),
            Some("assembled_draft")
        );
        assert!(evidence.contains("exit code 0"), "{evidence}");
        assert!(evidence.contains("BUILD_OUTPUT_CONFIRMED"), "{evidence}");
        assert!(evidence.contains("run-build --check"), "{evidence}");
    }

    #[test]
    fn second_review_with_same_merge_key_gets_recurrence_note() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let packet = |session_id: &str| EvidencePacket {
            runner: "copilot".to_owned(),
            session_id: session_id.to_owned(),
            workspace: workspace.to_string_lossy().to_string(),
            created_at: now_iso(),
            episodes: Vec::new(),
            prompts: vec!["verify the package".to_owned()],
            assistant_messages: Vec::new(),
            tool_events: Vec::new(),
            commands: vec!["package-check --target sample".to_owned()],
            paths: Vec::new(),
            event_count: 2,
            outcome: EvidenceOutcome {
                status: "success".to_owned(),
                confidence: 1.0,
                reasons: Vec::new(),
                success_signals: Vec::new(),
                failure_signals: Vec::new(),
                aborted_signals: Vec::new(),
            },
        };
        let first = strong_review_input(&packet("session-one"), "auto").unwrap();
        let second = strong_review_input(&packet("session-two"), "auto").unwrap();
        assert_eq!(first.get("mergeKey"), second.get("mergeKey"));
        record_declined_draft(
            &workspace,
            &first,
            "session-one",
            "success",
            "looked one-off",
        )
        .unwrap();

        let recurrence = recurrence_context(&second, &workspace, "session-two")
            .unwrap()
            .unwrap();
        let context =
            review_context_from_options(&ReviewOptions::default(), Some(&recurrence)).unwrap();
        let prompt = review_prompt(&second, &[], Some(&context));

        assert_eq!(recurrence.count, 2);
        assert!(
            prompt.contains("observed 2 times across sessions"),
            "{prompt}"
        );
        assert!(
            prompt.contains("previously declined: looked one-off"),
            "{prompt}"
        );
        assert!(
            prompt.contains("Recurrence is evidence of reusability"),
            "{prompt}"
        );

        let mut capsule = Map::new();
        add_recurrence_provenance(&mut capsule, &recurrence, "session-two");
        assert_eq!(
            capsule
                .get("provenance")
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .and_then(Value::as_str),
            Some("recurrenceCount: 2")
        );
    }
}
