#![recursion_limit = "256"]

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;

static TS_BUILD: OnceLock<()> = OnceLock::new();

#[test]
fn rust_matches_ts_for_seeded_json_commands() {
    ensure_ts_build();
    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    seed_capsule_with_ts(&workspace);

    let ts_status = run_ts_json(&["status", "--json"], &workspace, None);
    let rust_status = run_rust_json(&["status", "--json"], &workspace, None);
    assert_eq!(rust_status["workspace"], ts_status["workspace"]);
    assert_eq!(rust_status["cacheDir"], ts_status["cacheDir"]);
    assert_eq!(rust_status["memoryPath"], ts_status["memoryPath"]);
    assert_eq!(
        rust_status["memoryEventsPath"],
        ts_status["memoryEventsPath"]
    );
    assert_eq!(rust_status["capsuleCount"], ts_status["capsuleCount"]);
    assert_eq!(rust_status["eventCount"], ts_status["eventCount"]);
    assert_eq!(rust_status["judge"]["mode"], ts_status["judge"]["mode"]);

    let ts_capsules = run_ts_json(&["capsules", "--json"], &workspace, None);
    let rust_capsules = run_rust_json(&["capsules", "--json"], &workspace, None);
    let ts_capsule = &ts_capsules["capsules"][0];
    let rust_capsule = &rust_capsules["capsules"][0];
    assert_eq!(rust_capsule["id"], ts_capsule["id"]);
    assert_eq!(rust_capsule["title"], ts_capsule["title"]);
    assert_eq!(rust_capsule["summary"], ts_capsule["summary"]);
    assert_eq!(
        rust_capsule["workflow"]["commands"],
        ts_capsule["workflow"]["commands"]
    );
    assert_eq!(rust_capsule["reuseWhen"], ts_capsule["reuseWhen"]);

    let ts_events = run_ts_json(&["events", "--json"], &workspace, None);
    let rust_events = run_rust_json(&["events", "--json"], &workspace, None);
    assert_eq!(rust_events["total"], ts_events["total"]);
    assert_eq!(
        rust_events["events"][0]["type"],
        ts_events["events"][0]["type"]
    );
}

#[test]
fn rust_probe_and_hook_match_ts_recall_contract() {
    ensure_ts_build();
    let seed = tempfile::tempdir().unwrap();
    let seed = seed.path().canonicalize().unwrap();
    seed_capsule_with_ts(&seed);

    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();
    copy_cache(&seed, &ts_workspace);
    copy_cache(&seed, &rust_workspace);

    let ts_probe = run_ts_json(
        &["probe", "checking", "CLI", "JSON", "output", "--json"],
        &ts_workspace,
        None,
    );
    let rust_probe = run_rust_json(
        &["probe", "checking", "CLI", "JSON", "output", "--json"],
        &rust_workspace,
        None,
    );
    assert_eq!(rust_probe["shouldInject"], ts_probe["shouldInject"]);
    assert_eq!(rust_probe["source"], ts_probe["source"]);
    assert_eq!(rust_probe["capsule"]["id"], ts_probe["capsule"]["id"]);
    assert_eq!(rust_probe["capsule"]["title"], ts_probe["capsule"]["title"]);
    assert_eq!(rust_probe["reason"], ts_probe["reason"]);
    assert_eq!(rust_probe["message"], ts_probe["message"]);

    let hook_input = serde_json::json!({
        "sessionId": "rust-parity-hook",
        "cwd": rust_workspace,
        "prompt": "checking CLI JSON output"
    });
    let rust_hook = run_rust_json_with_env(
        &["hook", "copilot", "UserPromptSubmit"],
        &rust_workspace,
        Some(&hook_input.to_string()),
        &[("AGENT_RUN_CACHE_COPILOT_PLUGIN", "1")],
    );
    assert!(rust_hook["additionalContext"]
        .as_str()
        .unwrap()
        .contains("Inspect CLI JSON output"));
    assert!(rust_hook["modifiedPrompt"]
        .as_str()
        .unwrap()
        .contains("User task:\nchecking CLI JSON output"));
}

#[test]
fn rust_embedding_gate_matches_ts_with_shared_endpoint() {
    ensure_ts_build();
    let endpoint = start_embedding_endpoint();
    let seed = tempfile::tempdir().unwrap();
    let seed = seed.path().canonicalize().unwrap();
    seed_capsule_with_ts(&seed);

    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();
    copy_cache(&seed, &ts_workspace);
    copy_cache(&seed, &rust_workspace);

    let env = [("AGENT_RUN_CACHE_EMBEDDING_ENDPOINT", endpoint.as_str())];
    let ts_probe = serde_json::from_str::<Value>(&run_ts_raw(
        &["probe", "checking", "CLI", "JSON", "output", "--json"],
        &ts_workspace,
        None,
        &env,
    ))
    .unwrap();
    let rust_probe = run_rust_json_with_env(
        &["probe", "checking", "CLI", "JSON", "output", "--json"],
        &rust_workspace,
        None,
        &env,
    );
    assert_eq!(rust_probe["shouldInject"], ts_probe["shouldInject"]);
    assert_eq!(rust_probe["source"], "local");
    assert_eq!(
        rust_probe["reason"],
        "embedding matched capsule cli-json-capsule at 1.000"
    );
    assert_eq!(rust_probe["reason"], ts_probe["reason"]);
    assert_eq!(rust_probe["capsule"]["id"], ts_probe["capsule"]["id"]);
}

#[test]
fn rust_managed_embedder_starts_without_endpoint_override() {
    ensure_ts_build();
    let seed = tempfile::tempdir().unwrap();
    let seed = seed.path().canonicalize().unwrap();
    seed_capsule_with_ts(&seed);

    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    copy_cache(&seed, &workspace);

    let runtime_dir = workspace.join("runtime");
    let models_dir = workspace.join("models");
    install_fake_llama_server(&runtime_dir);
    fs::create_dir_all(&models_dir).unwrap();
    fs::write(
        models_dir.join("nomic-embed-text-v1.5.f16.gguf"),
        "fake model",
    )
    .unwrap();

    let env = [
        ("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS", "on"),
        ("AGENT_RUN_CACHE_RUNTIME_DIR", runtime_dir.to_str().unwrap()),
        ("AGENT_RUN_CACHE_MODELS_DIR", models_dir.to_str().unwrap()),
        ("AGENT_RUN_CACHE_LLAMA_RELEASE", "fake"),
    ];
    let probe = run_rust_json_with_env(
        &["probe", "checking", "CLI", "JSON", "output", "--json"],
        &workspace,
        None,
        &env,
    );
    assert_eq!(probe["shouldInject"], true);
    assert_eq!(
        probe["reason"],
        "embedding matched capsule cli-json-capsule at 1.000"
    );
    assert_eq!(probe["capsule"]["id"], "cli-json-capsule");
    let debug = fs::read_to_string(workspace.join(".agent-run-cache/debug/runtime.jsonl")).unwrap();
    assert!(debug.contains("local_embeddings.started"));
}

#[test]
fn rust_mcp_and_provider_judge_match_stable_ts_shapes() {
    ensure_ts_build();
    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    seed_capsule_with_ts(&workspace);

    let mcp_input = [
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05" } }),
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        serde_json::json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "arc_search", "arguments": { "query": "checking CLI JSON output", "limit": 3 } } }),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    let rust_mcp = run_rust_raw(&["mcp"], &workspace, Some(&mcp_input), &[]);
    let responses = rust_mcp
        .trim()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "arc");
    assert!(responses[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "arc_search"));
    assert!(responses[2]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Inspect CLI JSON output"));

    let consult = workspace.join("judge-consult.cjs");
    fs::write(
        &consult,
        r#"
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ applies: false, confidence: 0.91, reason: "judge abstained for regression test" }));
});
"#,
    )
    .unwrap();
    let _ = run_rust_json(
        &[
            "judge",
            "set",
            "--json",
            "--mode",
            "provider-judge",
            "--model",
            "ollama:gemma4:31b-cloud",
        ],
        &workspace,
        None,
    );
    let command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        consult.display()
    );
    let plan = run_rust_json_with_env(
        &["consult", "checking", "CLI", "JSON", "output"],
        &workspace,
        None,
        &[("AGENT_RUN_CACHE_CONSULT_COMMAND", &command)],
    );
    assert_eq!(plan["shouldInject"], false);
    assert_eq!(plan["source"], "sidecar");
    assert!(plan["reason"].as_str().unwrap().contains("judge abstained"));

    let decisions = run_rust_json(&["judge", "decisions", "--json"], &workspace, None);
    assert_eq!(decisions["total"], 1);
    assert_eq!(decisions["decisions"][0]["mode"], "provider-judge");
    assert_eq!(decisions["decisions"][0]["model"]["provider"], "ollama");
    assert_eq!(decisions["decisions"][0]["verdict"]["abstain"], true);
    assert_eq!(
        decisions["decisions"][0]["candidates"][0]["capsuleId"],
        "cli-json-capsule"
    );

    let capsule = run_rust_json(
        &["capsules", "cli-json-capsule", "--json"],
        &workspace,
        None,
    );
    assert_eq!(capsule["capsule"]["confidence"], 0.9);
}

#[test]
fn rust_import_copilot_creates_same_capsule_as_ts_with_command_reviewer() {
    ensure_ts_build();
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("capture-events.jsonl");
    write_capture_trace(&trace);
    let reviewer = root.path().join("reviewer.cjs");
    write_reviewer_command(&reviewer);
    let reviewer_command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        reviewer.display()
    );

    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();

    let env = [(
        "AGENT_RUN_CACHE_REVIEWER_COMMAND",
        reviewer_command.as_str(),
    )];
    let ts_output = run_ts_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &ts_workspace,
        None,
        &env,
    );
    assert!(ts_output.contains("imported and reviewed 5 events"));
    let rust_output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &rust_workspace,
        None,
        &env,
    );
    assert!(rust_output.contains("imported and reviewed 5 events"));

    let ts_capsules = run_ts_json(&["capsules", "--json"], &ts_workspace, None);
    let rust_capsules = run_rust_json(&["capsules", "--json"], &rust_workspace, None);
    let ts_capsule = &ts_capsules["capsules"][0];
    let rust_capsule = &rust_capsules["capsules"][0];
    assert_eq!(rust_capsule["id"], ts_capsule["id"]);
    assert_eq!(
        rust_capsule["sourceSessionId"],
        ts_capsule["sourceSessionId"]
    );
    assert_eq!(
        rust_capsule["sourceSessionIds"],
        ts_capsule["sourceSessionIds"]
    );
    assert_eq!(rust_capsule["title"], ts_capsule["title"]);
    assert_eq!(rust_capsule["mergeKey"], ts_capsule["mergeKey"]);
    assert_eq!(rust_capsule["outcomeStatus"], ts_capsule["outcomeStatus"]);
    assert_eq!(
        rust_capsule["workflow"]["commands"],
        ts_capsule["workflow"]["commands"]
    );
    assert_eq!(
        rust_capsule["workflow"]["validationProbe"],
        ts_capsule["workflow"]["validationProbe"]
    );

    let ts_reviewed = read_reviewed(&ts_workspace);
    let rust_reviewed = read_reviewed(&rust_workspace);
    assert_eq!(rust_reviewed["sessionId"], ts_reviewed["sessionId"]);
    assert_eq!(rust_reviewed["status"], ts_reviewed["status"]);
    assert_eq!(rust_reviewed["capsuleId"], ts_reviewed["capsuleId"]);
    assert_eq!(rust_reviewed["eventCount"], ts_reviewed["eventCount"]);

    let ts_events = run_ts_json(&["events", "--json"], &ts_workspace, None);
    let rust_events = run_rust_json(&["events", "--json"], &rust_workspace, None);
    let ts_types = ts_events["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["type"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let rust_types = rust_events["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["type"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(rust_types, ts_types);
}

#[test]
fn rust_import_otel_creates_same_events_and_capsule_as_ts_with_command_reviewer() {
    ensure_ts_build();
    let root = tempfile::tempdir().unwrap();
    let otel = root.path().join("capture-otel.jsonl");
    write_otel_trace(&otel);
    let reviewer = root.path().join("reviewer.cjs");
    write_reviewer_command(&reviewer);
    let reviewer_command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        reviewer.display()
    );

    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();
    let env = [(
        "AGENT_RUN_CACHE_REVIEWER_COMMAND",
        reviewer_command.as_str(),
    )];

    let ts_output = run_ts_raw(
        &["import-otel", otel.to_str().unwrap(), "fallback-otel"],
        &ts_workspace,
        None,
        &env,
    );
    let rust_output = run_rust_raw(
        &["import-otel", otel.to_str().unwrap(), "fallback-otel"],
        &rust_workspace,
        None,
        &env,
    );
    assert!(ts_output.contains("imported and reviewed 4 OTel-derived events"));
    assert!(rust_output.contains("imported and reviewed 4 OTel-derived events"));

    let ts_trace = read_trace_summary(&ts_workspace, "otel-parity-session");
    let rust_trace = read_trace_summary(&rust_workspace, "otel-parity-session");
    assert_eq!(rust_trace, ts_trace);

    let ts_capsules = run_ts_json(&["capsules", "--json"], &ts_workspace, None);
    let rust_capsules = run_rust_json(&["capsules", "--json"], &rust_workspace, None);
    assert_eq!(
        rust_capsules["capsules"][0]["id"],
        ts_capsules["capsules"][0]["id"]
    );
    assert_eq!(
        rust_capsules["capsules"][0]["sourceSessionId"],
        ts_capsules["capsules"][0]["sourceSessionId"]
    );
    assert_eq!(
        rust_capsules["capsules"][0]["outcomeStatus"],
        ts_capsules["capsules"][0]["outcomeStatus"]
    );

    let ts_reviewed = read_reviewed(&ts_workspace);
    let rust_reviewed = read_reviewed(&rust_workspace);
    assert_eq!(rust_reviewed["sessionId"], ts_reviewed["sessionId"]);
    assert_eq!(rust_reviewed["status"], "saved");
    assert_eq!(rust_reviewed["eventCount"], 4);
}

#[test]
fn rust_review_model_sidecar_runs_opencode_prompt_without_reviewer_command() {
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("capture-events.jsonl");
    write_capture_trace(&trace);

    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    let prompt_capture = workspace.join("captured-review-prompt.txt");
    let fake = install_fake_opencode_review_sidecar(&workspace, &prompt_capture);
    let env = [
        ("AGENT_RUN_CACHE_MODEL_SIDECAR", "opencode"),
        ("AGENT_RUN_CACHE_OPENCODE_BIN", fake.to_str().unwrap()),
    ];
    let output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &workspace,
        None,
        &env,
    );
    assert!(output.contains("imported and reviewed 5 events"));

    let prompt = fs::read_to_string(&prompt_capture).unwrap();
    assert!(prompt.contains("You are the Agent Run Cache sidecar."));
    assert!(prompt.contains("ARC's local loop assembled this draft"));
    assert!(prompt.contains("Assembled draft:"));
    assert!(prompt.contains(
        "cargo test rust_import_copilot_creates_same_capsule_as_ts_with_command_reviewer"
    ));

    let capsules = run_rust_json(&["capsules", "--json"], &workspace, None);
    assert_eq!(capsules["capsules"][0]["id"], "model-sidecar-capsule");
    assert_eq!(
        capsules["capsules"][0]["sourceSessionId"],
        "capture-parity-session"
    );
    let reviewed = read_reviewed(&workspace);
    assert_eq!(reviewed["status"], "saved");
    assert_eq!(reviewed["capsuleId"], "model-sidecar-capsule");
    let sidecar =
        fs::read_to_string(workspace.join(".agent-run-cache/debug/sidecar.jsonl")).unwrap();
    assert!(sidecar.contains("\"kind\":\"review\""));
    assert!(sidecar.contains("\"source\":\"opencode\""));
    let debug = fs::read_to_string(workspace.join(".agent-run-cache/debug/runtime.jsonl")).unwrap();
    assert!(debug.contains("sidecar.review.opencode"));
}

#[test]
fn rust_copilot_model_sidecar_extracts_assistant_content_from_jsonl() {
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("capture-events.jsonl");
    write_capture_trace(&trace);

    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    let args_capture = workspace.join("captured-copilot-sidecar-args.txt");
    let fake = install_fake_copilot_jsonl_review_sidecar(&workspace, &args_capture);
    let env = [
        ("AGENT_RUN_CACHE_MODEL_SIDECAR", "copilot"),
        (
            "AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND",
            fake.to_str().unwrap(),
        ),
    ];
    let output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &workspace,
        None,
        &env,
    );
    assert!(output.contains("imported and reviewed 5 events"));

    let args = fs::read_to_string(&args_capture).unwrap();
    assert!(args.contains("--output-format"));
    assert!(args.contains("\njson\n"));
    assert!(!args.contains("--silent"));

    let capsules = run_rust_json(&["capsules", "--json"], &workspace, None);
    assert_eq!(
        capsules["capsules"][0]["id"],
        "copilot-jsonl-sidecar-capsule"
    );
    let reviewed = read_reviewed(&workspace);
    assert_eq!(reviewed["status"], "saved");
    assert_eq!(reviewed["capsuleId"], "copilot-jsonl-sidecar-capsule");
    let sidecar =
        fs::read_to_string(workspace.join(".agent-run-cache/debug/sidecar.jsonl")).unwrap();
    assert!(sidecar.contains("\"kind\":\"review\""));
    assert!(sidecar.contains("\"source\":\"copilot\""));
}

#[test]
fn rust_local_observer_declines_tiny_auto_review_before_reviewer_command() {
    ensure_ts_build();
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("tiny-events.jsonl");
    write_tiny_review_trace(&trace);
    let reviewer = root.path().join("marker-reviewer.cjs");
    write_marker_reviewer_command(&reviewer);
    let reviewer_command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        reviewer.display()
    );

    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let ts_marker = ts_workspace.join("reviewer-called");
    let ts_env = [
        (
            "AGENT_RUN_CACHE_REVIEWER_COMMAND",
            reviewer_command.as_str(),
        ),
        ("AGENT_RUN_CACHE_LOCAL_OBSERVER", "auto"),
        ("REVIEWER_CALLED_PATH", ts_marker.to_str().unwrap()),
    ];
    let ts_output = run_ts_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &ts_workspace,
        None,
        &ts_env,
    );
    assert!(ts_output.contains("imported and reviewed"));
    assert!(!ts_marker.exists(), "TS reviewer command should be gated");

    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();
    let rust_marker = rust_workspace.join("reviewer-called");
    let rust_env = [
        (
            "AGENT_RUN_CACHE_REVIEWER_COMMAND",
            reviewer_command.as_str(),
        ),
        ("AGENT_RUN_CACHE_LOCAL_OBSERVER", "auto"),
        ("REVIEWER_CALLED_PATH", rust_marker.to_str().unwrap()),
    ];
    let rust_output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &rust_workspace,
        None,
        &rust_env,
    );
    assert!(rust_output.contains("imported and reviewed"));
    assert!(
        !rust_marker.exists(),
        "Rust reviewer command should be gated"
    );

    let ts_reviewed = read_reviewed(&ts_workspace);
    let rust_reviewed = read_reviewed(&rust_workspace);
    assert_eq!(rust_reviewed["status"], ts_reviewed["status"]);
    assert_eq!(rust_reviewed["reason"], ts_reviewed["reason"]);
    assert_eq!(rust_reviewed["eventCount"], ts_reviewed["eventCount"]);
    assert_eq!(rust_reviewed["status"], "no_capsule");
    assert_eq!(rust_reviewed["reason"], "tiny turn without tool evidence");

    let rust_capsules = run_rust_json(&["capsules", "--json"], &rust_workspace, None);
    assert_eq!(rust_capsules["capsules"].as_array().unwrap().len(), 0);
    let debug =
        fs::read_to_string(rust_workspace.join(".agent-run-cache/debug/runtime.jsonl")).unwrap();
    assert!(debug.contains("\"action\":\"local_observer.decision\""));
    assert!(debug.contains("\"action\":\"local_observer.review_declined\""));
}

#[test]
fn rust_full_packet_review_prompt_includes_existing_capsule_candidates() {
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("capture-events.jsonl");
    write_capture_trace(&trace);

    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    seed_review_candidate_capsule(&workspace);
    let prompt_capture = workspace.join("captured-full-review-prompt.txt");
    let fake = install_fake_opencode_review_sidecar(&workspace, &prompt_capture);
    let env = [
        ("AGENT_RUN_CACHE_MODEL_SIDECAR", "opencode"),
        ("AGENT_RUN_CACHE_OPENCODE_BIN", fake.to_str().unwrap()),
        ("AGENT_RUN_CACHE_REVIEW_FULL_PACKET", "1"),
    ];
    let output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &workspace,
        None,
        &env,
    );
    assert!(output.contains("imported and reviewed 5 events"));

    let prompt = fs::read_to_string(&prompt_capture).unwrap();
    assert!(prompt.contains(
        "Your job is to decide whether a completed coding-agent session produced one or more reusable workflow capsules."
    ));
    assert!(prompt.contains("Existing capsule candidates from this workspace:"));
    assert!(prompt.contains("existing-capture-candidate"));
    assert!(prompt.contains("Candidate rules:"));
    assert!(prompt.contains("Evidence packet:"));
    assert!(prompt.contains("\"episodes\""));
    assert!(!prompt.contains("ARC's local loop assembled this draft"));
}

#[test]
fn rust_review_blocks_correction_workflow_like_ts() {
    ensure_ts_build();
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("correction-events.jsonl");
    write_correction_trace(&trace);
    let reviewer = root.path().join("correction-reviewer.cjs");
    write_correction_workflow_reviewer_command(&reviewer);
    let reviewer_command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        reviewer.display()
    );

    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();
    let env = [(
        "AGENT_RUN_CACHE_REVIEWER_COMMAND",
        reviewer_command.as_str(),
    )];

    let ts_output = run_ts_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &ts_workspace,
        None,
        &env,
    );
    let rust_output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &rust_workspace,
        None,
        &env,
    );
    assert!(ts_output.contains("imported and reviewed"));
    assert!(rust_output.contains("imported and reviewed"));

    let ts_reviewed = read_reviewed(&ts_workspace);
    let rust_reviewed = read_reviewed(&rust_workspace);
    assert_eq!(rust_reviewed["status"], ts_reviewed["status"]);
    assert_eq!(rust_reviewed["reason"], ts_reviewed["reason"]);
    assert_eq!(rust_reviewed["status"], "no_capsule");
    assert_eq!(
        rust_reviewed["reason"],
        "correction signal requires caution or project-fact capture"
    );

    let rust_capsules = run_rust_json(&["capsules", "--json"], &rust_workspace, None);
    assert_eq!(rust_capsules["capsules"].as_array().unwrap().len(), 0);
    let rust_events = run_rust_json(&["events", "--json"], &rust_workspace, None);
    let rejected = rust_events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "capsule.rejected")
        .unwrap();
    assert_eq!(rejected["details"]["correctionSignal"], true);
}

#[test]
fn rust_review_uses_session_action_risk_context_like_ts_options() {
    ensure_ts_build();
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("action-risk-events.jsonl");
    write_action_risk_trace(&trace);
    let reviewer = root.path().join("live-action-reviewer.cjs");
    let ts_capture = root.path().join("ts-review-input.json");
    write_live_action_reviewer_command(&reviewer, &ts_capture);
    let reviewer_command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        reviewer.display()
    );

    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let ts_reviewed =
        run_ts_review_with_action_risk_options(&trace, &ts_workspace, &reviewer_command);

    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();
    seed_action_risk_injection_event(&rust_workspace, "action-risk-review-session");
    let rust_capture = rust_workspace.join("rust-review-input.json");
    write_live_action_reviewer_command(&reviewer, &rust_capture);
    let rust_output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &rust_workspace,
        None,
        &[(
            "AGENT_RUN_CACHE_REVIEWER_COMMAND",
            reviewer_command.as_str(),
        )],
    );
    assert!(rust_output.contains("imported and reviewed"));

    let rust_reviewed = read_reviewed(&rust_workspace);
    assert_eq!(rust_reviewed["status"], ts_reviewed["status"]);
    assert_eq!(rust_reviewed["reason"], ts_reviewed["reason"]);
    assert_eq!(rust_reviewed["status"], "no_capsule");
    assert_eq!(
        rust_reviewed["reason"],
        "action-risk consult abstention blocked broad action capsule"
    );

    let rust_capsules = run_rust_json(&["capsules", "--json"], &rust_workspace, None);
    assert_eq!(rust_capsules["capsules"].as_array().unwrap().len(), 0);
    let input = fs::read_to_string(&rust_capture).unwrap();
    assert!(input.contains("\"reviewContext\""));
    assert!(input.contains("prompt is pasted diagnostic output without live-action intent"));
}

#[test]
fn rust_review_reconciles_provider_judge_outcome_after_save() {
    let root = tempfile::tempdir().unwrap();
    let trace = root.path().join("capture-events.jsonl");
    write_capture_trace(&trace);
    let reviewer = root.path().join("reviewer.cjs");
    write_reviewer_command(&reviewer);
    let reviewer_command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        reviewer.display()
    );

    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    seed_provider_judge_context(&workspace, "capture-parity-session");
    let output = run_rust_raw(
        &["import-copilot", trace.to_str().unwrap()],
        &workspace,
        None,
        &[(
            "AGENT_RUN_CACHE_REVIEWER_COMMAND",
            reviewer_command.as_str(),
        )],
    );
    assert!(output.contains("imported and reviewed 5 events"));

    let decisions = run_rust_json(&["judge", "decisions", "--json"], &workspace, None);
    let decision = decisions["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|decision| decision["id"] == "judge-outcome-seed")
        .unwrap();
    assert_eq!(decision["outcome"]["injected"], true);
    assert_eq!(decision["outcome"]["used"], "yes");
    assert_eq!(decision["outcome"]["helped"], "yes");
    assert_eq!(decision["outcomeReason"], "saved");

    let reputation = fs::read_to_string(
        workspace
            .join(".agent-run-cache")
            .join("retrieval-reputation.json"),
    )
    .unwrap();
    assert!(reputation.contains("\"capture-parity-capsule\""));
    assert!(reputation.contains("\"helped\": 1"));
    let debug = fs::read_to_string(workspace.join(".agent-run-cache/debug/runtime.jsonl")).unwrap();
    assert!(debug.contains("judge.outcome_reconciled"));
}

#[test]
fn rust_session_end_hook_harvests_transcript_and_reviews_capsule() {
    ensure_ts_build();
    let root = tempfile::tempdir().unwrap();
    let state_dir = root.path().join("copilot-state");
    let session_dir = state_dir.join("capture-parity-session");
    fs::create_dir_all(&session_dir).unwrap();
    write_capture_trace(&session_dir.join("events.jsonl"));
    let reviewer = root.path().join("reviewer.cjs");
    write_reviewer_command(&reviewer);
    let reviewer_command = format!(
        "{} {}",
        std::env::var("NODE").unwrap_or_else(|_| "node".to_owned()),
        reviewer.display()
    );

    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    let hook_input = serde_json::json!({
        "input": {
            "cwd": workspace,
            "sessionId": "capture-parity-session"
        }
    });
    let env = [
        ("AGENT_RUN_CACHE_COPILOT_PLUGIN", "1"),
        (
            "AGENT_RUN_CACHE_COPILOT_STATE_DIR",
            state_dir.to_str().unwrap(),
        ),
        (
            "AGENT_RUN_CACHE_REVIEWER_COMMAND",
            reviewer_command.as_str(),
        ),
    ];
    let result = run_rust_json_with_env(
        &["hook", "copilot", "SessionEnd"],
        &workspace,
        Some(&hook_input.to_string()),
        &env,
    );
    assert_eq!(result, serde_json::json!({}));

    let capsules = run_rust_json(&["capsules", "--json"], &workspace, None);
    assert_eq!(capsules["capsules"][0]["id"], "capture-parity-capsule");
    let reviewed = read_reviewed(&workspace);
    assert_eq!(reviewed["status"], "saved");
    let debug = fs::read_to_string(workspace.join(".agent-run-cache/debug/runtime.jsonl")).unwrap();
    assert!(debug.contains("\"hook.session_end\""));
    assert!(debug.contains("\"harvested\":true"));
}

#[test]
fn rust_ports_logs_debug_bundle_smoke_and_reset_commands() {
    ensure_ts_build();
    let ts_workspace = tempfile::tempdir().unwrap();
    let ts_workspace = ts_workspace.path().canonicalize().unwrap();
    let rust_workspace = tempfile::tempdir().unwrap();
    let rust_workspace = rust_workspace.path().canonicalize().unwrap();
    seed_debug_cache(&ts_workspace);
    seed_debug_cache(&rust_workspace);

    let ts_logs = run_ts_raw(&["logs"], &ts_workspace, None, &[]);
    let rust_logs = run_rust_raw(&["logs"], &rust_workspace, None, &[]);
    assert_eq!(rust_logs, ts_logs);
    assert!(rust_logs.contains("[12:34:56] capsule.saved"));
    assert!(rust_logs.contains("\"sessionId\":\"debug-session\""));
    assert!(rust_logs.contains("\"reason\":\"because\""));

    let ts_bundle = ts_workspace.join("ts-bundle");
    let rust_bundle = rust_workspace.join("rust-bundle");
    let ts_output = run_ts_raw(
        &["debug-bundle", ts_bundle.to_str().unwrap()],
        &ts_workspace,
        None,
        &[],
    );
    let rust_output = run_rust_raw(
        &["debug-bundle", rust_bundle.to_str().unwrap()],
        &rust_workspace,
        None,
        &[],
    );
    assert!(ts_output.contains("files: 8, traces: 1"));
    assert!(rust_output.contains("files: 8, traces: 1"));
    let rust_memory = fs::read_to_string(rust_bundle.join("memory.redacted.jsonl")).unwrap();
    assert!(rust_memory.contains("<token>"));
    assert!(rust_memory.contains("<url>"));
    assert!(!rust_memory.contains("ghp_abcdefghijklmnopqrstuvwxyz"));
    assert!(!rust_memory.contains("https://example.com/private"));
    assert!(rust_bundle
        .join("traces/arc-debug-session.redacted.jsonl")
        .exists());
    assert!(rust_bundle
        .join("copilot-log-summary.redacted.jsonl")
        .exists());
    let manifest = fs::read_to_string(rust_bundle.join("manifest.json")).unwrap();
    assert!(manifest.contains("\"traceCount\": 1"));
    assert!(manifest.contains("\"fileCount\": 7"));

    let smoke_workspace = tempfile::tempdir().unwrap();
    let smoke_workspace = smoke_workspace.path().canonicalize().unwrap();
    let smoke = run_rust_raw(&["smoke"], &smoke_workspace, None, &[]);
    assert!(smoke.contains("smoke: injection yes"));
    assert!(!smoke_workspace
        .join(".agent-run-cache/memory.jsonl")
        .exists());

    seed_debug_cache(&rust_workspace);
    let reset = run_rust_raw(&["reset", "--yes"], &rust_workspace, None, &[]);
    assert!(reset.contains("ARC reset complete"));
    assert!(reset.contains("removed workspace cache:"));
    assert!(!rust_workspace.join(".agent-run-cache").exists());
}

#[test]
fn rust_ask_runs_opencode_with_injected_context() {
    ensure_ts_build();
    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    seed_capsule_with_ts(&workspace);
    let fake = install_fake_opencode(&workspace);
    let output = run_rust_raw(
        &[
            "ask", "--runner", "opencode", "checking", "CLI", "JSON", "output",
        ],
        &workspace,
        None,
        &[("AGENT_RUN_CACHE_OPENCODE_BIN", fake.to_str().unwrap())],
    );
    assert!(output.contains("ARC: using capsule \"Inspect CLI JSON output\""));
    assert!(output.contains("FAKE_OPENCODE_CLIENT:arc"));
    assert!(output.contains("FAKE_OPENCODE_ARG:run"));
    assert!(output.contains("FAKE_OPENCODE_HAS_ARC:yes"));
    assert!(output.contains("FAKE_OPENCODE_HAS_USER_TASK:yes"));
    assert!(output.contains("ARC: runner opencode exit 0"));
    assert!(output.contains("ARC: injected capsule cli-json-capsule"));
    let debug = fs::read_to_string(workspace.join(".agent-run-cache/debug/runtime.jsonl")).unwrap();
    assert!(debug.contains("ask.runner.started"));
    assert!(debug.contains("ask.runner.completed"));
}

#[test]
fn rust_json_hooks_install_and_status_match_surface() {
    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().canonicalize().unwrap();
    let before = run_rust_json(&["json-hooks", "status", "--json"], &workspace, None);
    assert_eq!(before["hook"]["installed"], false);
    assert_eq!(before["hook"]["sessionStart"], false);

    let installed = run_rust_json(&["json-hooks", "install", "--json"], &workspace, None);
    assert_eq!(installed["hook"]["installed"], true);
    assert_eq!(installed["hook"]["activated"], true);
    assert_eq!(installed["hook"]["repoHookInstalled"], true);
    assert_eq!(installed["hook"]["userHookInstalled"], true);
    assert_eq!(installed["hook"]["sessionStart"], true);
    assert_eq!(installed["hook"]["userPromptSubmitted"], true);
    assert_eq!(installed["hook"]["sessionEnd"], true);

    let activation = fs::read_to_string(workspace.join(".agent-run-cache/enabled.json")).unwrap();
    assert!(activation.contains("\"integration\": \"json-hooks\""));
    let repo_hook =
        fs::read_to_string(workspace.join(".github/hooks/agent-run-cache.json")).unwrap();
    assert!(repo_hook.contains("hook copilot SessionStart"));
    assert!(repo_hook.contains("hook copilot UserPromptSubmit"));
    assert!(repo_hook.contains("hook copilot SessionEnd"));
    assert!(workspace
        .join("copilot-home/hooks/agent-run-cache.json")
        .exists());

    let text = run_rust_raw(&["json-hooks", "status"], &workspace, None, &[]);
    assert!(text.contains("json hooks: installed"));
    assert!(text.contains("hook path:"));
}

fn ensure_ts_build() {
    TS_BUILD.get_or_init(|| {
        let output = Command::new("npm")
            .args(["run", "build"])
            .current_dir(repo_root())
            .output()
            .expect("run npm build");
        assert!(
            output.status.success(),
            "npm build failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    });
}

fn seed_capsule_with_ts(workspace: &Path) {
    let script = r#"
import { saveCapsule } from "./dist/store.js";
const workspace = process.env.ARC_TEST_WORKSPACE;
const saved = await saveCapsule({
  id: "cli-json-capsule",
  runner: "codex",
  workspace,
  sourceSessionId: "cli-json-session",
  kind: "workflow",
  mergeKey: "cli-json.test-capsule",
  reusable: true,
  confidence: 0.9,
  title: "Inspect CLI JSON output",
  summary: "Use the CLI JSON commands to inspect local ARC state.",
  reuseWhen: ["checking CLI JSON output"],
  doNotReuseWhen: [],
  evidence: ["The CLI emitted valid JSON."],
  provenance: ["test"],
  nextRunInstruction: "Run arc status --json and arc capsules --json before building a thin client.",
  workflow: {
    purpose: "Inspect ARC through server-free CLI JSON.",
    parameters: ["workspace"],
    bindingSources: ["test"],
    steps: ["Run status JSON.", "Run capsules JSON."],
    commands: ["arc status --json", "arc capsules --json"],
    successCriteria: ["Both commands emit parseable JSON."],
    failedAttempts: [],
    validationProbe: ["node -e 'JSON.parse(input)'"]
  }
}, workspace);
if (!saved) throw new Error("seed save failed");
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(repo_root())
        .envs(test_env(workspace))
        .env("ARC_TEST_WORKSPACE", workspace)
        .output()
        .expect("seed capsule with TS");
    assert!(
        output.status.success(),
        "seed failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_capture_trace(path: &Path) {
    let events = [
        serde_json::json!({
            "id": "capture-session-start",
            "runner": "copilot",
            "sessionId": "capture-parity-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "type": "session_start",
            "source": "test"
        }),
        serde_json::json!({
            "id": "capture-user",
            "runner": "copilot",
            "sessionId": "capture-parity-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:01.000Z",
            "type": "user_prompt",
            "source": "test",
            "text": "Add a deterministic capture parity test for the Rust ARC import path."
        }),
        serde_json::json!({
            "id": "capture-tool-start",
            "runner": "copilot",
            "sessionId": "capture-parity-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:02.000Z",
            "type": "tool_start",
            "source": "test",
            "toolName": "shell",
            "toolUseId": "tool-1",
            "command": "cargo test rust_import_copilot_creates_same_capsule_as_ts_with_command_reviewer"
        }),
        serde_json::json!({
            "id": "capture-tool-end",
            "runner": "copilot",
            "sessionId": "capture-parity-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "type": "tool_end",
            "source": "test",
            "toolName": "shell",
            "toolUseId": "tool-1",
            "command": "cargo test rust_import_copilot_creates_same_capsule_as_ts_with_command_reviewer",
            "toolStatus": "success",
            "exitCode": 0,
            "text": "test result: ok. exit code: 0"
        }),
        serde_json::json!({
            "id": "capture-assistant",
            "runner": "copilot",
            "sessionId": "capture-parity-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:04.000Z",
            "type": "assistant_message",
            "source": "test",
            "text": "Done. The capture import path was verified with a deterministic command reviewer."
        }),
    ];
    let text = events
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, text).unwrap();
}

fn write_tiny_review_trace(path: &Path) {
    let events = [
        serde_json::json!({
            "id": "tiny-session-start",
            "runner": "copilot",
            "sessionId": "tiny-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "type": "session_start",
            "source": "test"
        }),
        serde_json::json!({
            "id": "tiny-user",
            "runner": "copilot",
            "sessionId": "tiny-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:01.000Z",
            "type": "user_prompt",
            "source": "test",
            "text": "What does ARC do?"
        }),
        serde_json::json!({
            "id": "tiny-assistant",
            "runner": "copilot",
            "sessionId": "tiny-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:02.000Z",
            "type": "assistant_message",
            "source": "test",
            "text": "ARC is a local run cache."
        }),
    ];
    let text = events
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, text).unwrap();
}

fn write_correction_trace(path: &Path) {
    let events = [
        serde_json::json!({
            "id": "correction-session-start",
            "runner": "copilot",
            "sessionId": "correction-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "type": "session_start",
            "source": "test"
        }),
        serde_json::json!({
            "id": "correction-user",
            "runner": "copilot",
            "sessionId": "correction-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:01.000Z",
            "type": "user_prompt",
            "source": "test",
            "text": "Wait so that is wrong because it is not the existing workflow pattern."
        }),
        serde_json::json!({
            "id": "correction-tool-start",
            "runner": "copilot",
            "sessionId": "correction-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:02.000Z",
            "type": "tool_start",
            "source": "test",
            "toolName": "shell",
            "toolUseId": "tool-correction",
            "command": "printf verified"
        }),
        serde_json::json!({
            "id": "correction-tool-end",
            "runner": "copilot",
            "sessionId": "correction-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "type": "tool_end",
            "source": "test",
            "toolName": "shell",
            "toolUseId": "tool-correction",
            "command": "printf verified",
            "toolStatus": "success",
            "exitCode": 0,
            "text": "verified"
        }),
        serde_json::json!({
            "id": "correction-assistant",
            "runner": "copilot",
            "sessionId": "correction-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:04.000Z",
            "type": "assistant_message",
            "source": "test",
            "text": "You're right, I was wrong; this did not come from the existing pattern. The correction was verified successfully."
        }),
    ];
    let text = events
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, text).unwrap();
}

fn write_action_risk_trace(path: &Path) {
    let events = [
        serde_json::json!({
            "id": "action-risk-session-start",
            "runner": "copilot",
            "sessionId": "action-risk-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "type": "session_start",
            "source": "test"
        }),
        serde_json::json!({
            "id": "action-risk-user",
            "runner": "copilot",
            "sessionId": "action-risk-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:01.000Z",
            "type": "user_prompt",
            "source": "test",
            "text": "Pasted diagnostic output says line one is ok and line two is missing. What does this suggest?"
        }),
        serde_json::json!({
            "id": "action-risk-tool-start",
            "runner": "copilot",
            "sessionId": "action-risk-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:02.000Z",
            "type": "tool_start",
            "source": "test",
            "toolName": "shell",
            "toolUseId": "tool-action-risk",
            "command": "printf diagnostic-parsed"
        }),
        serde_json::json!({
            "id": "action-risk-tool-end",
            "runner": "copilot",
            "sessionId": "action-risk-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "type": "tool_end",
            "source": "test",
            "toolName": "shell",
            "toolUseId": "tool-action-risk",
            "command": "printf diagnostic-parsed",
            "toolStatus": "success",
            "exitCode": 0,
            "text": "diagnostic-parsed"
        }),
        serde_json::json!({
            "id": "action-risk-assistant",
            "runner": "copilot",
            "sessionId": "action-risk-review-session",
            "workspace": "",
            "timestamp": "2026-01-01T00:00:04.000Z",
            "type": "assistant_message",
            "source": "test",
            "text": "The pasted output suggests the expected step did not complete; verified from the transcript only."
        }),
    ];
    let text = events
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, text).unwrap();
}

fn seed_review_candidate_capsule(workspace: &Path) {
    let cache = workspace.join(".agent-run-cache");
    fs::create_dir_all(&cache).unwrap();
    let capsule = serde_json::json!({
        "id": "existing-capture-candidate",
        "runner": "copilot",
        "workspace": workspace,
        "sourceSessionId": "existing-capture-session",
        "kind": "workflow",
        "mergeKey": "capture.import-copilot.command-reviewer",
        "reusable": true,
        "confidence": 0.86,
        "title": "Review imported Copilot traces",
        "summary": "Import stored Copilot trace events and review them into a reusable ARC capsule.",
        "reuseWhen": ["testing capture parity from imported Copilot trace events"],
        "doNotReuseWhen": [],
        "evidence": ["A stored trace can be reviewed after a cargo test command exits 0."],
        "provenance": ["tests/rust_parity.rs"],
        "artifactSources": [],
        "supersedes": [],
        "confidenceReason": "Seed capsule for review candidate prompt parity.",
        "failureBoundary": ["Does not prove a live Copilot session."],
        "validationProvenance": ["seed fixture"],
        "nextRunInstruction": "Run arc import-copilot <events.jsonl> and compare reviewed capsule output.",
        "workflow": {
            "purpose": "Verify ARC capsule creation from imported Copilot trace events.",
            "parameters": ["events.jsonl", "reviewer command"],
            "bindingSources": ["tests/rust_parity.rs"],
            "steps": ["Write stored ArcEvent JSONL.", "Run arc import-copilot.", "Compare memory and reviewed output."],
            "commands": ["arc import-copilot <events.jsonl>", "cargo test rust_import_copilot_creates_same_capsule_as_ts_with_command_reviewer"],
            "successCriteria": ["reviewed.jsonl records status saved"],
            "failedAttempts": [],
            "validationProbe": ["arc capsules --json"]
        }
    });
    fs::write(cache.join("memory.jsonl"), format!("{capsule}\n")).unwrap();
}

fn seed_action_risk_injection_event(workspace: &Path, session_id: &str) {
    let cache = workspace.join(".agent-run-cache");
    fs::create_dir_all(&cache).unwrap();
    let event = serde_json::json!({
        "id": "seed-action-risk-context",
        "type": "capsule.injected",
        "timestamp": "2026-01-01T00:00:01.500Z",
        "workspace": workspace,
        "sessionId": session_id,
        "capsuleId": "seed-live-capsule",
        "details": {
            "source": "sidecar",
            "surface": "json-hook",
            "reason": "consult abstained for no live-action intent",
            "injected": true,
            "used": "unknown",
            "helped": "unknown",
            "injectedCapsuleIds": ["seed-live-capsule"],
            "consultApplied": false,
            "consultAbstainReason": "consult abstained for no live-action intent",
            "actionRisk": "prompt is pasted diagnostic output without live-action intent"
        }
    });
    fs::write(cache.join("memory-events.jsonl"), format!("{event}\n")).unwrap();
}

fn seed_provider_judge_context(workspace: &Path, session_id: &str) {
    let cache = workspace.join(".agent-run-cache");
    fs::create_dir_all(&cache).unwrap();
    let decision = serde_json::json!({
        "id": "judge-outcome-seed",
        "timestamp": "2026-01-01T00:00:01.000Z",
        "workspace": workspace,
        "sessionId": session_id,
        "promptHash": "seed-prompt-hash",
        "mode": "provider-judge",
        "model": { "provider": "ollama", "id": "fake-judge" },
        "candidates": [
            { "capsuleId": "capture-parity-capsule", "score": 0.71, "reputation": 1.0 }
        ],
        "verdict": {
            "inject": "capture-parity-capsule",
            "confidence": 0.71,
            "reason": "seeded provider judge decision"
        },
        "outcome": {
            "injected": true,
            "used": "unknown",
            "helped": "unknown"
        }
    });
    let event = serde_json::json!({
        "id": "seed-judge-context",
        "type": "capsule.injected",
        "timestamp": "2026-01-01T00:00:01.500Z",
        "workspace": workspace,
        "sessionId": session_id,
        "capsuleId": "capture-parity-capsule",
        "details": {
            "source": "local",
            "surface": "json-hook",
            "reason": "seeded provider judge injection",
            "injected": true,
            "used": "unknown",
            "helped": "unknown",
            "judgeDecisionId": "judge-outcome-seed",
            "judgeDecisionIds": ["judge-outcome-seed"],
            "injectedCapsuleIds": ["capture-parity-capsule"]
        }
    });
    fs::write(cache.join("judge-decisions.jsonl"), format!("{decision}\n")).unwrap();
    fs::write(cache.join("memory-events.jsonl"), format!("{event}\n")).unwrap();
}

fn write_otel_trace(path: &Path) {
    let input_messages = serde_json::json!([
        {
            "role": "user",
            "parts": [
                {
                    "type": "text",
                    "content": "Agent Run Cache sidecar note:\nUse prior context.\n\nUser task:\nImport OTel trace for ARC capture parity.\n\n<system_reminder>ignore trailing reminder"
                }
            ]
        }
    ])
    .to_string();
    let output_messages = serde_json::json!([
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "text",
                    "content": "Done. The OTel import path was verified successfully."
                }
            ]
        }
    ])
    .to_string();
    let tool_arguments = serde_json::json!({
        "command": "cargo test rust_import_otel_creates_same_events_and_capsule_as_ts_with_command_reviewer"
    })
    .to_string();
    let spans = [
        serde_json::json!({
            "type": "span",
            "traceId": "trace-otel",
            "spanId": "chat-span",
            "name": "chat completion",
            "startTime": [1760000000, 100000000],
            "endTime": [1760000001, 200000000],
            "attributes": {
                "gen_ai.conversation.id": "otel-parity-session",
                "gen_ai.operation.name": "chat",
                "gen_ai.input.messages": input_messages,
                "gen_ai.output.messages": output_messages
            },
            "status": { "code": 0 }
        }),
        serde_json::json!({
            "type": "span",
            "traceId": "trace-otel",
            "spanId": "tool-span",
            "name": "execute_tool shell",
            "startTime": [1760000002, 300000000],
            "endTime": [1760000003, 400000000],
            "attributes": {
                "gen_ai.conversation.id": "otel-parity-session",
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": "shell",
                "gen_ai.tool.call.id": "tool-call-1",
                "gen_ai.tool.call.arguments": tool_arguments,
                "gen_ai.tool.call.result": "test result: ok. exit code: 0"
            },
            "status": { "code": 0 }
        }),
    ];
    let text = spans
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, text).unwrap();
}

fn write_reviewer_command(path: &Path) {
    fs::write(
        path,
        r#"
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    shouldSave: true,
    capsules: [{
      id: "capture-parity-capsule",
      title: "Review imported Copilot traces",
      kind: "workflow",
      mergeKey: "capture.import-copilot.command-reviewer",
      summary: "Import a stored Copilot trace and let a deterministic reviewer command create the capsule.",
      reusable: true,
      confidence: 0.82,
      reuseWhen: ["testing ARC capture parity with a stored trace"],
      doNotReuseWhen: ["the trace is not a Copilot or stored ARC event JSONL"],
      evidence: ["The import command reviewed five events and the shell test exited 0."],
      provenance: ["tests/rust_parity.rs"],
      artifactSources: [],
      supersedes: [],
      confidenceReason: "The trace contains user, tool, and assistant evidence with exit code 0.",
      failureBoundary: ["Does not prove live Copilot plugin capture."],
      validationProvenance: ["cargo test focused parity case"],
      nextRunInstruction: "Run arc import-copilot <events.jsonl> with AGENT_RUN_CACHE_REVIEWER_COMMAND for deterministic capture tests.",
      workflow: {
        purpose: "Verify ARC capsule creation from imported Copilot trace events.",
        parameters: ["events.jsonl", "reviewer command"],
        bindingSources: ["tests/rust_parity.rs"],
        steps: ["Write stored ArcEvent JSONL.", "Run arc import-copilot with a reviewer command.", "Compare memory.jsonl and reviewed.jsonl."],
        commands: ["arc import-copilot <events.jsonl>"],
        successCriteria: ["reviewed.jsonl records status saved", "memory.jsonl contains capture-parity-capsule"],
        failedAttempts: [],
        validationProbe: ["arc capsules --json"]
      }
    }]
  }));
});
"#,
    )
    .unwrap();
}

fn write_marker_reviewer_command(path: &Path) {
    fs::write(
        path,
        r#"
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.REVIEWER_CALLED_PATH, "called");
  process.stdout.write(JSON.stringify({
    shouldSave: true,
    capsule: {
      id: "marker-reviewer-capsule",
      title: "Marker reviewer should not run",
      kind: "workflow",
      mergeKey: "marker.reviewer.should-not-run",
      summary: "This capsule proves the local observer failed to gate the reviewer.",
      reusable: true,
      confidence: 0.1,
      reuseWhen: ["never"],
      doNotReuseWhen: [],
      evidence: ["marker"],
      provenance: ["tests/rust_parity.rs"],
      artifactSources: [],
      supersedes: [],
      confidenceReason: "The marker reviewer was called.",
      failureBoundary: ["Should be blocked by local observer."],
      validationProvenance: ["marker file"],
      nextRunInstruction: "Do not use.",
      workflow: {
        purpose: "Fail observer-gate tests if persisted.",
        parameters: [],
        bindingSources: [],
        steps: [],
        commands: [],
        successCriteria: [],
        failedAttempts: [],
        validationProbe: []
      }
    }
  }));
});
"#,
    )
    .unwrap();
}

fn write_correction_workflow_reviewer_command(path: &Path) {
    fs::write(
        path,
        r#"
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    shouldSave: true,
    capsule: {
      id: "correction-workflow-capsule",
      title: "Broad correction workflow should be blocked",
      kind: "workflow",
      mergeKey: "correction.workflow.blocked",
      summary: "A correction turn should not become a broad positive workflow.",
      reusable: true,
      confidence: 0.7,
      reuseWhen: ["future correction turns"],
      doNotReuseWhen: [],
      evidence: ["The reviewer proposed a broad workflow despite correction signals."],
      provenance: ["tests/rust_parity.rs"],
      artifactSources: [],
      supersedes: [],
      confidenceReason: "This is intentionally over-broad.",
      failureBoundary: [],
      validationProvenance: ["reviewer command"],
      nextRunInstruction: "Do not persist broad workflows from correction turns.",
      workflow: {
        purpose: "Over-broad correction workflow.",
        parameters: [],
        bindingSources: ["tests/rust_parity.rs"],
        steps: ["Treat the corrected assumption as a reusable workflow."],
        commands: ["printf verified"],
        successCriteria: ["command exits 0"],
        failedAttempts: [],
        validationProbe: ["printf verified"]
      }
    }
  }));
});
"#,
    )
    .unwrap();
}

fn write_live_action_reviewer_command(path: &Path, input_capture: &Path) {
    let capture = serde_json::to_string(&input_capture.display().to_string()).unwrap();
    fs::write(
        path,
        format!(
            r#"
const fs = require("node:fs");
const capture = {capture};
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {{
  fs.writeFileSync(capture, input);
  process.stdout.write(JSON.stringify({{
    shouldSave: true,
    capsule: {{
      id: "action-risk-live-capsule",
      title: "Live action from pasted diagnostic",
      kind: "workflow",
      mergeKey: "action-risk.live-action.blocked",
      summary: "This broad external action should be blocked when the prompt only asks about pasted diagnostics.",
      reusable: true,
      confidence: 0.8,
      reuseWhen: ["future pasted diagnostic prompts"],
      doNotReuseWhen: [],
      evidence: ["The reviewer proposed a live external action."],
      provenance: ["tests/rust_parity.rs"],
      artifactSources: [],
      supersedes: [],
      confidenceReason: "Intentional broad live-action proposal.",
      failureBoundary: [],
      validationProvenance: ["reviewer command"],
      nextRunInstruction: "Run the external action.",
      workflow: {{
        purpose: "Inspect a live external resource.",
        parameters: ["target"],
        bindingSources: ["tests/rust_parity.rs"],
        steps: ["Run external-runner inspect against the live target."],
        commands: ["external-runner inspect <target>"],
        successCriteria: ["external-runner exits 0"],
        failedAttempts: [],
        validationProbe: ["external-runner inspect <target>"]
      }}
    }}
  }}));
}});
"#
        ),
    )
    .unwrap();
}

fn run_ts_review_with_action_risk_options(
    trace: &Path,
    workspace: &Path,
    reviewer_command: &str,
) -> Value {
    let script = r#"
import { readFile } from "node:fs/promises";
import { reviewEvents } from "./dist/review.js";
const raw = await readFile(process.env.ARC_TRACE, "utf8");
const events = raw.trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
const result = await reviewEvents(
  events,
  process.env.ARC_TEST_WORKSPACE,
  "action-risk-review-session",
  "auto",
  {
    consultApplied: false,
    consultAbstainReason: "consult abstained for no live-action intent",
    actionRisk: "prompt is pasted diagnostic output without live-action intent"
  }
);
process.stdout.write(JSON.stringify(result));
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(repo_root())
        .envs(test_env(workspace))
        .env("ARC_TRACE", trace)
        .env("ARC_TEST_WORKSPACE", workspace)
        .env("AGENT_RUN_CACHE_REVIEWER_COMMAND", reviewer_command)
        .output()
        .expect("run TS action-risk review");
    assert!(
        output.status.success(),
        "TS action-risk review failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn read_reviewed(workspace: &Path) -> Value {
    fs::read_to_string(workspace.join(".agent-run-cache/reviewed.jsonl"))
        .unwrap()
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .unwrap()
}

fn read_trace_summary(workspace: &Path, session_id: &str) -> Vec<Value> {
    fs::read_to_string(
        workspace
            .join(".agent-run-cache/traces")
            .join(format!("arc-{session_id}.jsonl")),
    )
    .unwrap()
    .lines()
    .filter(|line| !line.trim().is_empty())
    .map(|line| {
        let event = serde_json::from_str::<Value>(line).unwrap();
        serde_json::json!({
            "id": event["id"],
            "sessionId": event["sessionId"],
            "timestamp": event["timestamp"],
            "type": event["type"],
            "source": event["source"],
            "text": event["text"],
            "toolName": event["toolName"],
            "toolUseId": event["toolUseId"],
            "command": event["command"],
            "toolStatus": event["toolStatus"],
            "exitCode": event["exitCode"],
            "rawType": event["rawType"],
            "raw": event["raw"]
        })
    })
    .collect()
}

fn seed_debug_cache(workspace: &Path) {
    let cache = workspace.join(".agent-run-cache");
    fs::create_dir_all(cache.join("debug")).unwrap();
    fs::create_dir_all(cache.join("traces")).unwrap();
    fs::create_dir_all(cache.join("copilot-logs/debug-session")).unwrap();
    let capsule = serde_json::json!({
        "id": "debug-capsule",
        "runner": "copilot",
        "workspace": workspace,
        "workspaceKey": "test",
        "sourceSessionId": "debug-session",
        "sourceSessionIds": ["debug-session"],
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "status": "local",
        "privacyLabel": "local",
        "contributors": [],
        "useCount": 0,
        "successCount": 0,
        "failureCount": 0,
        "kind": "workflow",
        "mergeKey": "debug.bundle",
        "title": "Debug bundle ghp_abcdefghijklmnopqrstuvwxyz",
        "summary": "Redact https://example.com/private from bundles.",
        "reusable": true,
        "confidence": 0.8,
        "reuseWhen": ["debug bundle"],
        "doNotReuseWhen": [],
        "evidence": ["TOKEN=secret-value"],
        "provenance": [],
        "artifactSources": [],
        "supersedes": [],
        "supersededBy": [],
        "confidenceReason": "fixture",
        "failureBoundary": [],
        "validationProvenance": [],
        "outcomeStatus": "success",
        "nextRunInstruction": "Inspect debug bundle output.",
        "workflow": {
            "purpose": "Exercise debug bundle redaction.",
            "parameters": [],
            "bindingSources": [],
            "steps": ["Run debug-bundle."],
            "commands": ["arc debug-bundle"],
            "successCriteria": ["Secrets are redacted."],
            "failedAttempts": [],
            "validationProbe": ["arc logs"]
        }
    });
    fs::write(cache.join("memory.jsonl"), format!("{capsule}\n")).unwrap();
    fs::write(
        cache.join("memory-events.jsonl"),
        format!(
            "{}\n",
            serde_json::json!({
                "id": "event-debug",
                "type": "capsule.created",
                "timestamp": "2026-01-01T12:34:55.000Z",
                "workspace": workspace,
                "sessionId": "debug-session",
                "capsuleId": "debug-capsule",
                "details": { "title": "Debug bundle" }
            })
        ),
    )
    .unwrap();
    fs::write(
        cache.join("reviewed.jsonl"),
        format!(
            "{}\n",
            serde_json::json!({
                "sessionId": "debug-session",
                "workspace": workspace,
                "traceHash": "abc",
                "eventCount": 1,
                "status": "saved",
                "capsuleId": "debug-capsule",
                "createdAt": "2026-01-01T12:34:55.000Z"
            })
        ),
    )
    .unwrap();
    fs::write(
        cache.join("debug/runtime.jsonl"),
        format!(
            "{}\nplain line\n",
            serde_json::json!({
                "timestamp": "2026-01-01T12:34:56.000Z",
                "action": "capsule.saved",
                "details": {
                    "sessionId": "debug-session",
                    "reason": "because",
                    "ignored": "not included"
                }
            })
        ),
    )
    .unwrap();
    fs::write(
        cache.join("debug/sidecar.jsonl"),
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-01-01T12:34:57.000Z",
                "kind": "review",
                "source": "command",
                "inputPreview": "bearer abcdefghijklmnop",
                "outputPreview": "ok"
            })
        ),
    )
    .unwrap();
    fs::write(
        cache.join("traces/arc-debug-session.jsonl"),
        format!(
            "{}\n",
            serde_json::json!({
                "id": "trace-event",
                "runner": "copilot",
                "sessionId": "debug-session",
                "workspace": workspace,
                "timestamp": "2026-01-01T12:34:58.000Z",
                "type": "assistant_message",
                "source": "test",
                "text": "token ghp_abcdefghijklmnopqrstuvwxyz"
            })
        ),
    )
    .unwrap();
    fs::write(
        cache.join("copilot-logs/debug-session/output.log"),
        "telemetry event\nWARN token ghp_abcdefghijklmnopqrstuvwxyz failed\n",
    )
    .unwrap();
}

fn install_fake_opencode(workspace: &Path) -> PathBuf {
    let path = workspace.join("fake-opencode");
    fs::write(
        &path,
        r#"#!/bin/sh
printf 'FAKE_OPENCODE_CLIENT:%s\n' "$OPENCODE_CLIENT"
printf 'FAKE_OPENCODE_ARG:%s\n' "$1"
case "$2" in
  *"Agent Run Cache"*) echo "FAKE_OPENCODE_HAS_ARC:yes" ;;
  *) echo "FAKE_OPENCODE_HAS_ARC:no" ;;
esac
case "$2" in
  *"User task:"*) echo "FAKE_OPENCODE_HAS_USER_TASK:yes" ;;
  *) echo "FAKE_OPENCODE_HAS_USER_TASK:no" ;;
esac
exit 0
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn install_fake_opencode_review_sidecar(workspace: &Path, prompt_capture: &Path) -> PathBuf {
    let path = workspace.join("fake-opencode-review");
    fs::write(
        &path,
        format!(
            r#"#!/bin/sh
if [ "$1" != "run" ]; then
  echo "unexpected opencode args" >&2
  exit 2
fi
printf '%s' "$2" > '{}'
cat <<'JSON'
{{"shouldSave":true,"capsules":[{{"id":"model-sidecar-capsule","title":"Model sidecar capture","kind":"workflow","mergeKey":"capture.model-sidecar","summary":"The model sidecar review path can create a capsule from an imported trace.","reusable":true,"confidence":0.81,"reuseWhen":["testing model sidecar review capture"],"doNotReuseWhen":[],"evidence":["The fake opencode sidecar returned a review JSON object."],"provenance":["tests/rust_parity.rs"],"artifactSources":[],"supersedes":[],"confidenceReason":"The command-side fake sidecar received the assembled draft prompt.","failureBoundary":["Does not prove a real opencode model response quality."],"validationProvenance":["cargo test focused model sidecar case"],"nextRunInstruction":"Use AGENT_RUN_CACHE_MODEL_SIDECAR=opencode with a runner that emits review JSON.","workflow":{{"purpose":"Verify ARC model-sidecar review routing.","parameters":["review prompt"],"bindingSources":["tests/rust_parity.rs"],"steps":["Import a trace without AGENT_RUN_CACHE_REVIEWER_COMMAND.","Let the opencode sidecar emit JSON.","Confirm memory and reviewed rows."],"commands":["arc import-copilot <events.jsonl>"],"successCriteria":["reviewed.jsonl records status saved"],"failedAttempts":[],"validationProbe":["arc capsules --json"]}}}}]}}
JSON
"#,
            prompt_capture.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn install_fake_copilot_jsonl_review_sidecar(workspace: &Path, args_capture: &Path) -> PathBuf {
    let path = workspace.join("fake-copilot-jsonl-review");
    let script = r#"#!/bin/sh
printf '%s\n' "$@" > '__ARGS_CAPTURE__'
cat <<'JSONL'
{"type":"session.info","data":{"message":"sidecar noise"}}
{"type":"assistant.message","data":{"content":"```json\n{\"shouldSave\":true,\"capsules\":[{\"id\":\"copilot-jsonl-sidecar-capsule\",\"title\":\"Copilot JSONL sidecar capture\",\"kind\":\"workflow\",\"mergeKey\":\"capture.copilot-jsonl-sidecar\",\"summary\":\"The Copilot model sidecar can return review JSON through assistant.message content in JSONL output.\",\"reusable\":true,\"confidence\":0.82,\"reuseWhen\":[\"testing Copilot JSONL sidecar review capture\"],\"doNotReuseWhen\":[],\"evidence\":[\"The fake Copilot sidecar emitted a JSONL assistant.message with review JSON.\"],\"provenance\":[\"tests/rust_parity.rs\"],\"artifactSources\":[],\"supersedes\":[],\"confidenceReason\":\"The sidecar output shape matches ollama-launched Copilot --output-format json.\",\"failureBoundary\":[\"Does not prove real model review quality.\"],\"validationProvenance\":[\"cargo test focused Copilot JSONL sidecar case\"],\"nextRunInstruction\":\"Parse assistant.message content from Copilot JSONL sidecar output before review JSON extraction.\",\"workflow\":{\"purpose\":\"Verify ARC Copilot sidecar JSONL parsing.\",\"parameters\":[\"review prompt\"],\"bindingSources\":[\"tests/rust_parity.rs\"],\"steps\":[\"Import a trace with AGENT_RUN_CACHE_MODEL_SIDECAR=copilot.\",\"Let the fake Copilot sidecar emit JSONL.\",\"Confirm memory and reviewed rows.\"],\"commands\":[\"arc import-copilot <events.jsonl>\"],\"successCriteria\":[\"reviewed.jsonl records status saved\"],\"failedAttempts\":[],\"validationProbe\":[\"arc capsules --json\"]}}]}\n```"}}
{"type":"result","exitCode":0}
JSONL
"#
    .replace("__ARGS_CAPTURE__", &args_capture.to_string_lossy());
    fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn run_ts_json(args: &[&str], cwd: &Path, input: Option<&str>) -> Value {
    serde_json::from_str(&run_ts_raw(args, cwd, input, &[])).unwrap()
}

fn run_rust_json(args: &[&str], cwd: &Path, input: Option<&str>) -> Value {
    run_rust_json_with_env(args, cwd, input, &[])
}

fn run_rust_json_with_env(
    args: &[&str],
    cwd: &Path,
    input: Option<&str>,
    extra_env: &[(&str, &str)],
) -> Value {
    serde_json::from_str(&run_rust_raw(args, cwd, input, extra_env)).unwrap()
}

fn run_ts_raw(
    args: &[&str],
    cwd: &Path,
    input: Option<&str>,
    extra_env: &[(&str, &str)],
) -> String {
    let mut command = Command::new("node");
    command.arg(repo_root().join("dist/cli.js"));
    command.args(args);
    run_command(command, cwd, input, extra_env)
}

fn run_rust_raw(
    args: &[&str],
    cwd: &Path,
    input: Option<&str>,
    extra_env: &[(&str, &str)],
) -> String {
    let mut command = Command::new(rust_bin());
    command.args(args);
    run_command(command, cwd, input, extra_env)
}

fn run_command(
    mut command: Command,
    cwd: &Path,
    input: Option<&str>,
    extra_env: &[(&str, &str)],
) -> String {
    command.current_dir(cwd).envs(test_env(cwd));
    for (key, value) in extra_env {
        command.env(key, value);
    }
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn command");
    if let Some(input) = input {
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "command failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
    String::from_utf8(output.stdout).unwrap()
}

fn test_env(workspace: &Path) -> HashMap<String, String> {
    let mut env = std::env::vars().collect::<HashMap<_, _>>();
    env.insert(
        "AGENT_RUN_CACHE_DIR".to_owned(),
        workspace.join(".agent-run-cache").display().to_string(),
    );
    env.insert(
        "AGENT_RUN_CACHE_HOME".to_owned(),
        workspace.join("arc-home").display().to_string(),
    );
    env.insert(
        "COPILOT_HOME".to_owned(),
        workspace.join("copilot-home").display().to_string(),
    );
    env.insert("AGENT_RUN_CACHE_MODEL_SIDECAR".to_owned(), "off".to_owned());
    env.insert(
        "AGENT_RUN_CACHE_LOCAL_OBSERVER".to_owned(),
        "off".to_owned(),
    );
    env.insert(
        "AGENT_RUN_CACHE_LOCAL_EMBEDDINGS".to_owned(),
        "off".to_owned(),
    );
    env.insert(
        "AGENT_RUN_CACHE_SKIP_COPILOT_TAB_SETUP".to_owned(),
        "1".to_owned(),
    );
    env
}

fn copy_cache(from: &Path, to: &Path) {
    let src = from.join(".agent-run-cache");
    let dst = to.join(".agent-run-cache");
    copy_dir(&src, &dst);
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to);
        } else {
            fs::copy(&from, &to).unwrap();
        }
    }
}

fn install_fake_llama_server(runtime_dir: &Path) {
    let release_dir = runtime_dir.join("llama-fake");
    fs::create_dir_all(&release_dir).unwrap();
    let source = release_dir.join("fake_llama_server.rs");
    fs::write(
        &source,
        r#"
use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let port = args.windows(2).find_map(|pair| (pair[0] == "--port").then(|| pair[1].parse::<u16>().ok()).flatten()).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut buffer = Vec::new();
        let mut temp = [0_u8; 4096];
        loop {
            let read = stream.read(&mut temp).unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&temp[..read]);
            if request_complete(&buffer) {
                break;
            }
        }
        let request = String::from_utf8_lossy(&buffer);
        let body = if request.starts_with("GET /health ") {
            "OK".to_owned()
        } else {
            let count = input_count(&request);
            format!("{{\"data\":[{}]}}", (0..count).map(|_| "{\"embedding\":[1.0,0.0]}").collect::<Vec<_>>().join(","))
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).unwrap();
    }
}

fn input_count(request: &str) -> usize {
    let Some(body) = request.split("\r\n\r\n").nth(1) else {
        return 1;
    };
    let Some(start) = body.find("\"input\":[") else {
        return 1;
    };
    let rest = &body[start + "\"input\":[".len()..];
    let Some(end) = rest.find(']') else {
        return 1;
    };
    let array = &rest[..end];
    if !array.contains('"') {
        return 0;
    }
    array.matches("\",\"").count() + 1
}

fn request_complete(buffer: &[u8]) -> bool {
    let text = String::from_utf8_lossy(buffer);
    let Some(header_end) = text.find("\r\n\r\n") else {
        return false;
    };
    let content_length = text[..header_end]
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.eq_ignore_ascii_case("content-length")).then(|| value.trim().parse::<usize>().ok()).flatten()
        })
        .unwrap_or(0);
    buffer.len() >= header_end + 4 + content_length
}
"#,
    )
    .unwrap();
    let output = Command::new("rustc")
        .arg(&source)
        .arg("-O")
        .arg("-o")
        .arg(release_dir.join(if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        }))
        .output()
        .expect("compile fake llama-server");
    assert!(
        output.status.success(),
        "fake llama compile failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn start_embedding_endpoint() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        for stream in listener.incoming().take(20) {
            let mut stream = stream.unwrap();
            let mut buffer = Vec::new();
            let mut temp = [0_u8; 4096];
            loop {
                let read = stream.read(&mut temp).unwrap_or(0);
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&temp[..read]);
                if request_complete(&buffer) {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&buffer);
            let count = request
                .split("\r\n\r\n")
                .nth(1)
                .and_then(|body| serde_json::from_str::<Value>(body).ok())
                .and_then(|value| value["input"].as_array().map(Vec::len))
                .unwrap_or(1);
            let body = serde_json::json!({
                "data": (0..count).map(|_| serde_json::json!({ "embedding": [1.0, 0.0] })).collect::<Vec<_>>()
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    format!("http://{address}/v1")
}

fn request_complete(buffer: &[u8]) -> bool {
    let text = String::from_utf8_lossy(buffer);
    let Some(header_end) = text.find("\r\n\r\n") else {
        return false;
    };
    let content_length = text[..header_end]
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.eq_ignore_ascii_case("content-length"))
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    buffer.len() >= header_end + 4 + content_length
}

fn rust_bin() -> PathBuf {
    std::env::var("CARGO_BIN_EXE_arc")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("target/debug/arc"))
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}
