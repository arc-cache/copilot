use super::*;

pub(crate) fn search_capsules_for_query(
    query: &str,
    workspace: &Path,
    limit: usize,
) -> Result<Vec<CapsuleSearchResult>> {
    let normalized = normalize(query);
    let capsules = load_capsules(workspace)?
        .into_iter()
        .filter(is_retrievable_capsule)
        .filter(|capsule| !matches_do_not_reuse(&normalized, capsule))
        .collect::<Vec<_>>();
    if capsules.is_empty() {
        return Ok(Vec::new());
    }
    let reputation = load_retrieval_reputation(workspace)?;
    let prompt_vector =
        embed_texts(&[query.to_owned()], workspace)?.and_then(|vectors| vectors.into_iter().next());
    let capsules = if prompt_vector.is_some() {
        ensure_embeddings_for_capsules(capsules, workspace)?
    } else {
        capsules
    };
    let mut scored = Vec::new();
    for capsule in capsules {
        let semantic_score = prompt_vector
            .as_ref()
            .and_then(|prompt| {
                capsule
                    .embedding
                    .as_ref()
                    .map(|embedding| cosine(prompt, &embedding.vector))
            })
            .unwrap_or(-1.0);
        let lexical_score = score_capsule(&normalized, &capsule);
        let source = if semantic_score >= embedding_threshold() {
            "embedding"
        } else {
            "lexical"
        };
        let score = if source == "embedding" {
            semantic_score
        } else {
            lexical_score
        };
        if score <= 0.0 {
            continue;
        }
        let multiplier = reputation.get(&capsule.id).copied().unwrap_or(1.0);
        scored.push(CapsuleSearchResult {
            id: capsule.id,
            title: capsule.title,
            summary: capsule.summary,
            score,
            adjusted_score: score * multiplier,
            reputation: multiplier,
            source: source.to_owned(),
            reuse_when: capsule.reuse_when,
            next_run_instruction: capsule.next_run_instruction,
        });
    }
    scored.sort_by(|a, b| {
        b.adjusted_score
            .partial_cmp(&a.adjusted_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    scored.truncate(limit.clamp(1, 20));
    Ok(scored)
}

pub(crate) fn build_injection_plan(
    prompt: &str,
    workspace: &Path,
    context: InjectionContext,
    explicit_consult: bool,
) -> Result<InjectionPlan> {
    let pause = injection_pause_status(&load_arc_config()?);
    if pause.paused {
        return Ok(no_plan(&pause.label, Some("local"), None));
    }
    if non_task_prompt(prompt) {
        return Ok(no_plan("small-talk prompt", Some("local"), None));
    }
    let capsules = load_capsules(workspace)?;
    let normalized_prompt = normalize(prompt);
    if matches_any_do_not_reuse(&normalized_prompt, &capsules) {
        return Ok(no_plan(
            "prompt matched a do-not-reuse guard",
            Some("local"),
            None,
        ));
    }
    let action_risk = action_risk_gate(prompt);
    let candidate_capsules = if action_risk.is_some() {
        capsules
            .iter()
            .filter(|capsule| !live_action_capsule(capsule))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        capsules.clone()
    };
    if candidate_capsules.is_empty() {
        let reason = action_risk
            .as_deref()
            .unwrap_or("no matching capsule")
            .to_owned();
        return Ok(no_plan(&reason, Some("local"), action_risk));
    }
    let ranked = rank_capsules(prompt, &candidate_capsules, workspace)?;
    let shortlist = if ranked.available {
        ranked.shortlist.clone()
    } else {
        shortlist_capsules(prompt, &candidate_capsules, 8)
    };
    if ranked.available && shortlist.is_empty() {
        return Ok(no_plan(&ranked.reason, Some("local"), action_risk));
    }
    let config = load_arc_config()?;
    let judge_mode = config
        .injection_judge_mode
        .as_deref()
        .unwrap_or("embedding-only");
    let provider_judge_configured =
        judge_mode == "provider-judge" && config.injection_judge_model.is_some();
    let should_judge = explicit_consult
        || (provider_judge_configured && should_use_provider_judge(judge_mode, &ranked));
    let mut sidecar: Option<SidecarConsult> = None;
    let mut sidecar_failure: Option<String> = None;
    let mut judge_decision_id: Option<String> = None;
    if should_judge {
        match consult_capsule_vault(
            prompt,
            &shortlist,
            workspace,
            config.injection_judge_model.clone(),
        ) {
            Ok(result) => {
                let accepted = result.applies
                    && result.capsule_id.is_some()
                    && (explicit_consult
                        || judge_confidence(result.confidence)
                            >= provider_judge_confidence_threshold());
                if judge_mode == "provider-judge" {
                    let decision = record_judge_decision(
                        workspace,
                        context.session_id.clone(),
                        prompt,
                        "provider-judge",
                        config.injection_judge_model.clone(),
                        ranked_candidates(&ranked, &shortlist),
                        if accepted {
                            JudgeVerdict {
                                inject: result.capsule_id.clone(),
                                abstain: None,
                                confidence: Some(result.confidence.unwrap_or(0.5)),
                                reason: result.reason.clone(),
                            }
                        } else {
                            JudgeVerdict {
                                inject: None,
                                abstain: Some(true),
                                confidence: Some(result.confidence.unwrap_or(0.5)),
                                reason: Some(
                                    result
                                        .reason
                                        .clone()
                                        .unwrap_or_else(|| "judge abstained".to_owned()),
                                ),
                            }
                        },
                        Some(JudgeOutcome {
                            injected: Some(accepted),
                            used: Some("unknown".to_owned()),
                            helped: Some("unknown".to_owned()),
                        }),
                    )?;
                    judge_decision_id = Some(decision.id);
                }
                sidecar = Some(result);
            }
            Err(error) => {
                sidecar_failure = Some(summarize_sidecar_failure(&error.to_string()));
                debug(
                    workspace,
                    "retrieval.sidecar_failed",
                    json!({ "error": error.to_string(), "reason": sidecar_failure }),
                )?;
            }
        }
    } else if provider_judge_configured && ranked.available {
        let high = provider_judge_high_confidence(&ranked);
        let decision = record_judge_decision(
            workspace,
            context.session_id.clone(),
            prompt,
            "provider-judge",
            config.injection_judge_model.clone(),
            ranked_candidates(&ranked, &shortlist),
            if high {
                JudgeVerdict {
                    inject: ranked.best.as_ref().map(|c| c.id.clone()),
                    abstain: None,
                    confidence: ranked.top_score,
                    reason: Some("embedding score above high band; judge skipped".to_owned()),
                }
            } else {
                JudgeVerdict {
                    inject: None,
                    abstain: Some(true),
                    confidence: ranked.top_score,
                    reason: Some(if ranked.available {
                        "embedding score below judge band".to_owned()
                    } else {
                        ranked.reason.clone()
                    }),
                }
            },
            Some(JudgeOutcome {
                injected: Some(high && ranked.best.is_some()),
                used: Some("unknown".to_owned()),
                helped: Some("unknown".to_owned()),
            }),
        )?;
        judge_decision_id = Some(decision.id);
    }
    let mode = if orienting_prompt(prompt) {
        "orient"
    } else {
        "act"
    };
    if let Some(sidecar) = sidecar {
        let accepted = sidecar.applies
            && sidecar.capsule_id.is_some()
            && (explicit_consult
                || judge_confidence(sidecar.confidence) >= provider_judge_confidence_threshold());
        if accepted {
            let capsule_id = sidecar.capsule_id.clone().unwrap();
            if let Some(capsule) = shortlist
                .iter()
                .chain(candidate_capsules.iter())
                .find(|item| item.id == capsule_id)
            {
                if !matches_do_not_reuse(&normalized_prompt, capsule) {
                    let used = increment_capsule_use(&capsule.id, workspace)?
                        .unwrap_or_else(|| capsule.clone());
                    return Ok(InjectionPlan {
                        should_inject: true,
                        message: format_sidecar_consult_note(
                            &used,
                            sidecar.note.as_deref(),
                            mode,
                            prompt,
                        ),
                        reason: sidecar
                            .reason
                            .unwrap_or_else(|| format!("sidecar selected capsule {}", used.id)),
                        source: Some("sidecar".to_owned()),
                        capsule: Some(used.clone()),
                        judge_decision_id,
                        consult_applied: Some(true),
                        consult_capsule_id: Some(used.id),
                        consult_abstain_reason: None,
                        action_risk,
                    });
                }
            }
        }
        return Ok(InjectionPlan {
            should_inject: false,
            message: String::new(),
            reason: if !sidecar.applies {
                sidecar
                    .reason
                    .clone()
                    .unwrap_or_else(|| "consult sidecar declined capsule reuse".to_owned())
            } else {
                format!(
                    "consult sidecar confidence below {:.2}",
                    provider_judge_confidence_threshold()
                )
            },
            source: Some("sidecar".to_owned()),
            capsule: None,
            judge_decision_id,
            consult_applied: Some(false),
            consult_capsule_id: None,
            consult_abstain_reason: Some(if !sidecar.applies {
                sidecar
                    .reason
                    .unwrap_or_else(|| "consult sidecar declined capsule reuse".to_owned())
            } else {
                format!(
                    "consult sidecar confidence below {:.2}",
                    provider_judge_confidence_threshold()
                )
            }),
            action_risk,
        });
    }
    let capsule = if ranked.available {
        ranked.best.clone()
    } else {
        select_capsule(prompt, &candidate_capsules)
    };
    let Some(capsule) = capsule else {
        return Ok(no_plan(
            sidecar_failure.as_deref().unwrap_or("no matching capsule"),
            Some("local"),
            action_risk,
        )
        .with_judge(judge_decision_id));
    };
    let used = increment_capsule_use(&capsule.id, workspace)?.unwrap_or(capsule);
    Ok(InjectionPlan {
        should_inject: true,
        message: format_capsule_note(&used, mode, prompt),
        reason: if ranked.available {
            ranked.reason
        } else {
            format!("matched capsule {}", used.id)
        },
        source: Some("local".to_owned()),
        capsule: Some(used),
        judge_decision_id,
        consult_applied: None,
        consult_capsule_id: None,
        consult_abstain_reason: None,
        action_risk,
    })
}

trait PlanExt {
    fn with_judge(self, judge_decision_id: Option<String>) -> Self;
}

impl PlanExt for InjectionPlan {
    fn with_judge(mut self, judge_decision_id: Option<String>) -> Self {
        self.judge_decision_id = judge_decision_id;
        self
    }
}

fn no_plan(reason: &str, source: Option<&str>, action_risk: Option<String>) -> InjectionPlan {
    InjectionPlan {
        should_inject: false,
        capsule: None,
        message: String::new(),
        reason: reason.to_owned(),
        source: source.map(str::to_owned),
        judge_decision_id: None,
        consult_applied: None,
        consult_capsule_id: None,
        consult_abstain_reason: None,
        action_risk,
    }
}

#[derive(Clone)]
struct RankedCapsules {
    available: bool,
    shortlist: Vec<Capsule>,
    best: Option<Capsule>,
    scores: Vec<RankedCapsuleScore>,
    top_score: Option<f64>,
    reason: String,
}

#[derive(Clone)]
struct RankedCapsuleScore {
    capsule: Capsule,
    score: f64,
    adjusted_score: f64,
    reputation: f64,
}

fn rank_capsules(prompt: &str, capsules: &[Capsule], workspace: &Path) -> Result<RankedCapsules> {
    let reusable = capsules
        .iter()
        .filter(|capsule| is_retrievable_capsule(capsule))
        .filter(|capsule| !matches_do_not_reuse(&normalize(prompt), capsule))
        .cloned()
        .collect::<Vec<_>>();
    if reusable.is_empty() {
        return Ok(RankedCapsules {
            available: false,
            shortlist: Vec::new(),
            best: None,
            scores: Vec::new(),
            top_score: None,
            reason: "no retrievable capsules".to_owned(),
        });
    }
    let prompt_vector = embed_texts(&[prompt.to_owned()], workspace)?
        .and_then(|vectors| vectors.into_iter().next());
    let Some(prompt_vector) = prompt_vector else {
        return Ok(RankedCapsules {
            available: false,
            shortlist: Vec::new(),
            best: None,
            scores: Vec::new(),
            top_score: None,
            reason: "embeddings unavailable".to_owned(),
        });
    };
    let embedded = ensure_embeddings_for_capsules(reusable, workspace)?;
    let reputation = load_retrieval_reputation(workspace)?;
    let mut scored = Vec::new();
    for capsule in embedded {
        let score = capsule
            .embedding
            .as_ref()
            .map(|embedding| cosine(&prompt_vector, &embedding.vector))
            .unwrap_or(-1.0);
        let multiplier = reputation.get(&capsule.id).copied().unwrap_or(1.0);
        if score >= embedding_threshold() {
            scored.push(RankedCapsuleScore {
                capsule,
                score,
                adjusted_score: score * multiplier,
                reputation: multiplier,
            });
        }
    }
    scored.sort_by(|a, b| {
        b.adjusted_score
            .partial_cmp(&a.adjusted_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| {
                b.capsule
                    .confidence
                    .partial_cmp(&a.capsule.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let shortlist = scored
        .iter()
        .take(embedding_shortlist_limit())
        .map(|item| item.capsule.clone())
        .collect::<Vec<_>>();
    let best = shortlist.first().cloned();
    let top_score = scored.first().map(|item| item.score);
    let reason = if let Some(score) = top_score {
        format!(
            "embedding matched capsule {} at {:.3}",
            best.as_ref().map(|c| c.id.as_str()).unwrap_or("unknown"),
            score
        )
    } else {
        format!(
            "embedding distance gate abstained below {:.2}",
            embedding_threshold()
        )
    };
    Ok(RankedCapsules {
        available: true,
        shortlist,
        best,
        scores: scored,
        top_score,
        reason,
    })
}

pub(crate) fn ensure_embeddings_for_capsules(
    capsules: Vec<Capsule>,
    workspace: &Path,
) -> Result<Vec<Capsule>> {
    let mut fresh = Vec::new();
    let mut stale = Vec::new();
    for capsule in capsules {
        let hash = capsule_text_hash(&capsule);
        if capsule.embedding.as_ref().is_some_and(|embedding| {
            embedding.model == LOCAL_EMBEDDING_MODEL_NAME
                && embedding.text_hash == hash
                && !embedding.vector.is_empty()
        }) {
            fresh.push(capsule);
        } else {
            stale.push(capsule);
        }
    }
    if stale.is_empty() {
        return Ok(fresh);
    }
    let texts = stale.iter().map(capsule_embedding_text).collect::<Vec<_>>();
    let Some(vectors) = embed_texts(&texts, workspace)? else {
        fresh.extend(stale);
        return Ok(fresh);
    };
    if vectors.len() != stale.len() {
        fresh.extend(stale);
        return Ok(fresh);
    }
    let now = now_iso();
    let mut with_embeddings = Vec::new();
    for (mut capsule, vector) in stale.into_iter().zip(vectors) {
        capsule.embedding = Some(CapsuleEmbedding {
            model: LOCAL_EMBEDDING_MODEL_NAME.to_owned(),
            text_hash: capsule_text_hash(&capsule),
            vector,
            created_at: now.clone(),
        });
        update_capsule_embedding(&capsule.id, capsule.embedding.clone().unwrap(), workspace)?;
        with_embeddings.push(capsule);
    }
    fresh.extend(with_embeddings);
    Ok(fresh)
}

fn update_capsule_embedding(id: &str, embedding: CapsuleEmbedding, workspace: &Path) -> Result<()> {
    let mut capsules = load_capsules(workspace)?;
    if let Some(index) = capsules.iter().position(|capsule| capsule.id == id) {
        capsules[index].embedding = Some(embedding);
        capsules[index].updated_at = now_iso();
        write_jsonl(&memory_path(workspace), &capsules)?;
        debug(
            workspace,
            "capsule.derived_data_updated",
            json!({
                "id": capsules[index].id,
                "hasEmbedding": true,
                "graphEdges": capsules[index].graph.as_ref().map(Vec::len).unwrap_or(0),
                "bindingSnapshots": capsules[index].binding_snapshots.as_ref().map(Vec::len).unwrap_or(0),
                "stale": capsules[index].staleness.as_ref().map(|s| s.stale).unwrap_or(false)
            }),
        )?;
    }
    Ok(())
}

fn capsule_embedding_text(capsule: &Capsule) -> String {
    truncate(
        &[
            capsule.title.clone(),
            capsule.summary.clone(),
            capsule.next_run_instruction.clone(),
            capsule.reuse_when.join("\n"),
            capsule.do_not_reuse_when.join("\n"),
            capsule.workflow.purpose.clone(),
            capsule.workflow.parameters.join("\n"),
            active_binding_sources(capsule).join("\n"),
            capsule.workflow.steps.join("\n"),
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n"),
        6000,
    )
}

fn capsule_text_hash(capsule: &Capsule) -> String {
    sha256_hex(&capsule_embedding_text(capsule))
}

fn shortlist_capsules(prompt: &str, capsules: &[Capsule], limit: usize) -> Vec<Capsule> {
    let normalized = normalize(prompt);
    let mut scored = capsules
        .iter()
        .filter(|capsule| is_retrievable_capsule(capsule))
        .filter(|capsule| !matches_do_not_reuse(&normalized, capsule))
        .map(|capsule| {
            let score = score_capsule(&normalized, capsule);
            let recency = DateTime::parse_from_rfc3339(&capsule.updated_at)
                .map(|d| d.timestamp_millis())
                .unwrap_or(0);
            (capsule.clone(), score, recency)
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| {
                b.0.confidence
                    .partial_cmp(&a.0.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let matches = scored
        .iter()
        .filter(|item| item.1 > 0.0)
        .take(limit)
        .map(|item| item.0.clone())
        .collect::<Vec<_>>();
    if !matches.is_empty() {
        return matches;
    }
    scored.sort_by(|a, b| {
        b.2.cmp(&a.2).then_with(|| {
            b.0.confidence
                .partial_cmp(&a.0.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    scored
        .into_iter()
        .take(limit.min(4))
        .map(|item| item.0)
        .collect()
}

fn select_capsule(prompt: &str, capsules: &[Capsule]) -> Option<Capsule> {
    let normalized = normalize(prompt);
    let mut candidates = capsules
        .iter()
        .filter(|capsule| is_retrievable_capsule(capsule))
        .filter(|capsule| !matches_do_not_reuse(&normalized, capsule))
        .map(|capsule| (capsule.clone(), score_capsule(&normalized, capsule)))
        .filter(|candidate| candidate.1 > 0.0)
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.0.confidence
                    .partial_cmp(&a.0.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    candidates.into_iter().next().map(|item| item.0)
}

fn is_retrievable_capsule(capsule: &Capsule) -> bool {
    if !capsule.reusable
        || capsule.confidence < 0.5
        || capsule.workflow.purpose.is_empty() && capsule.workflow.steps.is_empty()
    {
        return false;
    }
    if matches!(
        capsule.status.as_str(),
        "private" | "rejected" | "superseded"
    ) {
        return false;
    }
    if !capsule.superseded_by.is_empty() || capsule.outcome_status == "aborted" {
        return false;
    }
    if capsule.outcome_status == "failed" {
        let kind = capsule.kind.to_lowercase();
        return kind.contains("fact") || kind.contains("caution") || kind.contains("dead_end");
    }
    true
}

fn score_capsule(prompt: &str, capsule: &Capsule) -> f64 {
    let prompt_tokens = prompt
        .split(' ')
        .filter(|s| !s.is_empty())
        .collect::<HashSet<_>>();
    let mut phrases = Vec::new();
    phrases.extend(capsule.reuse_when.iter().map(String::as_str));
    phrases.push(&capsule.title);
    phrases.push(&capsule.workflow.purpose);
    phrases.extend(capsule.workflow.parameters.iter().map(String::as_str));
    let active = active_binding_sources(capsule);
    phrases.extend(active.iter().map(String::as_str));
    let mut score = 0.0;
    for phrase in phrases
        .into_iter()
        .map(normalize)
        .filter(|phrase| phrase.len() >= 2)
    {
        if exact_phrase_match(prompt, &prompt_tokens, &phrase) {
            score += 4.0;
        } else {
            let important = phrase
                .split(' ')
                .filter(|part| part.len() >= 3)
                .collect::<Vec<_>>();
            let hits = important
                .iter()
                .filter(|part| prompt_tokens.contains(**part))
                .count();
            if important.len() >= 2 && (hits as f64 / important.len() as f64) >= 0.5 {
                score += 1.0;
            }
        }
    }
    score * capsule.confidence
}

fn exact_phrase_match(prompt: &str, prompt_tokens: &HashSet<&str>, phrase: &str) -> bool {
    let parts = phrase
        .split(' ')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if parts.len() == 1 && parts[0].len() < 3 {
        return prompt_tokens.contains(parts[0]);
    }
    prompt.contains(phrase)
}

fn matches_do_not_reuse(prompt: &str, capsule: &Capsule) -> bool {
    for phrase in capsule
        .do_not_reuse_when
        .iter()
        .map(|s| normalize(s))
        .filter(|item| item.len() >= 3)
    {
        if prompt.contains(&phrase) || (phrase.contains(prompt) && prompt.len() >= 6) {
            return true;
        }
        let prompt_tokens = prompt
            .split(' ')
            .filter(|s| !s.is_empty())
            .collect::<HashSet<_>>();
        let important = phrase
            .split(' ')
            .filter(|part| part.len() >= 3)
            .collect::<Vec<_>>();
        let hits = important
            .iter()
            .filter(|part| prompt_tokens.contains(**part))
            .count();
        if !important.is_empty() && (hits as f64 / important.len() as f64) >= 0.75 {
            return true;
        }
    }
    false
}

fn matches_any_do_not_reuse(prompt: &str, capsules: &[Capsule]) -> bool {
    capsules
        .iter()
        .any(|capsule| is_retrievable_capsule(capsule) && matches_do_not_reuse(prompt, capsule))
}

fn format_capsule_note(capsule: &Capsule, mode: &str, prompt: &str) -> String {
    if mode == "act" && !capsule.workflow.commands.is_empty() {
        return truncate(&format_action_command_capsule_note(capsule, prompt), 3500);
    }
    let command_policy = if mode == "orient" {
        "Command policy: this looks like an explanation or orientation prompt. Read or inspect the binding sources first; do not run saved commands unless the user asks for execution or inspection leaves uncertainty.".to_owned()
    } else if !capsule.workflow.commands.is_empty() {
        "Command policy: reuse the captured command shape with fresh parameters after verifying current binding sources.".to_owned()
    } else {
        "Command policy: no reusable command shape was captured; do not invent one from memory. Verify the binding sources and answer or ask before running optional probes.".to_owned()
    };
    let lines = vec![
        "Agent Run Cache sidecar note:".to_owned(),
        if mode == "orient" {
            "A prior session saved project context that may answer this orientation prompt. Verify the binding sources before broad rediscovery.".to_owned()
        } else {
            action_capsule_intro(capsule)
        },
        String::new(),
        format!("Capsule: {}", capsule.title),
        opt_line("Summary", &capsule.summary),
        opt_line("First move", &capsule.next_run_instruction),
        command_policy,
        minimal_verification_policy(capsule, mode),
        remote_command_policy(capsule),
        stale_policy(capsule),
        list("Reuse when", &capsule.reuse_when),
        list("Do not reuse when", &capsule.do_not_reuse_when),
        list("Binding sources to verify", &active_binding_sources(capsule)),
        list("Reusable artifacts", &capsule.artifact_sources),
        list("Validation probe", &capsule.workflow.validation_probe),
        list("Reusable steps", &capsule.workflow.steps),
        list(if mode == "orient" { "Command shapes captured for action tasks" } else { "Command shapes" }, &capsule.workflow.commands),
        list("Dead ends to avoid", &capsule.workflow.failed_attempts),
        String::new(),
        "Use this as a shortcut, not as truth. Do not require provenance-only files unless the capsule lists them as binding sources.".to_owned(),
    ];
    truncate(
        &lines
            .into_iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        5000,
    )
}

fn format_sidecar_consult_note(
    capsule: &Capsule,
    note: Option<&str>,
    mode: &str,
    prompt: &str,
) -> String {
    if mode == "act" && !capsule.workflow.commands.is_empty() {
        return truncate(
            &format_action_command_consult_note(capsule, note, prompt),
            3500,
        );
    }
    let command_policy = if mode == "orient" {
        "Command policy: this looks like an explanation or orientation prompt. Read or inspect the binding sources first; do not run saved commands unless the user asks for execution or inspection leaves uncertainty.".to_owned()
    } else if !capsule.workflow.commands.is_empty() {
        "Reusable command shape exists in the capsule; use it with fresh parameters after verifying the binding sources.".to_owned()
    } else {
        "No reusable command shape is captured in this capsule; do not invent a new command from the memory. Use the saved workflow first, then answer or ask if live execution is still needed.".to_owned()
    };
    let mut lines = vec![
        "Agent Run Cache consult:".to_owned(),
        if mode == "orient" {
            "The sidecar found close prior project context. Treat it as an orientation shortcut, not a command to execute.".to_owned()
        } else {
            format!(
                "The sidecar found {}. Treat this as the first path to try, not background trivia.",
                action_capsule_label(capsule)
            )
        },
        if mode == "orient" {
            "Before broad exploration, inspect the named binding sources and answer from current evidence. Do not require provenance-only files.".to_owned()
        } else {
            "Before broad exploration, verify the named binding sources and follow the capsule's first move. Do not require provenance-only files.".to_owned()
        },
        command_policy,
        minimal_verification_policy(capsule, mode),
        remote_command_policy(capsule),
        stale_policy(capsule),
        String::new(),
        format!("Matched capsule: {}", capsule.title),
        opt_line("First move", &capsule.next_run_instruction),
        list(
            "Binding sources to verify",
            &active_binding_sources(capsule),
        ),
        list("Reusable artifacts", &capsule.artifact_sources),
    ];
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        lines.push(format!(
            "{}: {}",
            if mode == "orient" {
                "Sidecar context"
            } else {
                "Sidecar instruction"
            },
            note
        ));
    }
    lines.push(String::new());
    lines.push("After using this, continue normally only if current evidence contradicts it or the user asks for more.".to_owned());
    truncate(
        &lines
            .into_iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        5000,
    )
}

fn format_action_command_capsule_note(capsule: &Capsule, prompt: &str) -> String {
    vec![
        "Agent Run Cache action note:".to_owned(),
        format!("{} Try this route before rediscovery.", action_capsule_intro(capsule)),
        format!("Capsule: {}", capsule.title),
        opt_line("First move", &capsule.next_run_instruction),
        concrete_target_policy(prompt),
        "Minimal verification policy: verify only the named binding sources with targeted searches, existence checks, or narrow selectors, then run the captured command shape. Use the user's concrete target terms; avoid generic broad patterns across whole files. One narrow pass per binding source is enough before the first attempt when it finds the target. Do not read provenance-only artifacts, reusable artifacts, command scripts, or whole files before the first attempt unless a targeted check is missing or stale, the command looks destructive, the command fails, or the user asks for deeper investigation.".to_owned(),
        remote_command_policy(capsule),
        stale_policy(capsule),
        list("Binding sources to verify", &active_binding_sources(capsule)),
        list("Validation probe", &capsule.workflow.validation_probe),
        list("Command shapes", &capsule.workflow.commands),
        list("Dead ends to avoid", &capsule.workflow.failed_attempts),
        String::new(),
        "After this route succeeds, answer from the result. Broaden only if current evidence contradicts the capsule or the user asks for more.".to_owned(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn format_action_command_consult_note(
    capsule: &Capsule,
    note: Option<&str>,
    prompt: &str,
) -> String {
    let mut lines = vec![
        "Agent Run Cache action note:".to_owned(),
        format!("The sidecar found {}. Try this route before rediscovery.", action_capsule_label(capsule)),
        format!("Capsule: {}", capsule.title),
        opt_line("First move", &capsule.next_run_instruction),
        concrete_target_policy(prompt),
        "Minimal verification policy: verify only the named binding sources with targeted searches, existence checks, or narrow selectors, then run the captured command shape. Use the user's concrete target terms; avoid generic broad patterns across whole files. One narrow pass per binding source is enough before the first attempt when it finds the target. Do not read provenance-only artifacts, reusable artifacts, command scripts, or whole files before the first attempt unless a targeted check is missing or stale, the command looks destructive, the command fails, or the user asks for deeper investigation.".to_owned(),
        remote_command_policy(capsule),
        stale_policy(capsule),
        list("Binding sources to verify", &active_binding_sources(capsule)),
        list("Validation probe", &capsule.workflow.validation_probe),
        list("Command shapes", &capsule.workflow.commands),
        list("Dead ends to avoid", &capsule.workflow.failed_attempts),
    ];
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        lines.push(format!("Sidecar instruction: {note}"));
    }
    lines.push(String::new());
    lines.push("After this route succeeds, answer from the result. Broaden only if current evidence contradicts the capsule or the user asks for more.".to_owned());
    lines
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn action_capsule_intro(capsule: &Capsule) -> String {
    let label = action_capsule_label(capsule);
    let kind = capsule.kind.to_lowercase();
    if kind == "command" {
        format!("A prior session saved {label} that may apply. Reuse the captured command shape after verifying current files, tools, and environment.")
    } else if kind.contains("fact") {
        format!("A prior session saved {label} that may apply. Verify the binding sources before broad rediscovery.")
    } else {
        format!("A prior session saved {label} that may apply. Follow the capsule's first move before broad rediscovery, then verify current files, tools, and environment.")
    }
}

fn action_capsule_label(capsule: &Capsule) -> &'static str {
    let kind = capsule.kind.to_lowercase();
    if kind == "command" {
        "a reusable command capsule"
    } else if kind.contains("fact") {
        "reusable project context"
    } else if kind == "runbook" {
        "a reusable runbook capsule"
    } else {
        "a reusable workflow capsule"
    }
}

fn minimal_verification_policy(capsule: &Capsule, mode: &str) -> String {
    if mode == "orient" || capsule.workflow.commands.is_empty() {
        String::new()
    } else {
        "Minimal verification policy: before the first command attempt, verify only the named binding sources with targeted searches, existence checks, or narrow selectors. Use the validation probe when it is specific. Do not read provenance-only artifacts, reusable artifacts, command scripts, or whole files for background context unless a targeted check is missing or stale, the command looks destructive, the command fails, or the user asks for deeper investigation.".to_owned()
    }
}

fn concrete_target_policy(prompt: &str) -> String {
    let terms = concrete_prompt_terms(prompt);
    if terms.is_empty() {
        String::new()
    } else {
        format!("Concrete target terms for the first narrow search: {}. If these match the binding sources, do not run broader generic searches before the first command attempt.", terms.join(", "))
    }
}

fn concrete_prompt_terms(prompt: &str) -> Vec<String> {
    let stop = [
        "test", "ssh", "run", "check", "verify", "fix", "debug", "to", "the", "a", "an", "with",
        "for", "from",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    let re = Regex::new(r"[a-z0-9][a-z0-9_.:-]*[a-z0-9]").unwrap();
    unique_strings(
        re.find_iter(&prompt.to_lowercase())
            .map(|m| {
                m.as_str()
                    .trim_matches(|c| matches!(c, '.' | '_' | ':' | '-'))
                    .to_owned()
            })
            .filter(|value| value.len() >= 2)
            .filter(|value| !stop.contains(value.as_str()))
            .filter(|value| {
                value
                    .chars()
                    .any(|c| matches!(c, '0'..='9' | '_' | '.' | ':' | '-'))
            })
            .collect(),
    )
    .into_iter()
    .take(4)
    .collect()
}

fn list(title: &str, values: &[String]) -> String {
    if values.is_empty() {
        String::new()
    } else {
        format!(
            "{}:\n{}",
            title,
            values
                .iter()
                .take(6)
                .map(|value| format!("- {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}

fn opt_line(title: &str, value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        format!("{title}: {value}")
    }
}

fn remote_command_policy(capsule: &Capsule) -> String {
    let text = [
        capsule.workflow.commands.join("\n"),
        capsule.workflow.steps.join("\n"),
        capsule.next_run_instruction.clone(),
    ]
    .join("\n")
    .to_lowercase();
    if Regex::new(r"\bssh\b|\bscp\b|\brsync\b|\bdocker\b")
        .unwrap()
        .is_match(&text)
    {
        "Remote command policy: use bounded, noninteractive probes where possible, for example BatchMode and ConnectTimeout for SSH. Treat password prompts, hung sessions, and transient health failures as outcome evidence rather than successful workflow proof.".to_owned()
    } else {
        String::new()
    }
}

fn stale_policy(capsule: &Capsule) -> String {
    let Some(staleness) = &capsule.staleness else {
        return String::new();
    };
    if !staleness.stale {
        return String::new();
    }
    let reasons = staleness
        .reasons
        .iter()
        .take(4)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    format!("Staleness policy: one or more binding sources changed since this capsule was saved ({reasons}). Reverify current files before reuse; do not discard the capsule automatically.")
}

fn active_binding_sources(capsule: &Capsule) -> Vec<String> {
    let artifact_sources = capsule
        .artifact_sources
        .iter()
        .map(|s| normalize(s))
        .collect::<HashSet<_>>();
    capsule
        .workflow
        .binding_sources
        .iter()
        .filter(|source| {
            if !artifact_sources.contains(&normalize(source)) {
                return true;
            }
            !Regex::new(r"(?i)\.md$").unwrap().is_match(source)
                && !Regex::new(r"(?i)\b(runbook|notes?|instructions?)\b")
                    .unwrap()
                    .is_match(source)
        })
        .cloned()
        .collect()
}

fn should_use_provider_judge(mode: &str, ranked: &RankedCapsules) -> bool {
    mode == "provider-judge"
        && ranked.available
        && ranked.top_score.is_some_and(|score| {
            score >= embedding_threshold() && score < provider_judge_high_threshold()
        })
}

fn provider_judge_high_confidence(ranked: &RankedCapsules) -> bool {
    ranked.available
        && ranked
            .top_score
            .is_some_and(|score| score >= provider_judge_high_threshold())
}

fn ranked_candidates(ranked: &RankedCapsules, fallback: &[Capsule]) -> Vec<JudgeCandidate> {
    if !ranked.scores.is_empty() {
        ranked
            .scores
            .iter()
            .take(embedding_shortlist_limit())
            .map(|item| JudgeCandidate {
                capsule_id: item.capsule.id.clone(),
                score: item.score,
                reputation: Some(item.reputation),
            })
            .collect()
    } else {
        fallback
            .iter()
            .map(|capsule| JudgeCandidate {
                capsule_id: capsule.id.clone(),
                score: 0.0,
                reputation: None,
            })
            .collect()
    }
}
