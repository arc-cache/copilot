use super::*;

pub(crate) fn load_capsules(workspace: &Path) -> Result<Vec<Capsule>> {
    let values = read_jsonl_values(&memory_path(workspace))?;
    let capsules = values
        .into_iter()
        .filter(is_capsule_value)
        .filter_map(|value| capsule_from_value(value, workspace).ok())
        .collect::<Vec<_>>();
    Ok(compact_capsules(capsules))
}

fn capsule_from_value(mut value: Value, workspace: &Path) -> Result<Capsule> {
    if let Value::Object(map) = &mut value {
        if !map.contains_key("reusable") {
            map.insert("reusable".to_owned(), Value::Bool(true));
        }
    }
    let capsule: Capsule = serde_json::from_value(value)?;
    Ok(normalize_capsule(capsule, workspace, None))
}

fn normalize_capsule(
    mut input: Capsule,
    workspace: &Path,
    now_override: Option<String>,
) -> Capsule {
    let now = now_override.unwrap_or_else(|| {
        if input.updated_at.trim().is_empty() {
            now_iso()
        } else {
            input.updated_at.clone()
        }
    });
    let workflow = normalize_workflow(input.workflow, workspace);
    let source_session_id = clean(&input.source_session_id);
    let source_session_id = if source_session_id.is_empty() {
        "unknown".to_owned()
    } else {
        source_session_id
    };
    let source_session_ids = if clean_list(&input.source_session_ids).is_empty() {
        clean_list(std::slice::from_ref(&source_session_id))
    } else {
        clean_list(&input.source_session_ids)
    };
    let next_run = clean_for_workspace(&input.next_run_instruction, workspace);
    Capsule {
        id: if clean(&input.id).is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            clean(&input.id)
        },
        runner: if clean(&input.runner).is_empty() {
            "copilot".to_owned()
        } else {
            clean(&input.runner)
        },
        workspace: if clean(&input.workspace).is_empty() {
            workspace.to_string_lossy().to_string()
        } else {
            clean(&input.workspace)
        },
        workspace_key: if clean(&input.workspace_key).is_empty() {
            workspace_key(workspace)
        } else {
            clean(&input.workspace_key)
        },
        workspace_group: if clean(&input.workspace_group).is_empty() {
            workspace_group()
        } else {
            clean(&input.workspace_group)
        },
        source_session_id,
        source_session_ids,
        created_at: if clean(&input.created_at).is_empty() {
            now.clone()
        } else {
            clean(&input.created_at)
        },
        updated_at: now,
        status: normalize_status(&input.status),
        privacy_label: normalize_privacy_label(&input.privacy_label),
        contributors: if clean_list(&input.contributors).is_empty() {
            default_contributors()
        } else {
            clean_list(&input.contributors)
        },
        use_count: input.use_count,
        success_count: input.success_count,
        failure_count: input.failure_count,
        kind: if clean(&input.kind).is_empty() {
            "workflow".to_owned()
        } else {
            clean(&input.kind)
        },
        merge_key: clean(&input.merge_key),
        title: if clean(&input.title).is_empty() {
            "Reusable agent workflow".to_owned()
        } else {
            clean(&input.title)
        },
        summary: clean_for_workspace(&input.summary, workspace),
        reusable: input.reusable,
        confidence: clamp(
            if input.confidence == 0.0 {
                0.7
            } else {
                input.confidence
            },
            0.0,
            1.0,
        ),
        reuse_when: clean_list_for_workspace(&input.reuse_when, workspace),
        do_not_reuse_when: clean_list_for_workspace(&input.do_not_reuse_when, workspace),
        evidence: clean_list_for_workspace(&input.evidence, workspace),
        provenance: clean_list_for_workspace(&input.provenance, workspace),
        artifact_sources: clean_list_for_workspace(&input.artifact_sources, workspace),
        supersedes: clean_list(&input.supersedes),
        superseded_by: clean_list(&input.superseded_by),
        confidence_reason: clean_for_workspace(&input.confidence_reason, workspace),
        failure_boundary: clean_list_for_workspace(&input.failure_boundary, workspace),
        validation_provenance: clean_list_for_workspace(&input.validation_provenance, workspace),
        outcome_status: normalize_outcome_status(&input.outcome_status),
        next_run_instruction: if next_run.is_empty() {
            workflow.steps.join(" ")
        } else {
            next_run
        },
        workflow,
        embedding: normalize_embedding(input.embedding.take()),
        graph: normalize_graph(input.graph.take()),
        binding_snapshots: normalize_binding_snapshots(input.binding_snapshots.take()),
        staleness: normalize_staleness(input.staleness.take()),
    }
}

fn normalize_workflow(input: WorkflowCapsule, workspace: &Path) -> WorkflowCapsule {
    WorkflowCapsule {
        purpose: clean_for_workspace(&input.purpose, workspace),
        parameters: clean_list_for_workspace(&input.parameters, workspace),
        binding_sources: clean_list_for_workspace(&input.binding_sources, workspace),
        steps: clean_list_for_workspace(&input.steps, workspace),
        commands: clean_list_for_workspace(&input.commands, workspace),
        success_criteria: clean_list_for_workspace(&input.success_criteria, workspace),
        failed_attempts: clean_list_for_workspace(&input.failed_attempts, workspace),
        validation_probe: clean_list_for_workspace(&input.validation_probe, workspace),
    }
}

fn normalize_embedding(value: Option<CapsuleEmbedding>) -> Option<CapsuleEmbedding> {
    let mut embedding = value?;
    embedding.vector.retain(|v| v.is_finite());
    embedding.vector.truncate(8192);
    embedding.model = clean(&embedding.model);
    embedding.text_hash = clean(&embedding.text_hash);
    embedding.created_at = if clean(&embedding.created_at).is_empty() {
        now_iso()
    } else {
        clean(&embedding.created_at)
    };
    if embedding.model.is_empty() || embedding.text_hash.is_empty() || embedding.vector.is_empty() {
        None
    } else {
        Some(embedding)
    }
}

fn normalize_graph(value: Option<Vec<CapsuleGraphEdge>>) -> Option<Vec<CapsuleGraphEdge>> {
    let mut graph = Vec::new();
    for mut edge in value.unwrap_or_default() {
        let kind = match edge.kind.as_str() {
            "duplicate" | "supersedes" | "similar" => edge.kind,
            _ => continue,
        };
        edge.to = clean(&edge.to);
        if edge.to.is_empty() {
            continue;
        }
        edge.kind = kind;
        edge.score = edge.score.map(|score| clamp(score, -1.0, 1.0));
        edge.reason = clean(&edge.reason);
        edge.created_at = if clean(&edge.created_at).is_empty() {
            now_iso()
        } else {
            clean(&edge.created_at)
        };
        graph.push(edge);
    }
    graph.truncate(24);
    if graph.is_empty() {
        None
    } else {
        Some(graph)
    }
}

fn normalize_binding_snapshots(
    value: Option<Vec<BindingSourceSnapshot>>,
) -> Option<Vec<BindingSourceSnapshot>> {
    let mut snapshots = Vec::new();
    for mut snapshot in value.unwrap_or_default() {
        snapshot.source = clean(&snapshot.source);
        if snapshot.source.is_empty() {
            continue;
        }
        snapshot.hash = snapshot
            .hash
            .map(|hash| clean(&hash))
            .filter(|hash| !hash.is_empty());
        snapshot.captured_at = if clean(&snapshot.captured_at).is_empty() {
            now_iso()
        } else {
            clean(&snapshot.captured_at)
        };
        snapshots.push(snapshot);
    }
    snapshots.truncate(24);
    if snapshots.is_empty() {
        None
    } else {
        Some(snapshots)
    }
}

fn normalize_staleness(value: Option<CapsuleStaleness>) -> Option<CapsuleStaleness> {
    let mut staleness = value?;
    staleness.checked_at = if clean(&staleness.checked_at).is_empty() {
        now_iso()
    } else {
        clean(&staleness.checked_at)
    };
    staleness.reasons = clean_list(&staleness.reasons);
    staleness.reasons.truncate(12);
    Some(staleness)
}

pub(crate) fn update_capsule_metadata(
    id_or_prefix: &str,
    status: Option<&str>,
    privacy: Option<&str>,
    workspace: &Path,
) -> Result<Option<Capsule>> {
    let mut capsules = load_capsules(workspace)?;
    let Some(index) = capsules
        .iter()
        .position(|capsule| capsule.id == id_or_prefix || capsule.id.starts_with(id_or_prefix))
    else {
        return Ok(None);
    };
    let now = now_iso();
    if let Some(status) = status {
        capsules[index].status = normalize_status(status);
    }
    if let Some(privacy) = privacy {
        capsules[index].privacy_label = normalize_privacy_label(privacy);
    }
    capsules[index].updated_at = now;
    write_jsonl(&memory_path(workspace), &capsules)?;
    debug(
        workspace,
        "capsule.metadata_updated",
        json!({
            "id": capsules[index].id,
            "title": capsules[index].title,
            "status": capsules[index].status,
            "privacyLabel": capsules[index].privacy_label,
            "workspaceGroup": capsules[index].workspace_group
        }),
    )?;
    record_memory_event(
        workspace,
        "capsule.privacy_updated",
        Some(capsules[index].source_session_id.clone()),
        None,
        Some(capsules[index].id.clone()),
        Some(json!({
            "title": capsules[index].title,
            "status": capsules[index].status,
            "privacyLabel": capsules[index].privacy_label,
            "workspaceGroup": capsules[index].workspace_group
        })),
    )?;
    Ok(Some(capsules[index].clone()))
}

pub(crate) fn save_capsule(mut input: Capsule, workspace: &Path) -> Result<Option<Capsule>> {
    if !input.reusable {
        return Ok(None);
    }
    let now = now_iso();
    input = normalize_capsule(input, workspace, Some(now.clone()));
    let mut existing = load_capsules(workspace)?;
    let index = find_merge_index(&existing, &input);
    let previous_outcome_status = index.map(|idx| existing[idx].outcome_status.clone());
    if let Some(index) = index {
        existing[index] = merge_capsules(&existing[index], &input, &now);
    } else {
        existing.push(input.clone());
    }
    let saved = if let Some(index) = find_merge_index(&existing, &input) {
        existing[index].clone()
    } else {
        input.clone()
    };
    let superseded = apply_supersession(&mut existing, &saved);
    write_jsonl(&memory_path(workspace), &existing)?;
    debug(
        workspace,
        "capsule.saved",
        json!({
            "title": input.title,
            "id": saved.id,
            "sessionId": input.source_session_id,
            "durableCapsuleId": saved.id,
            "draftCapsuleId": input.id,
            "replacementCandidateId": if input.id != saved.id { Some(input.id.clone()) } else { None },
            "replaced": previous_outcome_status.is_some()
        }),
    )?;
    record_memory_event(
        workspace,
        if previous_outcome_status.is_some() {
            "capsule.updated"
        } else {
            "capsule.created"
        },
        Some(saved.source_session_id.clone()),
        None,
        Some(saved.id.clone()),
        Some(json!({
            "title": saved.title,
            "mergeKey": saved.merge_key,
            "kind": saved.kind,
            "outcomeStatus": saved.outcome_status,
            "sourceOutcomeStatuses": previous_outcome_status.as_ref().map(|previous| json!({
                "existing": previous,
                "incoming": input.outcome_status,
                "final": saved.outcome_status
            })),
            "sourceSessionIds": saved.source_session_ids
        })),
    )?;
    if previous_outcome_status.is_some() && input.id != saved.id {
        record_capsule_merged_event(
            workspace,
            &input,
            &saved,
            "save matched an existing durable capsule",
        )?;
    }
    for capsule_id in superseded {
        record_memory_event(
            workspace,
            "capsule.superseded",
            Some(saved.source_session_id.clone()),
            None,
            Some(capsule_id),
            Some(json!({
                "supersededBy": saved.id,
                "supersedingTitle": saved.title
            })),
        )?;
    }
    Ok(Some(saved))
}

fn record_capsule_merged_event(
    workspace: &Path,
    from: &Capsule,
    to: &Capsule,
    reason: &str,
) -> Result<()> {
    record_memory_event(
        workspace,
        "capsule.merged",
        Some(from.source_session_id.clone()),
        None,
        Some(from.id.clone()),
        Some(json!({
            "fromCapsuleId": from.id,
            "toCapsuleId": to.id,
            "fromKind": from.kind,
            "toKind": to.kind,
            "fromMergeKey": from.merge_key,
            "toMergeKey": to.merge_key,
            "movedSourceSessionIds": unique_strings(
                from.source_session_ids
                    .iter()
                    .chain(std::iter::once(&from.source_session_id))
                    .cloned()
                    .collect()
            ),
            "reason": reason
        })),
    )?;
    Ok(())
}

fn apply_supersession(capsules: &mut [Capsule], superseding: &Capsule) -> Vec<String> {
    let refs = superseding
        .supersedes
        .iter()
        .map(|value| normalize_key(value))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    if refs.is_empty() {
        return Vec::new();
    }
    let mut superseded = Vec::new();
    for capsule in capsules {
        if capsule.id == superseding.id {
            continue;
        }
        let candidates = [
            normalize_key(&capsule.id),
            normalize_key(&capsule.merge_key),
            normalize_key(&capsule.title),
        ];
        if !candidates.iter().any(|candidate| refs.contains(candidate)) {
            continue;
        }
        capsule.superseded_by = unique_strings(
            capsule
                .superseded_by
                .iter()
                .chain(std::iter::once(&superseding.id))
                .cloned()
                .collect(),
        );
        if !capsule.kind.to_lowercase().contains("fact") {
            capsule.reusable = false;
        }
        capsule.status = "superseded".to_owned();
        superseded.push(capsule.id.clone());
    }
    superseded
}

pub(crate) fn increment_capsule_use(
    id_or_prefix: &str,
    workspace: &Path,
) -> Result<Option<Capsule>> {
    let mut capsules = load_capsules(workspace)?;
    let Some(index) = capsules
        .iter()
        .position(|capsule| capsule.id == id_or_prefix || capsule.id.starts_with(id_or_prefix))
    else {
        return Ok(None);
    };
    capsules[index].use_count += 1;
    capsules[index].updated_at = now_iso();
    write_jsonl(&memory_path(workspace), &capsules)?;
    debug(
        workspace,
        "capsule.use_count_updated",
        json!({
            "id": capsules[index].id,
            "title": capsules[index].title,
            "useCount": capsules[index].use_count
        }),
    )?;
    Ok(Some(capsules[index].clone()))
}

fn compact_capsules(capsules: Vec<Capsule>) -> Vec<Capsule> {
    let mut compacted: Vec<Capsule> = Vec::new();
    for capsule in capsules {
        if let Some(index) = find_merge_index(&compacted, &capsule) {
            let now = latest_timestamp(&compacted[index].updated_at, &capsule.updated_at);
            compacted[index] = merge_capsules(&compacted[index], &capsule, &now);
        } else {
            compacted.push(capsule);
        }
    }
    compacted
}

fn find_merge_index(existing: &[Capsule], capsule: &Capsule) -> Option<usize> {
    let key = stable_key(capsule);
    if let Some(index) = existing.iter().position(|item| stable_key(item) == key) {
        return Some(index);
    }
    existing
        .iter()
        .position(|item| can_fuzzy_merge(item, capsule) && likely_same_capsule(item, capsule))
}

fn stable_key(capsule: &Capsule) -> String {
    if !capsule.merge_key.is_empty() {
        return normalize_key(&format!("merge\n{}\n{}", capsule.kind, capsule.merge_key));
    }
    normalize_key(&format!(
        "{}\n{}\n{}\n{}",
        capsule.kind,
        capsule.workflow.purpose,
        capsule.workflow.parameters.join(" "),
        capsule.workflow.commands.join(" ")
    ))
}

fn likely_same_capsule(left: &Capsule, right: &Capsule) -> bool {
    let shared_commands = overlap(&left.workflow.commands, &right.workflow.commands);
    let shared_bindings = overlap(
        &left.workflow.binding_sources,
        &right.workflow.binding_sources,
    );
    if shared_commands && shared_bindings {
        return true;
    }
    let identity_score = token_similarity(&identity_text(left), &identity_text(right));
    if shared_bindings && identity_score >= 0.5 {
        return true;
    }
    let command_overlap = token_overlap(&command_shape_text(left), &command_shape_text(right));
    let binding_overlap = token_overlap(&binding_text(left), &binding_text(right));
    let fingerprint_overlap = token_overlap(&fingerprint_text(left), &fingerprint_text(right));
    if binding_overlap.0 >= 0.45 && fingerprint_overlap.0 >= 0.55 && fingerprint_overlap.1 >= 6 {
        return true;
    }
    if command_overlap.0 >= 0.65 && identity_score >= 0.35 && fingerprint_overlap.1 >= 6 {
        return true;
    }
    command_overlap.0 >= 0.55 && binding_overlap.0 >= 0.25 && fingerprint_overlap.1 >= 7
}

fn can_fuzzy_merge(left: &Capsule, right: &Capsule) -> bool {
    let left_identity = explicit_merge_identity(left);
    let right_identity = explicit_merge_identity(right);
    left_identity.is_empty() || right_identity.is_empty() || left_identity == right_identity
}

fn explicit_merge_identity(capsule: &Capsule) -> String {
    if capsule.merge_key.is_empty() {
        String::new()
    } else {
        normalize_key(&format!("{}\n{}", capsule.kind, capsule.merge_key))
    }
}

fn merge_capsules(existing: &Capsule, incoming: &Capsule, now: &str) -> Capsule {
    let coherent_core = coherent_core_update(existing, incoming);
    let mut next = existing.clone();
    next.updated_at = now.to_owned();
    if next.workspace_key.is_empty() {
        next.workspace_key = incoming.workspace_key.clone();
    }
    if next.workspace_group.is_empty() {
        next.workspace_group = incoming.workspace_group.clone();
    }
    next.status = merge_status(&existing.status, &incoming.status);
    next.privacy_label = merge_privacy_label(&existing.privacy_label, &incoming.privacy_label);
    next.contributors = unique_strings(
        existing
            .contributors
            .iter()
            .chain(incoming.contributors.iter())
            .cloned()
            .collect(),
    );
    next.use_count = existing.use_count.max(incoming.use_count);
    next.success_count = existing.success_count.max(incoming.success_count);
    next.failure_count = existing.failure_count.max(incoming.failure_count);
    next.source_session_id = incoming.source_session_id.clone();
    next.source_session_ids = unique_strings(
        existing
            .source_session_ids
            .iter()
            .chain(std::iter::once(&existing.source_session_id))
            .chain(incoming.source_session_ids.iter())
            .chain(std::iter::once(&incoming.source_session_id))
            .cloned()
            .collect(),
    );
    next.kind = merge_kind(&existing.kind, &incoming.kind);
    if next.merge_key.is_empty() {
        next.merge_key = incoming.merge_key.clone();
    }
    if coherent_core {
        next.title = prefer_longer(&existing.title, &incoming.title);
        next.summary = prefer_longer(&existing.summary, &incoming.summary);
        next.next_run_instruction = prefer_longer(
            &existing.next_run_instruction,
            &incoming.next_run_instruction,
        );
        next.workflow = merge_workflows(&existing.workflow, &incoming.workflow, true);
    }
    next.reusable = existing.reusable || incoming.reusable;
    next.confidence = existing.confidence.max(incoming.confidence);
    next.reuse_when = unique_limited(&existing.reuse_when, &incoming.reuse_when, 24);
    next.do_not_reuse_when =
        unique_limited(&existing.do_not_reuse_when, &incoming.do_not_reuse_when, 24);
    next.evidence = unique_limited(&existing.evidence, &incoming.evidence, 32);
    next.provenance = unique_limited(&existing.provenance, &incoming.provenance, 32);
    next.artifact_sources =
        unique_limited(&existing.artifact_sources, &incoming.artifact_sources, 24);
    next.supersedes = unique_limited(&existing.supersedes, &incoming.supersedes, 24);
    next.superseded_by = unique_limited(&existing.superseded_by, &incoming.superseded_by, 24);
    next.confidence_reason =
        prefer_longer(&existing.confidence_reason, &incoming.confidence_reason);
    next.failure_boundary =
        unique_limited(&existing.failure_boundary, &incoming.failure_boundary, 24);
    next.validation_provenance = unique_limited(
        &existing.validation_provenance,
        &incoming.validation_provenance,
        24,
    );
    next.outcome_status = prefer_outcome(&existing.outcome_status, &incoming.outcome_status);
    next.embedding = incoming
        .embedding
        .clone()
        .or_else(|| existing.embedding.clone());
    next.graph = merge_graph(existing.graph.clone(), incoming.graph.clone());
    if incoming
        .binding_snapshots
        .as_ref()
        .map(Vec::len)
        .unwrap_or(0)
        > 0
    {
        next.binding_snapshots = incoming.binding_snapshots.clone();
    }
    if incoming.staleness.is_some() {
        next.staleness = incoming.staleness.clone();
    }
    next
}

fn coherent_core_update(existing: &Capsule, incoming: &Capsule) -> bool {
    let overlap = token_overlap(&core_identity_text(existing), &core_identity_text(incoming));
    let command_overlap =
        token_overlap(&command_shape_text(existing), &command_shape_text(incoming));
    (overlap.0 >= 0.45 && overlap.1 >= 4) || command_overlap.0 >= 0.65
}

fn merge_workflows(
    existing: &WorkflowCapsule,
    incoming: &WorkflowCapsule,
    coherent_core: bool,
) -> WorkflowCapsule {
    WorkflowCapsule {
        purpose: if coherent_core {
            prefer_longer(&existing.purpose, &incoming.purpose)
        } else {
            existing.purpose.clone()
        },
        parameters: unique_limited(&existing.parameters, &incoming.parameters, 24),
        binding_sources: unique_limited(&existing.binding_sources, &incoming.binding_sources, 24),
        steps: unique_limited(&existing.steps, &incoming.steps, 24),
        commands: unique_limited(&existing.commands, &incoming.commands, 16),
        success_criteria: unique_limited(
            &existing.success_criteria,
            &incoming.success_criteria,
            24,
        ),
        failed_attempts: unique_limited(&existing.failed_attempts, &incoming.failed_attempts, 24),
        validation_probe: unique_limited(
            &existing.validation_probe,
            &incoming.validation_probe,
            12,
        ),
    }
}

fn merge_graph(
    left: Option<Vec<CapsuleGraphEdge>>,
    right: Option<Vec<CapsuleGraphEdge>>,
) -> Option<Vec<CapsuleGraphEdge>> {
    let mut values = left.unwrap_or_default();
    values.extend(right.unwrap_or_default());
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for edge in values {
        let key = format!("{}:{}", edge.kind, edge.to);
        if seen.insert(key) {
            merged.push(edge);
        }
    }
    merged.truncate(24);
    Some(merged)
}
