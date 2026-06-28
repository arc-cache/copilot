use super::*;

pub(crate) fn run_mcp() -> Result<()> {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        let Some(message) = parse_message(&line) else {
            continue;
        };
        if let Err(error) = handle_mcp_message(&message) {
            if let Some(id) = request_id(&message) {
                write_json_line(
                    &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": error.to_string() } }),
                )?;
            }
        }
    }
    Ok(())
}

fn handle_mcp_message(message: &Value) -> Result<()> {
    let id = request_id(message);
    let method = message["method"].as_str().unwrap_or("");
    let Some(id_value) = id else { return Ok(()) };
    match method {
        "initialize" => write_json_line(&json!({
            "jsonrpc": "2.0",
            "id": id_value,
            "result": {
                "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "arc", "version": SERVER_VERSION }
            }
        })),
        "ping" => write_json_line(&json!({ "jsonrpc": "2.0", "id": id_value, "result": {} })),
        "tools/list" => write_json_line(
            &json!({ "jsonrpc": "2.0", "id": id_value, "result": { "tools": mcp_tools() } }),
        ),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("");
            let args = message["params"]["arguments"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let result = call_mcp_tool(name, &args)?;
            write_json_line(&json!({ "jsonrpc": "2.0", "id": id_value, "result": result }))
        }
        "shutdown" => write_json_line(&json!({ "jsonrpc": "2.0", "id": id_value, "result": null })),
        _ => write_json_line(
            &json!({ "jsonrpc": "2.0", "id": id_value, "error": { "code": -32601, "message": format!("Unknown method: {method}") } }),
        ),
    }
}

fn mcp_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "arc_search",
            "description": "Search ARC capsules for reusable methods relevant to a prompt.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The prompt or task to search capsules for." },
                    "limit": { "type": "number", "description": "Maximum number of capsules to return." }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "arc_status",
            "description": "Return ARC workspace status, capsule count, and recent activity summary.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "arc_capsule",
            "description": "Return a single ARC capsule by id or id prefix.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Capsule id or id prefix." } },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "arc_pause",
            "description": "Pause ARC prompt injection for a duration.",
            "inputSchema": {
                "type": "object",
                "properties": { "duration": { "type": "string", "description": "Pause duration such as 1h, 2h, today, or off." } },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "arc_resume",
            "description": "Resume ARC prompt injection.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "arc_set_judge",
            "description": "Set the provider judge model used by ARC retrieval.",
            "inputSchema": {
                "type": "object",
                "properties": { "model": { "type": "string", "description": "Judge model as provider:id, for example ollama:gemma4:31b-cloud." } },
                "required": ["model"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "arc_list_judges",
            "description": "List judge-capable models ARC can use.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "arc_delete_capsule",
            "description": "Delete one ARC capsule by id or id prefix. Safe to repeat.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Capsule id or id prefix." } },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "arc_share_capsule",
            "description": "Export one ARC capsule as portable markdown.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Capsule id or id prefix." } },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
    ]
}

fn call_mcp_tool(name: &str, args: &Map<String, Value>) -> Result<Value> {
    let workspace = resolve_mcp_workspace()?;
    match name {
        "arc_status" => Ok(text_result(
            &serde_json::to_string_pretty(&status_payload(&workspace)?)?,
            false,
        )),
        "arc_search" => {
            let query = string_arg(args, "query")?;
            let limit = number_arg(args, "limit", 5);
            let results = search_capsules_for_query(&query, &workspace, limit)?;
            Ok(text_result(
                &serde_json::to_string_pretty(
                    &json!({ "workspace": workspace, "query": query, "results": results }),
                )?,
                false,
            ))
        }
        "arc_capsule" => {
            let id = string_arg(args, "id")?;
            let capsules = load_capsules(&workspace)?;
            if let Some(capsule) = find_capsule(&capsules, &id) {
                Ok(text_result(
                    &serde_json::to_string_pretty(
                        &json!({ "workspace": workspace, "capsule": capsule }),
                    )?,
                    false,
                ))
            } else {
                Ok(text_result(&format!("No ARC capsule matches {id}."), true))
            }
        }
        "arc_pause" => {
            let duration = args
                .get("duration")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("1h");
            let config = if duration == "off" {
                save_arc_config(ArcConfigPatch {
                    injection_paused_until: Some(None),
                    ..ArcConfigPatch::default()
                })?
            } else {
                let until = pause_until(duration)?;
                save_arc_config(ArcConfigPatch {
                    injection_paused_until: Some(Some(
                        until.to_rfc3339_opts(SecondsFormat::Millis, true),
                    )),
                    ..ArcConfigPatch::default()
                })?
            };
            Ok(text_result(
                &serde_json::to_string_pretty(
                    &json!({ "configPath": arc_config_path(), "injectionPause": injection_pause_status(&config) }),
                )?,
                false,
            ))
        }
        "arc_resume" => {
            let config = save_arc_config(ArcConfigPatch {
                injection_paused_until: Some(None),
                ..ArcConfigPatch::default()
            })?;
            Ok(text_result(
                &serde_json::to_string_pretty(
                    &json!({ "configPath": arc_config_path(), "injectionPause": injection_pause_status(&config) }),
                )?,
                false,
            ))
        }
        "arc_set_judge" => {
            let model = parse_judge_model(&string_arg(args, "model")?)?;
            let config = save_arc_config(ArcConfigPatch {
                injection_judge_mode: Some("provider-judge".to_owned()),
                injection_judge_model: Some(model),
                ..ArcConfigPatch::default()
            })?;
            Ok(text_result(
                &serde_json::to_string_pretty(
                    &json!({ "configPath": arc_config_path(), "config": config }),
                )?,
                false,
            ))
        }
        "arc_list_judges" => Ok(text_result(
            &serde_json::to_string_pretty(&list_judge_models())?,
            false,
        )),
        "arc_delete_capsule" => {
            let id = string_arg(args, "id")?;
            Ok(text_result(
                &serde_json::to_string_pretty(&delete_capsule(&id, &workspace)?)?,
                false,
            ))
        }
        "arc_share_capsule" => {
            let id = string_arg(args, "id")?;
            let capsules = load_capsules(&workspace)?;
            if let Some(capsule) = find_capsule(&capsules, &id) {
                Ok(text_result(&capsule_markdown(capsule), false))
            } else {
                Ok(text_result(&format!("No ARC capsule matches {id}."), true))
            }
        }
        _ => Ok(text_result(&format!("Unknown ARC MCP tool: {name}."), true)),
    }
}

fn resolve_mcp_workspace() -> Result<PathBuf> {
    if let Ok(explicit) = env::var("AGENT_RUN_CACHE_WORKSPACE") {
        if !explicit.trim().is_empty() {
            return workspace_root(PathBuf::from(explicit));
        }
    }
    let current = workspace_root(env::current_dir()?)?;
    let normalized = current.to_string_lossy().replace('\\', "/");
    if !normalized.contains("/.copilot/installed-plugins/") {
        return Ok(current);
    }
    if let Ok(raw) = fs::read_to_string(copilot_plugin_workspace_path()) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if let Some(workspace) = value["workspace"].as_str().filter(|s| !s.trim().is_empty()) {
                return workspace_root(PathBuf::from(workspace));
            }
        }
    }
    Ok(current)
}

fn text_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn parse_message(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value = serde_json::from_str::<Value>(trimmed).ok()?;
    if value.is_object() {
        Some(value)
    } else {
        None
    }
}

fn request_id(message: &Value) -> Option<Value> {
    let id = message.get("id")?;
    if id.is_string() || id.is_number() || id.is_null() {
        Some(id.clone())
    } else {
        None
    }
}

fn string_arg(args: &Map<String, Value>, name: &str) -> Result<String> {
    let value = args.get(name).and_then(Value::as_str).unwrap_or("").trim();
    if value.is_empty() {
        Err(anyhow!("{name} must be a non-empty string"))
    } else {
        Ok(value.to_owned())
    }
}

fn number_arg(args: &Map<String, Value>, name: &str, fallback: usize) -> usize {
    args.get(name)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value.floor() as usize).min(20))
        .unwrap_or(fallback)
}
