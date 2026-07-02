use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Datelike, Local, SecondsFormat, TimeZone, Utc};
use clap::Command as ClapCommand;
use rand::{distributions::Alphanumeric, Rng};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod cli;
mod embedder;
mod judge;
mod mcp;
mod plugin;
mod retrieval;
mod review_capture;
mod split;
mod store;
mod ui;

use embedder::{embed_texts, embedding_unavailable_reason, stop_local_embeddings};
use judge::{
    judge_reachability, list_judge_models, load_arc_config, load_retrieval_reputation,
    parse_judge_model, provider_judge_confidence_threshold, provider_judge_high_threshold,
    reconcile_judge_outcome, record_judge_decision, run_judge, save_arc_config, JudgeReachability,
};
use mcp::run_mcp;
use plugin::{
    copilot_plugin_status, copilot_plugin_workspace_path, extension_status, hook_status,
    is_plugin_hook, is_workspace_activated, read_activation_integration,
    remember_copilot_plugin_workspace, run_copilot_tab, run_json_hooks, run_plugin, run_setup,
    write_activation,
};
use retrieval::{build_injection_plan, ensure_embeddings_for_capsules, search_capsules_for_query};
use review_capture::{
    harvest_latest_session, harvest_session, import_copilot_otel, import_copilot_transcript,
    record_sidecar_exchange, review_events, run_judge_sidecar, value_array_strings,
};
use split::{cached_zellij, run_split};
use store::{increment_capsule_use, load_capsules, save_capsule, update_capsule_metadata};
use ui::{load_ui_view_model, render_status_summary, run_tab, run_ui, UiOptions};

const SERVER_VERSION: &str = "2.1.0";
const LOCAL_EMBEDDING_MODEL_NAME: &str = "nomic-embed-text-v1.5";
const DEFAULT_LLAMA_RELEASE: &str = "b9585";
const DEFAULT_EMBEDDING_MODEL_FILE: &str = "nomic-embed-text-v1.5.f16.gguf";
const COPILOT_HOOK_RENDER_MODE: &str = "context-only: Copilot accepts additionalContext/modifiedPrompt without stopping the agent loop; responseContent renders only with handled=true, which skips the agent loop; sessionEnd output is ignored";

fn main() {
    // Keep clap in the binary surface even while the subcommands stay manually
    // dispatched for TypeScript-compatible argument permissiveness.
    let _ = ClapCommand::new("arc").disable_help_flag(true);
    let result = cli::run();
    stop_local_embeddings();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run_status(args: &[String], workspace: &Path) -> Result<()> {
    assert_known_flags(args, &["--json"])?;
    let payload = status_payload(workspace)?;
    if has_json(args) {
        write_json(&payload)
    } else {
        println!(
            "workspace: {}",
            payload["workspace"].as_str().unwrap_or_default()
        );
        println!(
            "cache: {}",
            payload["cacheDir"].as_str().unwrap_or_default()
        );
        println!(
            "capsules: {}",
            payload["capsuleCount"].as_u64().unwrap_or(0)
        );
        println!("events: {}", payload["eventCount"].as_u64().unwrap_or(0));
        let judge_mode = payload["judge"]["mode"]
            .as_str()
            .unwrap_or("embedding-only");
        let judge_model = payload["judge"]["model"]
            .as_object()
            .and_then(|model| {
                Some(format!(
                    "{}:{}",
                    model.get("provider")?.as_str()?,
                    model.get("id")?.as_str()?
                ))
            })
            .unwrap_or_else(|| "none".to_owned());
        println!("judge: {judge_mode} ({judge_model})");
        println!(
            "judge reachable: {} ({})",
            if payload["judge"]["reachability"]["reachable"]
                .as_bool()
                .unwrap_or(false)
            {
                "yes"
            } else {
                "no"
            },
            payload["judge"]["reachability"]["reason"]
                .as_str()
                .unwrap_or("unknown")
        );
        if let Some(label) = payload["injectionPause"]["label"].as_str() {
            if payload["injectionPause"]["paused"]
                .as_bool()
                .unwrap_or(false)
            {
                println!("{label}");
            }
        }
        Ok(())
    }
}

fn run_capsules(args: &[String], workspace: &Path) -> Result<()> {
    let json_mode = has_json(args);
    let clean = strip_flag(args, "--json");
    if clean.first().map(String::as_str) == Some("set") {
        return run_capsule_set(&clean[1..], workspace, json_mode);
    }
    if clean.first().map(String::as_str) == Some("delete") {
        return run_capsule_delete(&clean[1..], workspace, json_mode);
    }
    if clean.first().map(String::as_str) == Some("share") {
        return run_capsule_share(&clean[1..], workspace, json_mode);
    }
    assert_known_flags(&clean, &[])?;
    let capsules = load_capsules(workspace)?;
    if let Some(id) = clean.first() {
        let capsule =
            find_capsule(&capsules, id).ok_or_else(|| anyhow!("No capsule matches {id}"))?;
        if json_mode {
            write_json(&json!({ "capsule": capsule_json_with_scope(capsule) }))
        } else {
            print_capsule(capsule);
            Ok(())
        }
    } else if json_mode {
        write_json(
            &json!({ "capsules": capsules.iter().map(capsule_json_with_scope).collect::<Vec<_>>() }),
        )
    } else {
        println!(
            "{} capsule{}",
            capsules.len(),
            if capsules.len() == 1 { "" } else { "s" }
        );
        let mut sorted = capsules;
        sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        for capsule in sorted.iter() {
            println!(
                "{}  {}/{}  {}",
                short(&capsule.id, 8),
                capsule.status,
                capsule.privacy_label,
                capsule.title
            );
        }
        Ok(())
    }
}

fn run_capsule(args: &[String], workspace: &Path) -> Result<()> {
    let json_mode = has_json(args);
    let clean = strip_flag(args, "--json");
    assert_known_flags(&clean, &[])?;
    let id = clean
        .first()
        .ok_or_else(|| anyhow!("Usage: arc capsule <id> [--json]"))?;
    let capsules = load_capsules(workspace)?;
    let capsule = find_capsule(&capsules, id).ok_or_else(|| anyhow!("No capsule matches {id}"))?;
    if json_mode {
        write_json(&json!({ "capsule": capsule_json_with_scope(capsule) }))
    } else {
        print_capsule(capsule);
        Ok(())
    }
}

fn run_capsule_set(args: &[String], workspace: &Path, json_mode: bool) -> Result<()> {
    let id = args.first().ok_or_else(|| {
        anyhow!("Usage: arc capsules set <id> [--status <s>] [--privacy <label>] [--json]")
    })?;
    let mut status: Option<String> = None;
    let mut privacy: Option<String> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--status" => {
                index += 1;
                status = Some(
                    args.get(index)
                        .ok_or_else(|| anyhow!("Missing value for --status"))?
                        .clone(),
                );
            }
            "--privacy" => {
                index += 1;
                privacy = Some(
                    args.get(index)
                        .ok_or_else(|| anyhow!("Missing value for --privacy"))?
                        .clone(),
                );
            }
            other => return Err(anyhow!("Unknown capsules set option: {other}")),
        }
        index += 1;
    }
    if status.is_none() && privacy.is_none() {
        return Err(anyhow!("Provide --status and/or --privacy"));
    }
    let capsule = update_capsule_metadata(id, status.as_deref(), privacy.as_deref(), workspace)?
        .ok_or_else(|| anyhow!("No capsule matches {id}"))?;
    if json_mode {
        write_json(&json!({ "capsule": capsule }))
    } else {
        println!(
            "updated {}: {}/{}",
            capsule.id, capsule.status, capsule.privacy_label
        );
        Ok(())
    }
}

fn run_capsule_delete(args: &[String], workspace: &Path, json_mode: bool) -> Result<()> {
    let id = args
        .first()
        .ok_or_else(|| anyhow!("Usage: arc capsules delete <id> [--json]"))?;
    assert_known_flags(&args[1..], &[])?;
    let result = delete_capsule(id, workspace)?;
    if json_mode {
        write_json(&result)
    } else {
        if result.deleted {
            println!("deleted {}", result.id.unwrap_or_else(|| id.to_owned()));
        } else {
            println!("no capsule matched {id}");
        }
        Ok(())
    }
}

fn run_capsule_share(args: &[String], workspace: &Path, json_mode: bool) -> Result<()> {
    let id = args
        .first()
        .ok_or_else(|| anyhow!("Usage: arc capsules share <id> [--out <file>] [--json]"))?;
    if args.iter().any(|arg| arg == "--out") && option_value(args, "--out").is_none() {
        return Err(anyhow!("Missing value for --out"));
    }
    let out = option_value(args, "--out").map(PathBuf::from);
    let mut clean = Vec::new();
    let mut index = 1;
    while index < args.len() {
        if args[index] == "--out" {
            index += 2;
        } else {
            clean.push(args[index].clone());
            index += 1;
        }
    }
    assert_known_flags(&clean, &[])?;
    let capsules = load_capsules(workspace)?;
    let capsule = find_capsule(&capsules, id).ok_or_else(|| anyhow!("No capsule matches {id}"))?;
    let markdown = capsule_markdown(capsule);
    if let Some(path) = out {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(&path, &markdown)?;
        if json_mode {
            write_json(&json!({ "id": capsule.id, "out": path, "bytes": markdown.len() }))
        } else {
            println!("wrote {}", path.display());
            Ok(())
        }
    } else if json_mode {
        write_json(&json!({ "id": capsule.id, "markdown": markdown }))
    } else {
        print!("{markdown}");
        Ok(())
    }
}

fn run_pause(args: &[String]) -> Result<()> {
    let json_mode = has_json(args);
    let clean = strip_flag(args, "--json");
    assert_known_flags(&clean, &[])?;
    let duration = clean.first().map(String::as_str).unwrap_or("1h");
    if duration == "off" {
        let config = save_arc_config(ArcConfigPatch {
            injection_paused_until: Some(None),
            ..ArcConfigPatch::default()
        })?;
        if json_mode {
            write_json(&json!({
                "configPath": arc_config_path(),
                "injectionPause": injection_pause_status(&config)
            }))
        } else {
            println!("injection resumed");
            Ok(())
        }
    } else {
        let until = pause_until(duration)?;
        let config = save_arc_config(ArcConfigPatch {
            injection_paused_until: Some(Some(until.to_rfc3339_opts(SecondsFormat::Millis, true))),
            ..ArcConfigPatch::default()
        })?;
        let pause = injection_pause_status(&config);
        if json_mode {
            write_json(&json!({
                "configPath": arc_config_path(),
                "injectionPause": pause
            }))
        } else {
            println!("{}", pause.label);
            Ok(())
        }
    }
}

fn run_resume(args: &[String]) -> Result<()> {
    assert_known_flags(args, &["--json"])?;
    let config = save_arc_config(ArcConfigPatch {
        injection_paused_until: Some(None),
        ..ArcConfigPatch::default()
    })?;
    if has_json(args) {
        write_json(&json!({
            "configPath": arc_config_path(),
            "injectionPause": injection_pause_status(&config)
        }))
    } else {
        println!("injection resumed");
        Ok(())
    }
}

fn run_events(args: &[String], workspace: &Path) -> Result<()> {
    let json_mode = has_json(args);
    let limit = parse_limit(args)?;
    let clean = strip_limit(&strip_flag(args, "--json"));
    assert_known_flags(&clean, &[])?;
    let events = load_memory_events(workspace)?;
    let mut recent: Vec<MemoryEvent> = events.iter().rev().take(limit).cloned().collect();
    let payload = json!({ "total": events.len(), "events": recent });
    if json_mode {
        write_json(&payload)
    } else {
        println!(
            "{} event{}",
            events.len(),
            if events.len() == 1 { "" } else { "s" }
        );
        for event in recent.drain(..) {
            let detail = event
                .details
                .as_ref()
                .and_then(|value| value.get("title").or_else(|| value.get("reason")))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(event.capsule_id.clone())
                .or(event.session_id.clone())
                .unwrap_or_default();
            println!(
                "{}  {}{}",
                event.timestamp,
                event.r#type,
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("  {detail}")
                }
            );
        }
        Ok(())
    }
}

fn run_probe(args: &[String], workspace: &Path, command: &str) -> Result<()> {
    let json_mode = has_json(args);
    let prompt = strip_flag(args, "--json").join(" ").trim().to_owned();
    if prompt.is_empty() {
        return Err(anyhow!("Usage: arc probe \"<prompt>\" [--json]"));
    }
    let explicit_consult = command == "consult"
        || env::var("AGENT_RUN_CACHE_CONSULT_COMMAND")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .is_some();
    let plan = build_injection_plan(
        &prompt,
        workspace,
        InjectionContext::default(),
        explicit_consult,
    )?;
    if json_mode || command == "consult" || command == "inject" {
        write_json(&plan)
    } else {
        println!(
            "injection: {}",
            if plan.should_inject { "yes" } else { "no" }
        );
        println!("reason: {}", plan.reason);
        if let Some(capsule) = &plan.capsule {
            println!("capsule: {} {}", capsule.id, capsule.title);
        }
        if !plan.message.is_empty() {
            println!("{}", plan.message);
        }
        Ok(())
    }
}

fn run_hook(args: &[String]) -> Result<()> {
    let runner = args.first().map(String::as_str).unwrap_or("");
    let hook_name = args.get(1).map(String::as_str).unwrap_or("Unknown");
    if runner != "copilot" {
        return Err(anyhow!("Only Copilot hooks are supported in this rewrite."));
    }
    let result = handle_copilot_hook(hook_name).unwrap_or_else(|_| json!({}));
    write_json(&result)
}

fn run_doctor(args: &[String], workspace: &Path) -> Result<()> {
    assert_known_flags(args, &["--json"])?;
    let capsules = load_capsules(workspace)?;
    let events = load_memory_events(workspace)?;
    let config = load_arc_config()?;
    let judge_reachability = judge_reachability(&config);
    let injection_pause = injection_pause_status(&config);
    let zellij = cached_zellij();
    let split_engine = if cfg!(windows) {
        "windows-terminal"
    } else {
        "zellij"
    };
    let payload = json!({
        "workspace": workspace,
        "cacheDir": cache_dir(workspace),
        "plugin": copilot_plugin_status(),
        "extension": extension_status(workspace),
        "hook": hook_status(workspace),
        "integration": read_activation_integration(workspace),
        "sidecarCopilotCommand": config.sidecar_copilot_command.clone(),
        "capsuleCount": capsules.len(),
        "eventCount": events.len(),
        "lastInjection": last_event(&events, "capsule.injected"),
        "lastSave": last_save_event(&events),
        "judge": {
            "mode": config.injection_judge_mode.clone().unwrap_or_else(|| "embedding-only".to_owned()),
            "model": config.injection_judge_model.clone(),
            "reachability": judge_reachability
        },
        "injectionPause": injection_pause,
        "split": {
            "supported": cfg!(target_os = "macos") || cfg!(target_os = "linux") || cfg!(windows),
            "engine": split_engine,
            "zellijProvisioned": zellij.is_some(),
            "zellijPath": zellij
        },
        "generatedAt": now_iso()
    });
    if has_json(args) {
        write_json(&payload)
    } else {
        println!("workspace: {}", workspace.display());
        println!("capsules: {}", capsules.len());
        println!("events: {}", events.len());
        println!(
            "judge reachable: {} ({})",
            if payload["judge"]["reachability"]["reachable"]
                .as_bool()
                .unwrap_or(false)
            {
                "yes"
            } else {
                "no"
            },
            payload["judge"]["reachability"]["reason"]
                .as_str()
                .unwrap_or("unknown")
        );
        println!(
            "extension: {}",
            if payload["extension"]["installed"].as_bool().unwrap_or(false) {
                "installed"
            } else {
                "not installed"
            }
        );
        println!(
            "experimental: {}",
            if payload["extension"]["host"]["experimental"]["enabled"]
                .as_bool()
                .unwrap_or(false)
            {
                "on"
            } else {
                "off"
            }
        );
        println!(
            "elicitation: {}",
            if payload["extension"]["host"]["elicitationAvailable"]
                .as_bool()
                .unwrap_or(false)
            {
                "available (best effort)"
            } else {
                "unavailable (best effort)"
            }
        );
        println!(
            "split view: {}",
            if split_engine == "windows-terminal" {
                "Windows Terminal fallback"
            } else if payload["split"]["supported"].as_bool().unwrap_or(false) {
                if payload["split"]["zellijProvisioned"]
                    .as_bool()
                    .unwrap_or(false)
                {
                    "ready"
                } else {
                    "zellij will be provisioned on first launch"
                }
            } else {
                "unsupported platform"
            }
        );
        if let Some(label) = payload["injectionPause"]["label"].as_str() {
            if payload["injectionPause"]["paused"]
                .as_bool()
                .unwrap_or(false)
            {
                println!("{label}");
            }
        }
        Ok(())
    }
}

fn run_import_copilot(args: &[String], workspace: &Path) -> Result<()> {
    let path = args
        .first()
        .ok_or_else(|| anyhow!("Usage: arc import-copilot <events.jsonl>"))?;
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(anyhow!("Input file not found: {}", path.display()));
    }
    let events = import_copilot_transcript(&path, workspace, "unknown")?;
    let session_id = events
        .first()
        .map(|event| event.session_id.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    review_events(&events, workspace, &session_id, "auto")?;
    println!(
        "imported and reviewed {} events from {}",
        events.len(),
        path.display()
    );
    Ok(())
}

fn run_import_otel(args: &[String], workspace: &Path) -> Result<()> {
    let path = args
        .first()
        .ok_or_else(|| anyhow!("Usage: arc import-otel <otel.jsonl>"))?;
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(anyhow!("Input file not found: {}", path.display()));
    }
    let fallback_session_id = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let events = import_copilot_otel(&path, workspace, &fallback_session_id)?;
    let session_id = events
        .first()
        .map(|event| event.session_id.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_session_id);
    review_events(&events, workspace, &session_id, "auto")?;
    println!(
        "imported and reviewed {} OTel-derived events from {}",
        events.len(),
        path.display()
    );
    Ok(())
}

fn run_harvest(args: &[String], workspace: &Path) -> Result<()> {
    if args.iter().any(|arg| arg == "--latest") {
        match harvest_latest_session(workspace)? {
            Some(session_id) => println!("harvested {session_id}"),
            None => println!("no unharvested session found"),
        }
        return Ok(());
    }
    let session_id = args
        .first()
        .ok_or_else(|| anyhow!("Usage: arc harvest <copilot-session-id> | arc harvest --latest"))?;
    if !harvest_session(session_id, workspace)? {
        return Err(anyhow!(
            "No Copilot transcript or OTel data found for session: {session_id}"
        ));
    }
    println!("harvested {session_id}");
    Ok(())
}

fn run_logs(args: &[String], workspace: &Path) -> Result<()> {
    for arg in args {
        if arg != "--follow" && arg != "-f" {
            return Err(anyhow!("Unknown logs option: {arg}"));
        }
    }
    let follow = args.iter().any(|arg| arg == "--follow" || arg == "-f");
    let file = debug_path(workspace);
    let mut offset = 0usize;
    loop {
        if file.exists() {
            let text = fs::read_to_string(&file)?;
            let next = text.get(offset..).unwrap_or("");
            offset = text.len();
            for line in next.lines().filter(|line| !line.trim().is_empty()) {
                println!("{}", format_log_line(line));
            }
        }
        if !follow {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Ok(())
}

fn run_reset(args: &[String], workspace: &Path) -> Result<()> {
    if !args.iter().any(|arg| arg == "--yes") {
        return Err(anyhow!(
            "Refusing to reset without confirmation. Run `arc reset --yes` to remove ARC workspace and app caches."
        ));
    }
    let target = cache_dir(workspace);
    let existed = target.exists();
    fs::remove_dir_all(&target).or_else(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    println!("ARC reset complete");
    if existed {
        println!("removed workspace cache: {}", target.display());
    } else {
        println!("nothing existed on disk");
    }
    println!("If ARC is open, quit and reopen it so the sidebar reloads from disk.");
    Ok(())
}

fn run_debug_bundle(args: &[String], workspace: &Path) -> Result<()> {
    let out_dir = args.first().map(PathBuf::from);
    let result = write_debug_bundle(out_dir.as_deref(), workspace)?;
    println!("wrote redacted debug bundle to {}", result.path.display());
    println!(
        "files: {}, traces: {}",
        result.file_count, result.trace_count
    );
    Ok(())
}

fn run_smoke_command(workspace: &Path) -> Result<()> {
    let previous_cache_dir = env::var("AGENT_RUN_CACHE_DIR").ok();
    let previous_sidecar = env::var("AGENT_RUN_CACHE_MODEL_SIDECAR").ok();
    let previous_embeddings = env::var("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS").ok();
    let temp_cache = env::temp_dir().join(format!("arc-smoke-{}", random_suffix()));
    env::set_var("AGENT_RUN_CACHE_DIR", &temp_cache);
    env::set_var("AGENT_RUN_CACHE_MODEL_SIDECAR", "off");
    env::set_var("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS", "off");
    let result = run_smoke(workspace);
    restore_env_var("AGENT_RUN_CACHE_DIR", previous_cache_dir);
    restore_env_var("AGENT_RUN_CACHE_MODEL_SIDECAR", previous_sidecar);
    restore_env_var("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS", previous_embeddings);
    let _ = fs::remove_dir_all(&temp_cache);
    result
}

fn run_smoke(workspace: &Path) -> Result<()> {
    let capsule = Capsule {
        runner: "copilot".to_owned(),
        workspace: workspace.to_string_lossy().to_string(),
        source_session_id: "smoke".to_owned(),
        reusable: true,
        confidence: 0.99,
        title: "Smoke test folder workflow".to_owned(),
        summary: "For test folder orientation, inspect the test directory before broad rediscovery.".to_owned(),
        reuse_when: vec![
            "test folder".to_owned(),
            "public regression test".to_owned(),
            "what is in the test folder".to_owned(),
        ],
        do_not_reuse_when: vec!["the user asks for current test results".to_owned()],
        next_run_instruction: "List the test directory and inspect the focused public test file before broad rediscovery.".to_owned(),
        evidence: vec!["offline smoke capsule".to_owned()],
        provenance: Vec::new(),
        workflow: WorkflowCapsule {
            purpose: "Orient a future agent on the test folder.".to_owned(),
            parameters: vec!["current test folder name".to_owned()],
            binding_sources: vec!["test/".to_owned()],
            steps: vec![
                "List test/.".to_owned(),
                "Read the focused public test file if present.".to_owned(),
                "Only run tests if user asks for results.".to_owned(),
            ],
            commands: vec!["ls test".to_owned()],
            success_criteria: vec!["The test folder contents are identified.".to_owned()],
            failed_attempts: Vec::new(),
            validation_probe: vec!["Check that test/ still exists.".to_owned()],
        },
        ..Capsule::default()
    };
    let _ = save_capsule(capsule, workspace)?;
    let plan = build_injection_plan(
        "what is in the test folder",
        workspace,
        InjectionContext::default(),
        false,
    )?;
    println!(
        "smoke: injection {} ({})",
        if plan.should_inject { "yes" } else { "no" },
        plan.reason
    );
    Ok(())
}

fn run_ask(args: &[String], workspace: &Path) -> Result<()> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", ask_usage());
        return Ok(());
    }
    let (runner, prompt) = parse_ask_args(args);
    if prompt.is_empty() {
        return Err(anyhow!("{}", ask_usage()));
    }
    if runner != "opencode" {
        return Err(anyhow!(
            "Unsupported ask runner: {runner}. Only opencode is wired for arc ask."
        ));
    }
    let plan = safe_ask_injection_plan(&prompt, workspace, &runner);
    let final_prompt = if plan.should_inject {
        format!("{}\n\nUser task:\n{}", plan.message, prompt)
    } else {
        prompt
    };
    print_ask_header(&plan);
    debug(
        workspace,
        "ask.runner.started",
        json!({
            "runner": runner,
            "injected": plan.should_inject,
            "capsuleId": plan.capsule.as_ref().map(|capsule| capsule.id.clone()),
            "reason": plan.reason
        }),
    )?;
    let code = run_ask_process(
        &opencode_bin(),
        &["run".to_owned(), final_prompt],
        workspace,
    )?;
    debug(
        workspace,
        "ask.runner.completed",
        json!({
            "runner": runner,
            "exitCode": code,
            "injected": plan.should_inject,
            "capsuleId": plan.capsule.as_ref().map(|capsule| capsule.id.clone())
        }),
    )?;
    println!();
    println!("ARC: runner {runner} exit {code}");
    println!(
        "ARC: injected capsule {}",
        plan.capsule
            .as_ref()
            .map(|capsule| capsule.id.as_str())
            .unwrap_or("none")
    );
    std::process::exit(code);
}

fn parse_ask_args(args: &[String]) -> (String, String) {
    let mut runner =
        env::var("AGENT_RUN_CACHE_ASK_RUNNER").unwrap_or_else(|_| "opencode".to_owned());
    let mut prompt_parts = Vec::new();
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--runner" {
            runner = args.get(index + 1).cloned().unwrap_or_default();
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--runner=") {
            runner = value.to_owned();
            index += 1;
            continue;
        }
        prompt_parts.push(arg.clone());
        index += 1;
    }
    (runner, prompt_parts.join(" ").trim().to_owned())
}

fn ask_usage() -> &'static str {
    "Usage: arc ask [--runner opencode] <prompt>\n\nRuns a CLI-first ARC turn through opencode run. ARC retrieves matching capsule context first, then streams the runner answer in this terminal."
}

fn safe_ask_injection_plan(prompt: &str, workspace: &Path, _runner: &str) -> InjectionPlan {
    match build_injection_plan(prompt, workspace, InjectionContext::default(), false) {
        Ok(plan) => plan,
        Err(error) => {
            let _ = debug(
                workspace,
                "ask.injection_failed",
                json!({ "error": error.to_string() }),
            );
            InjectionPlan {
                should_inject: false,
                message: String::new(),
                reason: format!(
                    "injection unavailable: {}",
                    summarize_ask_error(&error.to_string())
                ),
                source: Some("local".to_owned()),
                capsule: None,
                judge_decision_id: None,
                consult_applied: None,
                consult_capsule_id: None,
                consult_abstain_reason: None,
                action_risk: None,
            }
        }
    }
}

fn summarize_ask_error(error: &str) -> &'static str {
    if Regex::new("(?i)quota").unwrap().is_match(error) {
        "sidecar quota exceeded"
    } else {
        "see ARC debug logs"
    }
}

fn print_ask_header(plan: &InjectionPlan) {
    if plan.should_inject {
        println!(
            "ARC: using capsule \"{}\"",
            plan.capsule
                .as_ref()
                .map(|capsule| {
                    if capsule.title.is_empty() {
                        capsule.id.clone()
                    } else {
                        capsule.title.clone()
                    }
                })
                .unwrap_or_else(|| "unknown".to_owned())
        );
        println!("ARC: {}", plan.reason);
    } else {
        println!("ARC: no capsule injected ({})", plan.reason);
    }
    println!();
}

fn opencode_bin() -> String {
    env::var("AGENT_RUN_CACHE_OPENCODE_BIN").unwrap_or_else(|_| "opencode".to_owned())
}

fn run_ask_process(command: &str, args: &[String], workspace: &Path) -> Result<i32> {
    let status = Command::new(command)
        .args(args)
        .current_dir(workspace)
        .env(
            "OPENCODE_CLIENT",
            env::var("OPENCODE_CLIENT").unwrap_or_else(|_| "arc".to_owned()),
        )
        .status()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                anyhow!("OpenCode runner not found: {command}. Install OpenCode or set AGENT_RUN_CACHE_OPENCODE_BIN.")
            } else {
                anyhow!(error)
            }
        })?;
    Ok(status.code().unwrap_or(0))
}

fn restore_env_var(name: &str, value: Option<String>) {
    if let Some(value) = value {
        env::set_var(name, value);
    } else {
        env::remove_var(name);
    }
}

fn format_log_line(line: &str) -> String {
    let Ok(record) = serde_json::from_str::<Value>(line) else {
        return line.to_owned();
    };
    let time = record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|timestamp| timestamp.get(11..19))
        .unwrap_or("--:--:--");
    let action = record
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("event");
    let details = record
        .get("details")
        .and_then(Value::as_object)
        .map(summarize_details)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    if details.is_empty() {
        format!("[{time}] {action}")
    } else {
        format!("[{time}] {action} {details}")
    }
}

fn summarize_details(details: &Map<String, Value>) -> String {
    let keep = [
        "sessionId",
        "reason",
        "source",
        "status",
        "currentGoal",
        "possibleReusableWork",
        "title",
        "eventCount",
        "total",
        "newEvents",
        "sidecarCalls",
    ];
    let mut compact = Map::new();
    for key in keep {
        if let Some(value) = details.get(key) {
            compact.insert(key.to_owned(), value.clone());
        }
    }
    if compact.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&Value::Object(compact)).unwrap_or_default()
    }
}

struct DebugBundleResult {
    path: PathBuf,
    file_count: usize,
    trace_count: usize,
}

fn write_debug_bundle(out_dir: Option<&Path>, workspace: &Path) -> Result<DebugBundleResult> {
    let root = out_dir.map(PathBuf::from).unwrap_or_else(|| {
        cache_dir(workspace)
            .join("debug-bundles")
            .join(timestamp_name())
    });
    let root = absolutize(root);
    fs::create_dir_all(&root)?;
    let mut files = Vec::new();
    let mut file_count = 0usize;
    let mut trace_count = 0usize;
    for (source, target) in [
        (memory_path(workspace), "memory.redacted.jsonl"),
        (
            memory_events_path(workspace),
            "memory-events.redacted.jsonl",
        ),
        (reviewed_path(workspace), "reviewed.redacted.jsonl"),
        (debug_path(workspace), "runtime.redacted.jsonl"),
        (sidecar_path(workspace), "sidecar.redacted.jsonl"),
    ] {
        if !source.exists() {
            continue;
        }
        write_redacted_jsonl(&source, &root.join(target))?;
        files.push(Value::String(target.to_owned()));
        file_count += 1;
    }
    let trace_root = cache_dir(workspace).join("traces");
    let trace_out = root.join("traces");
    if trace_root.exists() {
        fs::create_dir_all(&trace_out)?;
        for entry in fs::read_dir(&trace_root)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("trace");
            write_redacted_jsonl(&path, &trace_out.join(format!("{stem}.redacted.jsonl")))?;
            trace_count += 1;
            file_count += 1;
        }
    }
    let log_root = cache_dir(workspace).join("copilot-logs");
    if log_root.exists() {
        let mut summaries = Vec::new();
        for file in collect_files(&log_root)? {
            if file.extension().and_then(|value| value.to_str()) != Some("log") {
                continue;
            }
            summaries.push(summarize_copilot_log(&file, workspace)?);
        }
        if !summaries.is_empty() {
            write_jsonl(&root.join("copilot-log-summary.redacted.jsonl"), &summaries)?;
            files.push(Value::String(
                "copilot-log-summary.redacted.jsonl".to_owned(),
            ));
            file_count += 1;
        }
    }
    let manifest = json!({
        "createdAt": now_iso(),
        "workspace": redact_sensitive(&workspace.to_string_lossy()),
        "cacheDir": redact_sensitive(&cache_dir(workspace).to_string_lossy()),
        "files": files,
        "traceCount": trace_count,
        "fileCount": file_count
    });
    write_pretty_json(&root.join("manifest.json"), &redact_json(&manifest))?;
    Ok(DebugBundleResult {
        path: root,
        file_count: file_count + 1,
        trace_count,
    })
}

fn write_redacted_jsonl(source: &Path, target: &Path) -> Result<()> {
    let records = read_jsonl_values(source)?;
    if !records.is_empty() {
        let redacted = records
            .into_iter()
            .map(|value| redact_json(&value))
            .collect::<Vec<_>>();
        write_jsonl(target, &redacted)?;
        return Ok(());
    }
    let text = fs::read_to_string(source).unwrap_or_default();
    if !text.is_empty() {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(target, redact_sensitive(&text))?;
    } else {
        write_jsonl::<Value>(target, &[])?;
    }
    Ok(())
}

fn redact_json(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_sensitive(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_json).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), redact_json(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn timestamp_name() -> String {
    now_iso().replace([':', '.'], "-")
}

fn collect_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            files.extend(collect_files(&path)?);
        } else {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn summarize_copilot_log(path: &Path, workspace: &Path) -> Result<Value> {
    let text = fs::read_to_string(path)?;
    let signal_pattern =
        Regex::new(r"(?i)\b(ERROR|WARN|warning|failed|failure|denied|timeout|refused)\b").unwrap();
    let mut categories: Map<String, Value> = Map::new();
    let mut retained = Vec::new();
    let mut line_count = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        line_count += 1;
        if let Some(category) = log_noise_category(line) {
            let count = categories
                .get(category)
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            categories.insert(category.to_owned(), Value::Number(count.into()));
            continue;
        }
        if signal_pattern.is_match(line) {
            retained.push(truncate(&redact_sensitive(line), 1000));
        }
    }
    retained = unique_strings(retained).into_iter().take(40).collect();
    Ok(json!({
        "source": redact_sensitive(&path.to_string_lossy().replace(&workspace.to_string_lossy().to_string(), ".")),
        "lineCount": line_count,
        "noiseCategories": Value::Object(categories),
        "retainedSignals": retained
    }))
}

fn log_noise_category(line: &str) -> Option<&'static str> {
    if Regex::new(r"(?i)telemetry|telemetry-queue|Sending telemetry event")
        .unwrap()
        .is_match(line)
    {
        return Some("telemetry");
    }
    if Regex::new(r"(?i)No GitHub repository detected|Mission Control|remote session|403|repo-less remote session").unwrap().is_match(line) {
        return Some("remote_session_policy");
    }
    if Regex::new(r"(?i)MCP|mcp|forge_extension|Model Context Protocol")
        .unwrap()
        .is_match(line)
    {
        return Some("mcp_lifecycle");
    }
    if Regex::new(r"(?i)shutdown|Ignoring transient stdout error|Unregistering foreground session|Broadcasting session lifecycle").unwrap().is_match(line) {
        return Some("session_shutdown");
    }
    if Regex::new(r"Possible EventEmitter memory leak|paletteColor")
        .unwrap()
        .is_match(line)
    {
        return Some("eventemitter_warning");
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkflowCapsule {
    #[serde(default)]
    purpose: String,
    #[serde(default)]
    parameters: Vec<String>,
    #[serde(default)]
    binding_sources: Vec<String>,
    #[serde(default)]
    steps: Vec<String>,
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    success_criteria: Vec<String>,
    #[serde(default)]
    failed_attempts: Vec<String>,
    #[serde(default)]
    validation_probe: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ArcEvent {
    #[serde(default)]
    id: String,
    #[serde(default)]
    runner: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    workspace: String,
    #[serde(default)]
    timestamp: String,
    #[serde(rename = "type", default)]
    type_: String,
    #[serde(default)]
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceOutcome {
    status: String,
    confidence: f64,
    reasons: Vec<String>,
    success_signals: Vec<String>,
    failure_signals: Vec<String>,
    aborted_signals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceEpisode {
    prompt: String,
    assistant_messages: Vec<String>,
    commands: Vec<String>,
    paths: Vec<String>,
    tool_events: Vec<ArcEvent>,
    outcome: EvidenceOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidencePacket {
    runner: String,
    session_id: String,
    workspace: String,
    created_at: String,
    episodes: Vec<EvidenceEpisode>,
    prompts: Vec<String>,
    assistant_messages: Vec<String>,
    tool_events: Vec<ArcEvent>,
    commands: Vec<String>,
    paths: Vec<String>,
    event_count: usize,
    outcome: EvidenceOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRecord {
    session_id: String,
    workspace: String,
    trace_hash: String,
    event_count: usize,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capsule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rejection_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runner_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    injected_capsule_ids: Option<Vec<String>>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeclinedDraftRecord {
    id: String,
    merge_key: String,
    created_at: String,
    session_id: String,
    outcome: String,
    reason: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct ReviewOutcome {
    status: String,
    reason: Option<String>,
    capsule_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct ReviewOptions {
    injected_capsule_ids: Vec<String>,
    judge_decision_ids: Vec<String>,
    consult_applied: Option<bool>,
    consult_capsule_id: Option<String>,
    consult_abstain_reason: Option<String>,
    action_risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Capsule {
    #[serde(default)]
    id: String,
    #[serde(default)]
    runner: String,
    #[serde(default)]
    workspace: String,
    #[serde(default)]
    workspace_key: String,
    #[serde(default)]
    workspace_group: String,
    #[serde(default)]
    source_session_id: String,
    #[serde(default)]
    source_session_ids: Vec<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    privacy_label: String,
    #[serde(default)]
    contributors: Vec<String>,
    #[serde(default)]
    use_count: u64,
    #[serde(default)]
    success_count: u64,
    #[serde(default)]
    failure_count: u64,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    merge_key: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default = "default_true")]
    reusable: bool,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    reuse_when: Vec<String>,
    #[serde(default)]
    do_not_reuse_when: Vec<String>,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    provenance: Vec<String>,
    #[serde(default)]
    artifact_sources: Vec<String>,
    #[serde(default)]
    supersedes: Vec<String>,
    #[serde(default)]
    superseded_by: Vec<String>,
    #[serde(default)]
    confidence_reason: String,
    #[serde(default)]
    failure_boundary: Vec<String>,
    #[serde(default)]
    validation_provenance: Vec<String>,
    #[serde(default)]
    outcome_status: String,
    #[serde(default)]
    next_run_instruction: String,
    #[serde(default)]
    workflow: WorkflowCapsule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    embedding: Option<CapsuleEmbedding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    graph: Option<Vec<CapsuleGraphEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binding_snapshots: Option<Vec<BindingSourceSnapshot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    staleness: Option<CapsuleStaleness>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapsuleEmbedding {
    model: String,
    text_hash: String,
    vector: Vec<f64>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapsuleGraphEdge {
    to: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    score: Option<f64>,
    reason: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindingSourceSnapshot {
    source: String,
    exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    captured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapsuleStaleness {
    stale: bool,
    checked_at: String,
    reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InjectionPlan {
    should_inject: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capsule: Option<Capsule>,
    message: String,
    reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    judge_decision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consult_applied: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consult_capsule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consult_abstain_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    action_risk: Option<String>,
}

#[derive(Default)]
struct InjectionContext {
    session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapsuleSearchResult {
    id: String,
    title: String,
    summary: String,
    score: f64,
    adjusted_score: f64,
    reputation: f64,
    source: String,
    reuse_when: Vec<String>,
    next_run_instruction: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCapsuleResult {
    requested_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryEvent {
    #[serde(default)]
    id: String,
    r#type: String,
    timestamp: String,
    workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capsule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ArcConfig {
    version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sidecar_copilot_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    injection_judge_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    injection_judge_model: Option<JudgeModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    injection_paused_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JudgeModel {
    provider: String,
    id: String,
}

#[derive(Default)]
struct ArcConfigPatch {
    sidecar_copilot_command: Option<String>,
    injection_judge_mode: Option<String>,
    injection_judge_model: Option<JudgeModel>,
    injection_paused_until: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InjectionPauseStatus {
    paused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paused_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seconds_remaining: Option<i64>,
    label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JudgeDecisionRecord {
    id: String,
    timestamp: String,
    workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    prompt_hash: String,
    #[serde(rename = "mode")]
    mode_: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<JudgeModel>,
    candidates: Vec<JudgeCandidate>,
    verdict: JudgeVerdict,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<JudgeOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JudgeCandidate {
    capsule_id: String,
    score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reputation: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct JudgeVerdict {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    abstain: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct JudgeOutcome {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    injected: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    used: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    helped: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapsuleReputation {
    capsule_id: String,
    score: f64,
    retrieved: u64,
    accepted: u64,
    rejected: u64,
    helped: u64,
    pending_reject_prompt_hashes: Vec<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReputationFile {
    version: u64,
    capsules: HashMap<String, CapsuleReputation>,
}

fn non_task_prompt(prompt: &str) -> bool {
    let normalized = Regex::new(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&normalize(prompt), " ")
        .trim()
        .to_owned();
    if normalized.is_empty() {
        return true;
    }
    matches!(
        normalized.as_str(),
        "hi" | "hello"
            | "hey"
            | "yo"
            | "sup"
            | "thanks"
            | "thank you"
            | "ok"
            | "okay"
            | "cool"
            | "nice"
            | "lol"
            | "haha"
    )
}

fn action_risk_gate(prompt: &str) -> Option<String> {
    let normalized = normalize(prompt);
    if explicit_no_live_action(&normalized) {
        return Some("prompt explicitly disallows live or remote actions".to_owned());
    }
    if manual_advice_prompt(&normalized) && !explicit_live_action_intent(&normalized) {
        return Some("prompt asks for manual guidance rather than live action".to_owned());
    }
    if pasted_diagnostic_prompt(prompt, &normalized) && !explicit_live_action_intent(&normalized) {
        return Some("prompt is pasted diagnostic output without live-action intent".to_owned());
    }
    if advice_only_prompt(&normalized) && !explicit_live_action_intent(&normalized) {
        return Some("prompt asks for advice without live-action intent".to_owned());
    }
    None
}

fn live_action_capsule(capsule: &Capsule) -> bool {
    let text = [
        capsule.workflow.commands.join("\n"),
        capsule.workflow.validation_probe.join("\n"),
        capsule.workflow.failed_attempts.join("\n"),
    ]
    .join("\n")
    .to_lowercase();
    Regex::new(r"\b(?:ssh|scp|rsync|kubectl|external-runner)\b")
        .unwrap()
        .is_match(&text)
        || Regex::new(r"\bdocker\s+exec\b").unwrap().is_match(&text)
}

fn explicit_no_live_action(prompt: &str) -> bool {
    Regex::new(r"\b(?:no|without)\s+external-runner\b").unwrap().is_match(prompt)
        || Regex::new(r"\b(?:no|without)\s+(?:running|runs?|execution|executing|live|remote|external|connection)\b").unwrap().is_match(prompt)
        || Regex::new(r"\b(?:do not|dont|don't|never)\s+(?:run|execute|touch|change|mutate|connect|inspect live|use remote)\b").unwrap().is_match(prompt)
        || Regex::new(r"\bjust\s+(?:tell|explain|describe)\b.*\b(?:no|without)\s+(?:running|executing|live|remote|external)\b").unwrap().is_match(prompt)
}

fn manual_advice_prompt(prompt: &str) -> bool {
    Regex::new(r"\bmanual(?:ly)?\b").unwrap().is_match(prompt)
        && Regex::new(r"\b(?:how|check|verify|tell|show|steps?)\b")
            .unwrap()
            .is_match(prompt)
}

fn pasted_diagnostic_prompt(raw_prompt: &str, prompt: &str) -> bool {
    if Regex::new(r"\b(?:pasted|output|logs?|trace|transcript|stderr|stdout|diagnostic|dump)\b")
        .unwrap()
        .is_match(prompt)
    {
        return true;
    }
    let diagnostic = Regex::new(r"(?i)\b(?:error|failed|failure|warning|traceback|exception|stderr|stdout|missing|invalid|timeout)\b").unwrap();
    let diagnostic_lines = raw_prompt
        .lines()
        .filter(|line| {
            Regex::new(r"^\s*(?:\$|>|#)\s+\S").unwrap().is_match(line) || diagnostic.is_match(line)
        })
        .count();
    raw_prompt.lines().count() >= 4 && diagnostic_lines >= 2
}

fn advice_only_prompt(prompt: &str) -> bool {
    Regex::new(r"\b(?:just|only)\s+(?:tell|explain|describe|say)\b")
        .unwrap()
        .is_match(prompt)
        || Regex::new(r"\bhow\s+(?:do|can|should)\s+i\b")
            .unwrap()
            .is_match(prompt)
        || Regex::new(r"\bwhat\s+(?:should|would|can)\s+i\b")
            .unwrap()
            .is_match(prompt)
}

fn explicit_live_action_intent(prompt: &str) -> bool {
    Regex::new(r"\bexternal-runner\b").unwrap().is_match(prompt)
        || Regex::new(r"\b(?:connect\s+to|log\s+into|login\s+to)\b").unwrap().is_match(prompt)
        || Regex::new(r"\b(?:run|execute|inspect|check|probe|debug|connect)\b.{0,60}\b(?:live|remote|external|server|host|resource|environment)\b").unwrap().is_match(prompt)
        || Regex::new(r"\b(?:live|remote|external|server|host|resource|environment)\b.{0,60}\b(?:run|execute|inspect|check|probe|debug|connect)\b").unwrap().is_match(prompt)
}

fn orienting_prompt(prompt: &str) -> bool {
    let words = normalize(prompt)
        .split(' ')
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    [
        "what", "whats", "explain", "describe", "overview", "about", "where", "which", "list",
        "show",
    ]
    .iter()
    .any(|word| words.contains(*word))
}

fn cosine(left: &[f64], right: &[f64]) -> f64 {
    if left.is_empty() || left.len() != right.len() {
        return -1.0;
    }
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for index in 0..left.len() {
        dot += left[index] * right[index];
        left_norm += left[index] * left[index];
        right_norm += right[index] * right[index];
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        -1.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

fn record_memory_event(
    workspace: &Path,
    type_: &str,
    session_id: Option<String>,
    turn_id: Option<String>,
    capsule_id: Option<String>,
    details: Option<Value>,
) -> Result<MemoryEvent> {
    let event = MemoryEvent {
        id: generated_id(),
        r#type: type_.to_owned(),
        timestamp: now_iso(),
        workspace: workspace.to_string_lossy().to_string(),
        session_id,
        turn_id,
        capsule_id,
        details,
    };
    append_jsonl(&memory_events_path(workspace), &event)?;
    Ok(event)
}

fn load_memory_events(workspace: &Path) -> Result<Vec<MemoryEvent>> {
    let values = read_jsonl_values(&memory_events_path(workspace))?;
    Ok(values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<MemoryEvent>(value).ok())
        .filter(|event| {
            !event.r#type.is_empty() && !event.timestamp.is_empty() && !event.workspace.is_empty()
        })
        .collect())
}

fn review_options_for_session(
    _events: &[ArcEvent],
    workspace: &Path,
    session_id: &str,
) -> Result<ReviewOptions> {
    let mut options = ReviewOptions::default();
    for event in load_memory_events(workspace)?
        .into_iter()
        .filter(|event| event.r#type == "capsule.injected")
        .filter(|event| event.session_id.as_deref() == Some(session_id))
    {
        if let Some(capsule_id) = event.capsule_id.filter(|id| !id.is_empty()) {
            options.injected_capsule_ids.push(capsule_id);
        }
        let Some(details) = event.details else {
            continue;
        };
        options
            .injected_capsule_ids
            .extend(value_array_strings(details.get("injectedCapsuleIds")));
        if let Some(id) = details
            .get("capsuleId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|id| !id.is_empty())
        {
            options.injected_capsule_ids.push(id);
        }
        if let Some(id) = details
            .get("judgeDecisionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|id| !id.is_empty())
        {
            options.judge_decision_ids.push(id);
        }
        options
            .judge_decision_ids
            .extend(value_array_strings(details.get("judgeDecisionIds")));
        if let Some(value) = details.get("consultApplied").and_then(Value::as_bool) {
            options.consult_applied = Some(value);
        }
        if let Some(value) = details
            .get("consultCapsuleId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.is_empty())
        {
            options.consult_capsule_id = Some(value);
        }
        if let Some(value) = details
            .get("consultAbstainReason")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.is_empty())
        {
            options.consult_abstain_reason = Some(value);
        }
        if let Some(value) = details
            .get("actionRisk")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.is_empty())
        {
            options.action_risk = Some(value);
        }
    }
    options.injected_capsule_ids = unique_strings(options.injected_capsule_ids);
    options.judge_decision_ids = unique_strings(options.judge_decision_ids);
    Ok(options)
}

fn debug(workspace: &Path, action: &str, details: Value) -> Result<()> {
    append_jsonl(
        &debug_path(workspace),
        &json!({
            "timestamp": now_iso(),
            "action": action,
            "details": details
        }),
    )
}

#[derive(Default)]
struct SidecarConsult {
    applies: bool,
    capsule_id: Option<String>,
    confidence: Option<f64>,
    reason: Option<String>,
    note: Option<String>,
}

fn consult_capsule_vault(
    prompt: &str,
    shortlist: &[Capsule],
    workspace: &Path,
    judge_model: Option<JudgeModel>,
) -> Result<SidecarConsult> {
    let (source, input, output) = if let Some(command) = configured_consult_command() {
        let payload = json!({
            "task": "consult",
            "workspace": workspace,
            "prompt": prompt,
            "capsules": shortlist,
            "judgeModel": judge_model.as_ref()
        });
        let input = serde_json::to_string(&payload)?;
        let mut child = if cfg!(windows) {
            let mut child = Command::new("cmd");
            child.args(["/C", &command]);
            child
        } else {
            let mut child = Command::new("sh");
            child.args(["-lc", &command]);
            child
        };
        let mut child = child
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(input.as_bytes())?;
        }
        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(anyhow!("{}", String::from_utf8_lossy(&output.stderr)));
        }
        (
            "command".to_owned(),
            input,
            String::from_utf8_lossy(&output.stdout).to_string(),
        )
    } else {
        let model = judge_model
            .as_ref()
            .ok_or_else(|| anyhow!("consult sidecar not configured"))?;
        let input = consult_prompt(prompt, shortlist)?;
        let output = run_judge_sidecar(&input, workspace, model)?;
        (model.provider.clone(), input, output)
    };
    let value = extract_json_object(&output)?;
    record_sidecar_exchange(workspace, "consult", &source, &input, &output, &value)?;
    debug(
        workspace,
        &format!("sidecar.consult.{source}"),
        json!({
            "bytes": output.len(),
            "candidateCount": shortlist.len(),
            "model": judge_model.as_ref().map(|model| model.id.clone())
        }),
    )?;
    Ok(SidecarConsult {
        applies: value["applies"].as_bool().unwrap_or(false),
        capsule_id: value["capsuleId"].as_str().map(str::to_owned),
        confidence: value["confidence"].as_f64(),
        reason: value["reason"].as_str().map(str::to_owned),
        note: value["note"].as_str().map(str::to_owned),
    })
}

fn configured_consult_command() -> Option<String> {
    if let Ok(command) = env::var("AGENT_RUN_CACHE_CONSULT_COMMAND") {
        let command = command.trim();
        if !command.is_empty() && command != "off" {
            return Some(command.to_owned());
        }
    }
    let command = env::var("AGENT_RUN_CACHE_MODEL_SIDECAR").ok()?;
    let command = command.trim();
    if command.is_empty() || matches!(command, "auto" | "off" | "opencode" | "copilot") {
        None
    } else {
        Some(command.to_owned())
    }
}

fn consult_prompt(prompt: &str, shortlist: &[Capsule]) -> Result<String> {
    let capsules = truncate(&serde_json::to_string(shortlist)?, 60_000);
    Ok(format!(
        r#"You are the Agent Run Cache consulting sidecar.

The main agent is about to handle a user prompt in this repository. Decide whether any saved workflow capsule from this repo is close enough to help.

Return JSON only:
{{
  "applies": true,
  "capsuleId": "id from the vault",
  "confidence": 0.0,
  "reason": "why this applies",
  "note": "compact note to give the main agent"
}}

If nothing clearly applies, return {{"applies": false, "confidence": 0.0, "reason": "..."}}.

Rules:
- Decide semantic similarity rather than requiring exact words.
- Prefer one strong capsule over many weak ones.
- Return applies:false when the user explicitly forbids the capsule's action.
- Stay silent when the prompt is unrelated.

User prompt:
{prompt}

Capsule vault:
{capsules}"#
    ))
}

fn extract_json_object(text: &str) -> Result<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Ok(value);
    }
    let first = trimmed
        .find('{')
        .ok_or_else(|| anyhow!("No JSON object found in sidecar output."))?;
    let last = trimmed
        .rfind('}')
        .ok_or_else(|| anyhow!("No JSON object found in sidecar output."))?;
    Ok(serde_json::from_str(&trimmed[first..=last])?)
}

fn handle_copilot_hook(hook_name: &str) -> Result<Value> {
    if env::var("AGENT_RUN_CACHE_IN_SIDECAR").ok().as_deref() == Some("1") {
        return Ok(json!({}));
    }
    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;
    let payload = if stdin.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&stdin)?
    };
    let input = payload
        .get("input")
        .filter(|v| v.is_object())
        .unwrap_or(&payload);
    let cwd = input["cwd"]
        .as_str()
        .or_else(|| payload["cwd"].as_str())
        .unwrap_or(".");
    let workspace = workspace_root(PathBuf::from(cwd))?;
    if is_plugin_hook() {
        let _ = remember_copilot_plugin_workspace(&workspace);
    }
    if !is_workspace_activated(&workspace) {
        if is_plugin_hook() {
            write_activation(&workspace, "copilot-plugin")?;
        } else {
            return Ok(json!({}));
        }
    }
    let session_id = input["sessionId"]
        .as_str()
        .or_else(|| payload["sessionId"].as_str())
        .unwrap_or("unknown")
        .to_owned();
    if hook_name == "SessionStart" {
        debug(
            &workspace,
            "hook.session_start",
            json!({ "sessionId": session_id, "context": "clean" }),
        )?;
        return Ok(json!({}));
    }
    if hook_name == "UserPromptSubmit" {
        let prompt = input["prompt"].as_str().unwrap_or("");
        return Ok(
            build_copilot_prompt_injection(prompt, &workspace, &session_id, "json-hook")?
                ["hookResult"]
                .clone(),
        );
    }
    if hook_name == "SessionEnd" && session_id != "unknown" {
        let harvested = harvest_session(&session_id, &workspace).unwrap_or_else(|error| {
            let _ = debug(
                &workspace,
                "hook.session_end.harvest_failed",
                json!({ "sessionId": session_id, "error": error.to_string() }),
            );
            false
        });
        debug(
            &workspace,
            "hook.session_end",
            json!({ "sessionId": session_id, "harvested": harvested }),
        )?;
    }
    Ok(json!({}))
}

fn build_copilot_prompt_injection(
    prompt: &str,
    workspace: &Path,
    session_id: &str,
    surface: &str,
) -> Result<Value> {
    if prompt.is_empty()
        || prompt.contains("Agent Run Cache sidecar note:")
        || prompt.contains("Agent Run Cache consult:")
    {
        return Ok(json!({
            "hookResult": {},
            "plan": { "shouldInject": false, "reason": "ignored ARC sidecar or empty prompt", "source": "local" }
        }));
    }
    let plan = build_injection_plan(
        prompt,
        workspace,
        InjectionContext {
            session_id: Some(session_id.to_owned()),
        },
        false,
    )?;
    let summary = summarize_injection_plan(&plan);
    if !plan.should_inject {
        debug(
            workspace,
            "copilot.prompt.no_context",
            json!({ "sessionId": session_id, "surface": surface, "reason": plan.reason }),
        )?;
        return Ok(json!({ "hookResult": {}, "plan": summary }));
    }
    debug(
        workspace,
        "copilot.prompt.context",
        json!({ "sessionId": session_id, "surface": surface, "reason": plan.reason, "source": plan.source }),
    )?;
    record_memory_event(
        workspace,
        "capsule.injected",
        Some(session_id.to_owned()),
        None,
        plan.capsule.as_ref().map(|capsule| capsule.id.clone()),
        Some(json!({
            "source": plan.source,
            "surface": surface,
            "reason": plan.reason,
            "title": plan.capsule.as_ref().map(|c| c.title.clone()),
            "injected": true,
            "used": "unknown",
            "helped": "unknown",
            "judgeDecisionId": plan.judge_decision_id,
            "judgeDecisionIds": plan.judge_decision_id.as_ref().map(|id| vec![id.clone()]),
            "injectedCapsuleIds": plan.capsule.as_ref().map(|capsule| vec![capsule.id.clone()]),
            "consultApplied": plan.consult_applied,
            "consultCapsuleId": plan.consult_capsule_id,
            "consultAbstainReason": plan.consult_abstain_reason,
            "actionRisk": plan.action_risk
        })),
    )?;
    let recall = plan
        .capsule
        .as_ref()
        .map(|capsule| format!("ARC recalled: {}", capsule.title))
        .unwrap_or_else(|| "ARC recalled: matching capsule".to_owned());
    let context = format!("{recall}\n\n{}", plan.message);
    Ok(json!({
        "hookResult": {
            "additionalContext": context,
            "modifiedPrompt": format!("{context}\n\nUser task:\n{prompt}")
        },
        "notice": plan.capsule.as_ref().map(|capsule| format!("ARC recalled {}", capsule.title)).unwrap_or_else(|| "ARC recalled a matching capsule".to_owned()),
        "plan": summary
    }))
}

fn summarize_injection_plan(plan: &InjectionPlan) -> Value {
    let mut map = Map::new();
    map.insert("shouldInject".to_owned(), Value::Bool(plan.should_inject));
    if let Some(capsule) = &plan.capsule {
        map.insert("capsuleId".to_owned(), Value::String(capsule.id.clone()));
        map.insert(
            "capsuleTitle".to_owned(),
            Value::String(capsule.title.clone()),
        );
    }
    map.insert("reason".to_owned(), Value::String(plan.reason.clone()));
    optional_insert(&mut map, "source", plan.source.clone().map(Value::String));
    optional_insert(
        &mut map,
        "judgeDecisionId",
        plan.judge_decision_id.clone().map(Value::String),
    );
    optional_insert(
        &mut map,
        "consultApplied",
        plan.consult_applied.map(Value::Bool),
    );
    optional_insert(
        &mut map,
        "consultCapsuleId",
        plan.consult_capsule_id.clone().map(Value::String),
    );
    optional_insert(
        &mut map,
        "consultAbstainReason",
        plan.consult_abstain_reason.clone().map(Value::String),
    );
    optional_insert(
        &mut map,
        "actionRisk",
        plan.action_risk.clone().map(Value::String),
    );
    Value::Object(map)
}

fn optional_insert(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value);
    }
}

fn status_payload(workspace: &Path) -> Result<Value> {
    let capsules = load_capsules(workspace)?;
    let events = load_memory_events(workspace)?;
    let config = load_arc_config()?;
    let judge_reachability = judge_reachability(&config);
    let injection_pause = injection_pause_status(&config);
    Ok(json!({
        "workspace": workspace,
        "cacheDir": cache_dir(workspace),
        "memoryPath": memory_path(workspace),
        "memoryEventsPath": memory_events_path(workspace),
        "integration": read_activation_integration(workspace),
        "plugin": copilot_plugin_status(),
        "extension": extension_status(workspace),
        "hook": hook_status(workspace),
        "judge": {
            "mode": config.injection_judge_mode.clone().unwrap_or_else(|| "embedding-only".to_owned()),
            "model": config.injection_judge_model.clone(),
            "reachability": judge_reachability
        },
        "injectionPause": injection_pause,
        "capsuleCount": capsules.len(),
        "eventCount": events.len(),
        "generatedAt": now_iso()
    }))
}

fn last_event(events: &[MemoryEvent], type_: &str) -> Option<Value> {
    let event = events.iter().rev().find(|event| event.r#type == type_)?;
    serde_json::to_value(event).ok()
}

fn last_save_event(events: &[MemoryEvent]) -> Option<Value> {
    let wanted = ["capsule.finalized", "capsule.created", "capsule.updated"];
    let event = events
        .iter()
        .rev()
        .find(|event| wanted.contains(&event.r#type.as_str()))?;
    serde_json::to_value(event).ok()
}

fn workspace_root(cwd: PathBuf) -> Result<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !text.is_empty() {
                return Ok(PathBuf::from(text));
            }
        }
    }
    Ok(if cwd.is_absolute() {
        cwd
    } else {
        env::current_dir()?.join(cwd)
    })
}

fn cache_dir(workspace: &Path) -> PathBuf {
    env::var("AGENT_RUN_CACHE_DIR")
        .map(PathBuf::from)
        .map(absolutize)
        .unwrap_or_else(|_| workspace.join(".agent-run-cache"))
}

fn ensure_cache(workspace: &Path) -> Result<PathBuf> {
    let dir = cache_dir(workspace);
    fs::create_dir_all(dir.join("traces"))?;
    fs::create_dir_all(dir.join("debug"))?;
    fs::create_dir_all(dir.join("copilot-logs"))?;
    fs::create_dir_all(dir.join("locks"))?;
    Ok(dir)
}

fn memory_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("memory.jsonl")
}

fn memory_events_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("memory-events.jsonl")
}

fn trace_path(session_id: &str, workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("traces")
        .join(format!("arc-{}.jsonl", safe_name(session_id)))
}

fn debug_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("debug/runtime.jsonl")
}

fn reviewed_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("reviewed.jsonl")
}

fn declined_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("declined.jsonl")
}

fn sidecar_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("debug/sidecar.jsonl")
}

fn judge_decisions_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("judge-decisions.jsonl")
}

fn retrieval_reputation_path(workspace: &Path) -> PathBuf {
    ensure_cache(workspace)
        .unwrap_or_else(|_| cache_dir(workspace))
        .join("retrieval-reputation.json")
}

fn activation_path(workspace: &Path) -> PathBuf {
    cache_dir(workspace).join("enabled.json")
}

fn arc_home() -> PathBuf {
    env::var("AGENT_RUN_CACHE_HOME")
        .map(PathBuf::from)
        .map(absolutize)
        .unwrap_or_else(|_| home_dir().join(".agent-run-cache"))
}

fn arc_config_path() -> PathBuf {
    arc_home().join("config.json")
}

fn copilot_home() -> PathBuf {
    env::var("COPILOT_HOME")
        .map(PathBuf::from)
        .map(absolutize)
        .unwrap_or_else(|_| home_dir().join(".copilot"))
}

fn copilot_user_hooks_dir() -> PathBuf {
    copilot_home().join("hooks")
}

fn copilot_user_extensions_dir() -> PathBuf {
    copilot_home().join("extensions")
}

fn copilot_transcript_path(session_id: &str) -> PathBuf {
    env::var("AGENT_RUN_CACHE_COPILOT_STATE_DIR")
        .map(PathBuf::from)
        .map(absolutize)
        .unwrap_or_else(|_| home_dir().join(".copilot/session-state"))
        .join(session_id)
        .join("events.jsonl")
}

fn workspace_key(workspace: &Path) -> String {
    if let Ok(output) = Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(workspace)
        .output()
    {
        if output.status.success() {
            let remote = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !remote.is_empty() {
                return format!("git:{}", hash24(&normalize_git_remote(&remote)));
            }
        }
    }
    let root_name = workspace
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace");
    format!(
        "local:{}:{}",
        safe_name(root_name),
        &hash24(&workspace.to_string_lossy())[..12]
    )
}

fn workspace_group() -> String {
    env::var("AGENT_RUN_CACHE_WORKSPACE_GROUP").unwrap_or_default()
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn absolutize(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn read_jsonl_values(path: &Path) -> Result<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)?;
    let mut values = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        let line = if index == 0 {
            line.trim_start_matches('\u{feff}')
        } else {
            line
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            values.push(value);
        }
    }
    Ok(values)
}

fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{}", serde_json::to_string(value)?)?;
    Ok(())
}

fn write_jsonl<T: Serialize>(path: &Path, values: &[T]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.{}.tmp", std::process::id(), random_suffix()));
    let mut text = values
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    if !values.is_empty() {
        text.push('\n');
    }
    fs::write(&temp, text)?;
    fs::rename(&temp, path)?;
    Ok(())
}

fn write_pretty_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

fn write_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}

fn write_json_line(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}

fn is_capsule_value(value: &Value) -> bool {
    value["title"].is_string()
        && value["summary"].is_string()
        && value["nextRunInstruction"].is_string()
        && value["workflow"].is_object()
        && value["workflow"]["purpose"].is_string()
        && value["workflow"]["steps"].is_array()
}

fn find_capsule<'a>(capsules: &'a [Capsule], id_or_prefix: &str) -> Option<&'a Capsule> {
    capsules
        .iter()
        .find(|capsule| capsule.id == id_or_prefix || capsule.id.starts_with(id_or_prefix))
}

fn delete_capsule(id_or_prefix: &str, workspace: &Path) -> Result<DeleteCapsuleResult> {
    let mut capsules = load_capsules(workspace)?;
    let Some(index) = capsules
        .iter()
        .position(|capsule| capsule.id == id_or_prefix || capsule.id.starts_with(id_or_prefix))
    else {
        return Ok(DeleteCapsuleResult {
            requested_id: id_or_prefix.to_owned(),
            id: None,
            deleted: false,
        });
    };
    let deleted = capsules.remove(index);
    write_jsonl(&memory_path(workspace), &capsules)?;
    record_memory_event(
        workspace,
        "capsule.deleted",
        Some(deleted.source_session_id.clone()),
        None,
        Some(deleted.id.clone()),
        Some(json!({ "title": deleted.title })),
    )?;
    Ok(DeleteCapsuleResult {
        requested_id: id_or_prefix.to_owned(),
        id: Some(deleted.id),
        deleted: true,
    })
}

fn capsule_scope(capsule: &Capsule) -> String {
    if !capsule.workspace_group.trim().is_empty() {
        format!("group:{}", capsule.workspace_group)
    } else {
        "workspace".to_owned()
    }
}

fn capsule_json_with_scope(capsule: &Capsule) -> Value {
    let mut value = serde_json::to_value(capsule).unwrap_or_else(|_| json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("scope".to_owned(), Value::String(capsule_scope(capsule)));
    }
    value
}

fn capsule_markdown(capsule: &Capsule) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", capsule.title));
    out.push_str(&format!("- id: `{}`\n", capsule.id));
    out.push_str(&format!("- kind: `{}`\n", capsule.kind));
    out.push_str(&format!("- scope: `{}`\n", capsule_scope(capsule)));
    out.push_str(&format!("- confidence: {:.2}\n", capsule.confidence));
    out.push_str(&format!("- updated: `{}`\n\n", capsule.updated_at));
    if !capsule.summary.is_empty() {
        out.push_str("## Summary\n\n");
        out.push_str(&capsule.summary);
        out.push_str("\n\n");
    }
    markdown_list(&mut out, "Reuse When", &capsule.reuse_when);
    markdown_list(&mut out, "Do Not Reuse When", &capsule.do_not_reuse_when);
    if !capsule.next_run_instruction.is_empty() {
        out.push_str("## Next Run Instruction\n\n");
        out.push_str(&capsule.next_run_instruction);
        out.push_str("\n\n");
    }
    markdown_list(
        &mut out,
        "Binding Sources",
        &capsule.workflow.binding_sources,
    );
    markdown_list(&mut out, "Steps", &capsule.workflow.steps);
    markdown_list(&mut out, "Command Shapes", &capsule.workflow.commands);
    markdown_list(&mut out, "Validation", &capsule.workflow.validation_probe);
    out
}

fn markdown_list(out: &mut String, title: &str, values: &[String]) {
    let values = values
        .iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return;
    }
    out.push_str(&format!("## {title}\n\n"));
    for value in values {
        out.push_str(&format!("- {value}\n"));
    }
    out.push('\n');
}

fn print_capsule(capsule: &Capsule) {
    println!(
        "{}  {}/{}",
        capsule.id, capsule.status, capsule.privacy_label
    );
    println!("{}", capsule.title);
    if !capsule.summary.is_empty() {
        println!("{}", capsule.summary);
    }
    if !capsule.next_run_instruction.is_empty() {
        println!("next: {}", capsule.next_run_instruction);
    }
}

fn clean(value: &str) -> String {
    collapse_whitespace(value).chars().take(4000).collect()
}

fn clean_for_workspace(value: &str, workspace: &Path) -> String {
    portable(&clean(value), workspace)
}

fn clean_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| clean(value))
        .filter(|value| !value.is_empty())
        .take(24)
        .collect()
}

fn clean_list_for_workspace(values: &[String], workspace: &Path) -> Vec<String> {
    clean_list(values)
        .into_iter()
        .map(|value| portable(&value, workspace))
        .collect()
}

fn portable(value: &str, workspace: &Path) -> String {
    let root = workspace.to_string_lossy().trim_end_matches('/').to_owned();
    let mut next = value.to_owned();
    if !root.is_empty() && root != "/" {
        let prefix = format!("{root}/");
        while next.contains(&prefix) {
            next = next.replace(&prefix, "");
        }
        if next == root {
            next = ".".to_owned();
        }
    }
    redact_sensitive(&next)
}

fn redact_sensitive(value: &str) -> String {
    let mut out = value.to_owned();
    let replacements = [
        (r#"https?://[^\s"'<>)]*"#, "<url>"),
        (r#"\b(?:10|127)\.(?:\d{1,3}\.){2}\d{1,3}\b"#, "<private-ip>"),
        (r#"\b192\.168\.\d{1,3}\.\d{1,3}\b"#, "<private-ip>"),
        (
            r#"\b172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}\b"#,
            "<private-ip>",
        ),
        (r#"\b169\.254\.\d{1,3}\.\d{1,3}\b"#, "<private-ip>"),
        (
            r#"\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b"#,
            "<mac-address>",
        ),
        (r#"\bglpat-[A-Za-z0-9_=-]{12,}\b"#, "<token>"),
        (
            r#"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_=-]{12,}\b"#,
            "<token>",
        ),
        (r#"\bgithub_pat_[A-Za-z0-9_=-]{12,}\b"#, "<token>"),
        (r#"\bxox[baprs]-[A-Za-z0-9-]{12,}\b"#, "<token>"),
        (
            r#"(?i)\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}\b"#,
            "<token>",
        ),
        (r#"/Users/[^/\s"'<>]+"#, "<home>"),
        (r#"/home/[^/\s"'<>]+"#, "<home>"),
    ];
    for (pattern, replacement) in replacements {
        out = Regex::new(pattern)
            .unwrap()
            .replace_all(&out, replacement)
            .into_owned();
    }
    Regex::new(r#"(?i)(["']?(?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY)["']?\s*[:=]\s*)["']?[^"'\s,}]+["']?"#)
        .unwrap()
        .replace_all(&out, "$1<token>")
        .into_owned()
}

fn collapse_whitespace(value: &str) -> String {
    let mut out = String::new();
    let mut spacing = false;
    for ch in value.trim().chars() {
        if ch.is_whitespace() {
            spacing = true;
            continue;
        }
        if spacing && !out.is_empty() {
            out.push(' ');
        }
        spacing = false;
        out.push(ch);
    }
    out
}

fn normalize(value: &str) -> String {
    let allowed = "abcdefghijklmnopqrstuvwxyz0123456789_./@:-";
    let mut out = String::new();
    let mut spacing = false;
    for ch in value.to_lowercase().trim().chars() {
        if allowed.contains(ch) {
            if spacing && !out.is_empty() {
                out.push(' ');
            }
            spacing = false;
            out.push(ch);
        } else {
            spacing = true;
        }
    }
    out
}

fn normalize_key(value: &str) -> String {
    collapse_whitespace(&value.to_lowercase())
}

fn normalize_status(value: &str) -> String {
    match value {
        "local" | "shareable" | "shared" | "rejected" | "superseded" | "private" => {
            value.to_owned()
        }
        _ => "local".to_owned(),
    }
}

fn normalize_privacy_label(value: &str) -> String {
    match value {
        "local" | "shareable" | "private" | "redacted" => value.to_owned(),
        _ => "local".to_owned(),
    }
}

fn normalize_outcome_status(value: &str) -> String {
    match value {
        "success" | "partial" | "failed" | "aborted" | "unknown" => value.to_owned(),
        _ => "unknown".to_owned(),
    }
}

fn default_contributors() -> Vec<String> {
    env::var("AGENT_RUN_CACHE_USER")
        .or_else(|_| env::var("USER"))
        .or_else(|_| env::var("LOGNAME"))
        .ok()
        .map(|value| clean(&value))
        .filter(|value| !value.is_empty())
        .map(|value| vec![value])
        .unwrap_or_default()
}

fn merge_kind(left: &str, right: &str) -> String {
    let left = left.to_lowercase();
    let right_lower = right.to_lowercase();
    if left == "workflow" || right_lower == "workflow" {
        "workflow".to_owned()
    } else if left == "command" || right_lower == "command" {
        "command".to_owned()
    } else if !right.is_empty() {
        right.to_owned()
    } else {
        left
    }
}

fn merge_status(left: &str, right: &str) -> String {
    if status_rank(right) > status_rank(left) {
        right.to_owned()
    } else {
        left.to_owned()
    }
}

fn status_rank(value: &str) -> i32 {
    match value {
        "rejected" => 0,
        "superseded" => 1,
        "private" => 2,
        "local" => 3,
        "shareable" => 4,
        "shared" => 5,
        _ => 3,
    }
}

fn merge_privacy_label(left: &str, right: &str) -> String {
    if left == "private" || right == "private" {
        "private".to_owned()
    } else if left == "redacted" || right == "redacted" {
        "redacted".to_owned()
    } else if left == "shareable" || right == "shareable" {
        "shareable".to_owned()
    } else {
        "local".to_owned()
    }
}

fn prefer_outcome(left: &str, right: &str) -> String {
    if outcome_rank(right) < outcome_rank(left) {
        right.to_owned()
    } else {
        left.to_owned()
    }
}

fn outcome_rank(value: &str) -> i32 {
    match value {
        "success" => 5,
        "partial" => 4,
        "unknown" => 3,
        "failed" => 2,
        "aborted" => 1,
        _ => 3,
    }
}

fn prefer_longer(left: &str, right: &str) -> String {
    if left.is_empty() {
        right.to_owned()
    } else if right.is_empty() {
        left.to_owned()
    } else if (right.len() as f64) > (left.len() as f64 * 1.25) {
        right.to_owned()
    } else {
        left.to_owned()
    }
}

fn unique_limited(left: &[String], right: &[String], limit: usize) -> Vec<String> {
    let mut values = left.iter().chain(right.iter()).cloned().collect::<Vec<_>>();
    values = unique_strings(
        values
            .into_iter()
            .map(|value| clean(&value))
            .filter(|value| !value.is_empty())
            .collect(),
    );
    values.truncate(limit);
    values
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn overlap(left: &[String], right: &[String]) -> bool {
    let values = left
        .iter()
        .map(|value| normalize_key(value))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    right
        .iter()
        .map(|value| normalize_key(value))
        .any(|value| values.contains(&value))
}

fn identity_text(capsule: &Capsule) -> String {
    [
        capsule.title.clone(),
        capsule.summary.clone(),
        capsule.workflow.purpose.clone(),
        capsule.reuse_when.join(" "),
        capsule.workflow.steps.join(" "),
    ]
    .join(" ")
}

fn command_shape_text(capsule: &Capsule) -> String {
    [
        capsule.workflow.commands.join(" "),
        capsule.workflow.validation_probe.join(" "),
        capsule.workflow.failed_attempts.join(" "),
    ]
    .join(" ")
}

fn binding_text(capsule: &Capsule) -> String {
    [
        capsule.workflow.binding_sources.join(" "),
        capsule.provenance.join(" "),
        capsule.artifact_sources.join(" "),
    ]
    .join(" ")
}

fn fingerprint_text(capsule: &Capsule) -> String {
    [
        capsule.kind.clone(),
        capsule.merge_key.clone(),
        capsule.title.clone(),
        capsule.summary.clone(),
        capsule.next_run_instruction.clone(),
        capsule.reuse_when.join(" "),
        capsule.do_not_reuse_when.join(" "),
        capsule.workflow.purpose.clone(),
        capsule.workflow.parameters.join(" "),
        capsule.workflow.binding_sources.join(" "),
        capsule.workflow.steps.join(" "),
        capsule.workflow.commands.join(" "),
        capsule.workflow.success_criteria.join(" "),
        capsule.workflow.failed_attempts.join(" "),
        capsule.workflow.validation_probe.join(" "),
    ]
    .join(" ")
}

fn core_identity_text(capsule: &Capsule) -> String {
    [
        capsule.title.clone(),
        capsule.summary.clone(),
        capsule.next_run_instruction.clone(),
        capsule.workflow.purpose.clone(),
        capsule.workflow.commands.join(" "),
    ]
    .join(" ")
}

fn token_similarity(left: &str, right: &str) -> f64 {
    token_overlap(left, right).0
}

fn token_overlap(left: &str, right: &str) -> (f64, usize) {
    let left_tokens = tokens(left);
    let right_tokens = tokens(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return (0.0, 0);
    }
    let right_set = right_tokens.iter().collect::<HashSet<_>>();
    let shared = left_tokens
        .iter()
        .filter(|token| right_set.contains(token))
        .collect::<Vec<_>>();
    (
        shared.len() as f64 / left_tokens.len().min(right_tokens.len()) as f64,
        shared
            .iter()
            .filter(|token| is_distinctive_token(token))
            .count(),
    )
}

fn tokens(value: &str) -> Vec<String> {
    unique_strings(
        Regex::new(r"[^a-z0-9_./:-]+")
            .unwrap()
            .split(&normalize_key(value))
            .flat_map(token_variants)
            .filter(|part| part.len() >= 3)
            .collect(),
    )
}

fn token_variants(part: &str) -> Vec<String> {
    let clean_part = part
        .trim_matches(|c: char| !matches!(c, 'a'..='z' | '0'..='9' | '_'))
        .to_owned();
    if clean_part.is_empty() {
        return Vec::new();
    }
    let mut values = vec![clean_part.clone()];
    if let Some(basename) = clean_part.split('/').rfind(|s| !s.is_empty()) {
        if basename != clean_part {
            values.push(basename.to_owned());
        }
    }
    for piece in Regex::new(r"[./:-]+").unwrap().split(&clean_part) {
        if !piece.is_empty() {
            values.push(piece.to_owned());
        }
    }
    values
        .into_iter()
        .map(|value| normalize_workflow_token(&value))
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_workflow_token(value: &str) -> String {
    let token = value
        .trim_matches(|c: char| !matches!(c, 'a'..='z' | '0'..='9' | '_'))
        .to_owned();
    match token.as_str() {
        "" => String::new(),
        "knownhosts" | "userknownhostsfile" => "known_hosts".to_owned(),
        _ => token,
    }
}

fn is_distinctive_token(token: &&String) -> bool {
    let generic = [
        "and",
        "ask",
        "asks",
        "before",
        "binding",
        "bindings",
        "capsule",
        "check",
        "checked",
        "command",
        "commands",
        "config",
        "configuration",
        "current",
        "file",
        "files",
        "future",
        "local",
        "method",
        "next",
        "path",
        "probe",
        "prompt",
        "resolve",
        "resolved",
        "reusable",
        "route",
        "run",
        "runner",
        "runs",
        "session",
        "source",
        "sources",
        "step",
        "steps",
        "target",
        "targets",
        "test",
        "testing",
        "use",
        "used",
        "user",
        "value",
        "values",
        "verify",
        "verified",
        "workflow",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    !generic.contains(token.as_str())
        && !Regex::new(r"^\d+$").unwrap().is_match(token)
        && (token.len() >= 4 || token.as_str() == "ssh")
}

fn latest_timestamp(left: &str, right: &str) -> String {
    let left_ms = DateTime::parse_from_rfc3339(left)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    let right_ms = DateTime::parse_from_rfc3339(right)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    if right_ms > left_ms {
        right.to_owned()
    } else {
        left.to_owned()
    }
}

fn parse_limit(args: &[String]) -> Result<usize> {
    if let Some(index) = args.iter().position(|arg| arg == "--limit") {
        let value = args
            .get(index + 1)
            .ok_or_else(|| anyhow!("Usage: arc events [--json] [--limit N]"))?;
        let number = value
            .parse::<usize>()
            .map_err(|_| anyhow!("Usage: arc events [--json] [--limit N]"))?;
        if number == 0 {
            return Err(anyhow!("Usage: arc events [--json] [--limit N]"));
        }
        Ok(number.min(2000))
    } else {
        Ok(200)
    }
}

fn strip_limit(args: &[String]) -> Vec<String> {
    if let Some(index) = args.iter().position(|arg| arg == "--limit") {
        args.iter()
            .enumerate()
            .filter(|(i, _)| *i != index && *i != index + 1)
            .map(|(_, arg)| arg.clone())
            .collect()
    } else {
        args.to_vec()
    }
}

fn has_json(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--json")
}

fn strip_flag(args: &[String], flag: &str) -> Vec<String> {
    args.iter()
        .filter(|arg| arg.as_str() != flag)
        .cloned()
        .collect()
}

fn assert_known_flags(args: &[String], known: &[&str]) -> Result<()> {
    let known = known.iter().copied().collect::<HashSet<_>>();
    for arg in args {
        let name = arg.split_once('=').map(|(left, _)| left).unwrap_or(arg);
        if arg.starts_with('-') && !known.contains(name) {
            return Err(anyhow!("Unknown option: {name}"));
        }
    }
    Ok(())
}

fn option_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1).map(String::as_str))
}

fn embedding_threshold() -> f64 {
    clamp(
        env_number("AGENT_RUN_CACHE_EMBEDDING_MATCH_THRESHOLD", 0.58),
        -1.0,
        1.0,
    )
}

fn embedding_shortlist_limit() -> usize {
    env_number("AGENT_RUN_CACHE_EMBEDDING_SHORTLIST", 8.0)
        .max(1.0)
        .floor() as usize
}

fn embedding_timeout_ms() -> u64 {
    env_number("AGENT_RUN_CACHE_EMBEDDING_TIMEOUT_MS", 15_000.0).max(1.0) as u64
}

fn judge_confidence(confidence: Option<f64>) -> f64 {
    confidence
        .map(|value| clamp(value, 0.0, 1.0))
        .unwrap_or(0.5)
}

fn summarize_sidecar_failure(message: &str) -> String {
    if message.to_lowercase().contains("quota") {
        "sidecar quota exceeded; using local matching only".to_owned()
    } else {
        "sidecar unavailable; using local matching only".to_owned()
    }
}

fn hash_prompt(prompt: &str) -> String {
    sha256_hex(&prompt.trim().to_lowercase())[..24].to_owned()
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn hash24(value: &str) -> String {
    sha256_hex(value)[..24].to_owned()
}

fn normalize_git_remote(value: &str) -> String {
    let replaced = Regex::new(r"^git@([^:]+):")
        .unwrap()
        .replace(value, "https://$1/")
        .to_string();
    replaced.trim_end_matches(".git").to_lowercase()
}

fn safe_name(value: &str) -> String {
    let name = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '_'
            }
        })
        .take(180)
        .collect::<String>();
    if name.is_empty() {
        "unknown".to_owned()
    } else {
        name
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.max(min).min(max)
    } else {
        min
    }
}

fn env_number(name: &str, fallback: f64) -> f64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn pause_until(value: &str) -> Result<DateTime<Utc>> {
    let spec = value.trim().to_lowercase();
    if spec == "today" {
        let now = Local::now();
        let tomorrow = now
            .date_naive()
            .succ_opt()
            .ok_or_else(|| anyhow!("Could not resolve tomorrow for pause duration"))?;
        let local_midnight = Local
            .with_ymd_and_hms(tomorrow.year(), tomorrow.month(), tomorrow.day(), 0, 0, 0)
            .single()
            .unwrap_or_else(|| now + chrono::Duration::hours(24));
        return Ok(local_midnight.with_timezone(&Utc));
    }
    let (number, unit) = spec.split_at(
        spec.find(|ch: char| !ch.is_ascii_digit())
            .unwrap_or(spec.len()),
    );
    let amount = number
        .parse::<u64>()
        .map_err(|_| anyhow!("Pause duration must be 1h, 2h, today, or off"))?;
    let seconds = match unit {
        "m" | "min" | "mins" | "minute" | "minutes" => amount.saturating_mul(60),
        "h" | "hr" | "hrs" | "hour" | "hours" | "" => amount.saturating_mul(60 * 60),
        _ => return Err(anyhow!("Pause duration must be 1h, 2h, today, or off")),
    };
    if seconds == 0 {
        return Err(anyhow!("Pause duration must be greater than zero"));
    }
    Ok(DateTime::<Utc>::from(
        SystemTime::now() + Duration::from_secs(seconds),
    ))
}

fn injection_pause_status(config: &ArcConfig) -> InjectionPauseStatus {
    let Some(raw) = config.injection_paused_until.as_deref() else {
        return InjectionPauseStatus {
            paused: false,
            paused_until: None,
            seconds_remaining: None,
            label: "injection active".to_owned(),
        };
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(raw) else {
        return InjectionPauseStatus {
            paused: false,
            paused_until: Some(raw.to_owned()),
            seconds_remaining: None,
            label: "injection active".to_owned(),
        };
    };
    let until = parsed.with_timezone(&Utc);
    let seconds = until.signed_duration_since(Utc::now()).num_seconds();
    if seconds <= 0 {
        return InjectionPauseStatus {
            paused: false,
            paused_until: Some(until.to_rfc3339_opts(SecondsFormat::Millis, true)),
            seconds_remaining: Some(0),
            label: "injection active".to_owned(),
        };
    }
    let minutes = ((seconds + 59) / 60).max(1);
    InjectionPauseStatus {
        paused: true,
        paused_until: Some(until.to_rfc3339_opts(SecondsFormat::Millis, true)),
        seconds_remaining: Some(seconds),
        label: format!("injection paused ({minutes}m left)"),
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn generated_id() -> String {
    format!("{}-{}", base36(now_millis()), random_suffix())
}

fn random_suffix() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect::<String>()
        .to_lowercase()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut chars = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        chars.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
        value /= 36;
    }
    chars.iter().rev().collect()
}

fn short(value: &str, len: usize) -> String {
    value.chars().take(len).collect()
}

fn truncate(value: &str, len: usize) -> String {
    value.chars().take(len).collect()
}

fn current_exe_string() -> String {
    env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("arc"))
        .to_string_lossy()
        .to_string()
}

fn command_exists(name: &str) -> bool {
    env::var_os("PATH")
        .is_some_and(|paths| env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
}

fn shell_words<'a>(values: impl Iterator<Item = &'a str>) -> String {
    values.map(shell_quote).collect::<Vec<_>>().join(" ")
}

fn shell_quote(value: &str) -> String {
    if Regex::new(r"^[A-Za-z0-9_./:=+@%-]+$")
        .unwrap()
        .is_match(value)
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
