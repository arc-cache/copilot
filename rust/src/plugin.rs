use super::*;

const COPILOT_TAB_SENTINEL: &str = "agent-run-cache/copilot-tab/v2-rich";
const OLD_COPILOT_TAB_SENTINEL: &str = "agent-run-cache/copilot-tab/v1";
const COPILOT_TAB_BACKUP_SUFFIX: &str = ".arc-backup";
const COPILOT_TAB_CAVEAT: &str = "The Copilot Arc tab patch is deprecated. Use `arc split` for the companion pane, `arc ui` for the standalone dashboard, or `/arc` inside Copilot after `/settings experimental on`.";
const SDK_EXTENSION_SENTINEL: &str = "agent-run-cache/copilot-sdk-extension/v1";
const SDK_UI_EXTENSION_SENTINEL: &str = "agent-run-cache/copilot-sdk-ui/v1";
const SDK_UI_EXTENSION_SOURCE: &str =
    include_str!("../../plugin/extensions/agent-run-cache/extension.mjs");

pub(crate) fn run_plugin(args: &[String]) -> Result<()> {
    let json_mode = has_json(args);
    let clean = strip_flag(args, "--json");
    let sub = clean.first().map(String::as_str).unwrap_or("status");
    match sub {
        "path" => {
            let payload = json!({ "pluginDir": plugin_dir() });
            if json_mode {
                write_json(&payload)
            } else {
                println!("{}", payload["pluginDir"].as_str().unwrap_or_default());
                Ok(())
            }
        }
        "install" | "status" => {
            let status = if sub == "install" {
                install_copilot_plugin()
            } else {
                copilot_plugin_status()
            };
            if json_mode {
                write_json(&status)
            } else {
                println!(
                    "copilot plugin: {}",
                    if status["installed"].as_bool().unwrap_or(false) {
                        "installed"
                    } else {
                        "not installed"
                    }
                );
                println!(
                    "plugin path: {}",
                    status["pluginDir"].as_str().unwrap_or_default()
                );
                if let Some(reason) = status["reason"].as_str() {
                    println!("reason: {reason}");
                }
                if let Some(output) = status["listOutput"].as_str().filter(|s| !s.is_empty()) {
                    println!("{output}");
                }
                Ok(())
            }
        }
        _ => Err(anyhow!("Usage: arc plugin install|status|path [--json]")),
    }
}

pub(crate) fn run_copilot_tab(args: &[String]) -> Result<()> {
    assert_known_flags(args, &["--json", "--copilot-root"])?;
    let json_mode = has_json(args);
    let clean = strip_flag(args, "--json");
    let sub = clean.first().map(String::as_str).unwrap_or("status");
    let payload = match sub {
        "status" => copilot_tab_status(args),
        "restore" => restore_copilot_tab(args),
        "install" => json!({
            "installed": false,
            "changed": false,
            "reason": "Rust ARC does not install the deprecated Copilot Arc tab. Use `arc split`, standalone `arc ui`, or `/arc` after `/settings experimental on`.",
            "caveat": COPILOT_TAB_CAVEAT
        }),
        _ => {
            return Err(anyhow!(
                "Usage: arc copilot-tab status|restore [--json] [--copilot-root <path>]"
            ))
        }
    };
    if json_mode {
        write_json(&payload)
    } else {
        println!(
            "copilot tab: {}",
            if payload["installed"].as_bool().unwrap_or(false) {
                "installed"
            } else {
                "not installed"
            }
        );
        println!("changed: {}", payload["changed"].as_bool().unwrap_or(false));
        if let Some(app_js) = payload["appJs"].as_str() {
            println!("app.js: {app_js}");
        }
        if let Some(backup) = payload["backupPath"].as_str() {
            println!("backup: {backup}");
        }
        if let Some(reason) = payload["reason"].as_str() {
            println!("reason: {reason}");
        }
        println!("{COPILOT_TAB_CAVEAT}");
        Ok(())
    }
}

pub(crate) fn run_setup(args: &[String], workspace: &Path) -> Result<()> {
    assert_known_flags(
        args,
        &[
            "--json",
            "--install-copilot-tab",
            "--no-copilot-tab",
            "--sidecar-copilot-command",
            "--copilot-root",
            "--enable-experimental",
        ],
    )?;
    if args.contains(&"--enable-experimental".to_owned()) {
        enable_copilot_experimental()?;
    }
    let configured_sidecar = option_value(args, "--sidecar-copilot-command").map(str::to_owned);
    let config = if let Some(command) = configured_sidecar {
        save_arc_config(ArcConfigPatch {
            sidecar_copilot_command: Some(command),
            ..ArcConfigPatch::default()
        })?
    } else {
        load_arc_config()?
    };
    let plugin = install_copilot_plugin();
    let legacy_extension_cleanup = disable_legacy_sdk_extensions(workspace);
    let legacy_json_hook_cleanup = disable_legacy_json_hooks(workspace);
    let sdk_extension_install = install_sdk_ui_extension();
    if plugin["installed"].as_bool().unwrap_or(false) {
        write_activation(workspace, "copilot-plugin")?;
    }
    let capsules = load_capsules(workspace)?;
    let extension = extension_status(workspace);
    let experimental = copilot_experimental_status();
    let hook = hook_status(workspace);
    let integration = read_activation_integration(workspace);
    let payload = json!({
        "workspace": workspace,
        "integration": integration,
        "integrationReason": if integration.is_some() { format!("Workspace already activated through {}.", integration.clone().unwrap()) } else { "The Copilot plugin auto-activates this workspace the first time its hook runs.".to_owned() },
        "plugin": plugin,
        "extension": extension,
        "sdkExtensionInstall": sdk_extension_install,
        "experimental": experimental,
        "legacyExtensionCleanup": legacy_extension_cleanup,
        "legacyJsonHookCleanup": legacy_json_hook_cleanup,
        "runtime": current_runtime(),
        "configPath": arc_config_path(),
        "sidecarCopilotCommand": config.sidecar_copilot_command,
        "legacyHook": hook,
        "copilotTabIgnored": args.contains(&"--install-copilot-tab".to_owned()) && !args.contains(&"--no-copilot-tab".to_owned()),
        "copilotTabCaveat": COPILOT_TAB_CAVEAT,
        "capsuleCount": capsules.len(),
        "launch": "arc split",
        "menu": "type /arc inside Copilot after /settings experimental on"
    });
    if has_json(args) {
        write_json(&payload)
    } else {
        println!(
            "ARC Copilot plugin {} for {}.",
            if payload["plugin"]["installed"].as_bool().unwrap_or(false) {
                "installed"
            } else {
                "not installed"
            },
            workspace.display()
        );
        println!(
            "plugin: {}",
            payload["plugin"]["pluginDir"].as_str().unwrap_or_default()
        );
        println!("launch: arc split");
        println!("standalone view: arc ui");
        println!("menu: /arc");
        if !payload["experimental"]["enabled"]
            .as_bool()
            .unwrap_or(false)
        {
            println!(
                "Enable the /arc menu: run `/settings experimental on` in Copilot, then /clear."
            );
        }
        println!(
            "workspace activation: {}",
            integration.unwrap_or_else(|| "pending first plugin hook".to_owned())
        );
        println!("runtime: {}", current_exe_string());
        println!("config: {}", arc_config_path().display());
        if legacy_extension_cleanup["changed"]
            .as_bool()
            .unwrap_or(false)
        {
            println!("legacy SDK extension: disabled");
        }
        if legacy_json_hook_cleanup["changed"]
            .as_bool()
            .unwrap_or(false)
        {
            println!("legacy JSON hooks: disabled");
        }
        println!("capsules: {}", capsules.len());
        Ok(())
    }
}

fn copilot_tab_status(args: &[String]) -> Value {
    let Some(root) = resolve_copilot_root(args) else {
        return json!({
            "installed": false,
            "changed": false,
            "reason": "Could not find the installed @github/copilot package.",
            "caveat": COPILOT_TAB_CAVEAT
        });
    };
    let app_js = root.join("app.js");
    let backup_path = backup_path(&app_js);
    let Ok(source) = fs::read_to_string(&app_js) else {
        return json!({
            "installed": false,
            "changed": false,
            "appJs": app_js,
            "backupPath": backup_path,
            "reason": "Copilot app.js was not found or could not be read.",
            "caveat": COPILOT_TAB_CAVEAT
        });
    };
    let installed =
        source.contains(COPILOT_TAB_SENTINEL) || source.contains(OLD_COPILOT_TAB_SENTINEL);
    json!({
        "installed": installed,
        "changed": false,
        "appJs": app_js,
        "backupPath": backup_path,
        "backupExists": backup_path.exists(),
        "caveat": COPILOT_TAB_CAVEAT
    })
}

fn restore_copilot_tab(args: &[String]) -> Value {
    let Some(root) = resolve_copilot_root(args) else {
        return json!({
            "installed": false,
            "changed": false,
            "reason": "Could not find the installed @github/copilot package.",
            "caveat": COPILOT_TAB_CAVEAT
        });
    };
    let app_js = root.join("app.js");
    let backup_path = backup_path(&app_js);
    if !backup_path.exists() {
        return json!({
            "installed": copilot_tab_status(args)["installed"].as_bool().unwrap_or(false),
            "changed": false,
            "appJs": app_js,
            "backupPath": backup_path,
            "reason": "No ARC Copilot tab backup exists.",
            "caveat": COPILOT_TAB_CAVEAT
        });
    }
    match fs::copy(&backup_path, &app_js) {
        Ok(_) => json!({
            "installed": false,
            "changed": true,
            "appJs": app_js,
            "backupPath": backup_path,
            "caveat": COPILOT_TAB_CAVEAT
        }),
        Err(error) => json!({
            "installed": copilot_tab_status(args)["installed"].as_bool().unwrap_or(false),
            "changed": false,
            "appJs": app_js,
            "backupPath": backup_path,
            "reason": error.to_string(),
            "caveat": COPILOT_TAB_CAVEAT
        }),
    }
}

fn backup_path(app_js: &Path) -> PathBuf {
    PathBuf::from(format!("{}{}", app_js.display(), COPILOT_TAB_BACKUP_SUFFIX))
}

fn resolve_copilot_root(args: &[String]) -> Option<PathBuf> {
    if let Some(root) = option_value(args, "--copilot-root")
        .map(PathBuf::from)
        .or_else(|| {
            env::var("AGENT_RUN_CACHE_COPILOT_ROOT")
                .ok()
                .map(PathBuf::from)
        })
    {
        return Some(absolutize(root));
    }
    let mut candidates = Vec::new();
    if let Some(exe) = find_executable("copilot") {
        if let Ok(real) = fs::canonicalize(exe) {
            if let Some(parent) = real.parent() {
                candidates.push(parent.to_path_buf());
            }
        }
    }
    if let Ok(output) = Command::new("npm").args(["root", "-g"]).output() {
        if output.status.success() {
            let root = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !root.is_empty() {
                candidates.push(PathBuf::from(root).join("@github/copilot"));
            }
        }
    }
    candidates
        .into_iter()
        .map(absolutize)
        .find(|candidate| candidate.join("app.js").exists())
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    for dir in env::split_paths(&paths) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
            let cmd = dir.join(format!("{name}.cmd"));
            if cmd.is_file() {
                return Some(cmd);
            }
        }
    }
    None
}

pub(crate) fn run_json_hooks(args: &[String], workspace: &Path) -> Result<()> {
    let json_mode = has_json(args);
    let clean = strip_flag(args, "--json");
    let sub = clean.first().map(String::as_str).unwrap_or("status");
    let hook = match sub {
        "install" => {
            install_copilot_prompt_hook(workspace)?;
            hook_status(workspace)
        }
        "status" => hook_status(workspace),
        _ => return Err(anyhow!("Usage: arc json-hooks install|status [--json]")),
    };
    if json_mode {
        write_json(&json!({ "hook": hook }))
    } else {
        println!(
            "json hooks: {}",
            if hook["installed"].as_bool().unwrap_or(false) {
                "installed"
            } else {
                "not installed"
            }
        );
        println!("hook path: {}", hook["path"].as_str().unwrap_or_default());
        if let Some(reason) = hook["reason"].as_str() {
            println!("reason: {reason}");
        }
        Ok(())
    }
}

pub(crate) fn hook_status(workspace: &Path) -> Value {
    let path = workspace.join(".github/hooks/agent-run-cache.json");
    let user_hook_path = copilot_user_hooks_dir().join("agent-run-cache.json");
    let repo_hook_shim_path = cache_dir(workspace).join("bin/copilot-hook.mjs");
    let user_hook_shim_path = arc_home().join("bin/copilot-hook.mjs");
    let active_path = activation_path(workspace);
    let repo = read_hook_file(&path);
    let user = read_hook_file(&user_hook_path);
    let activated = active_path.exists();
    let session_start = repo.1 || user.1;
    let user_prompt_submitted = repo.2 || user.2;
    let session_end = repo.3 || user.3;
    let repo_installed = repo.0;
    let user_installed = user.0;
    let installed = activated && (repo_installed || user_installed);
    let mut status = json!({
        "installed": installed,
        "path": path,
        "activationPath": active_path,
        "activated": activated,
        "repoHookInstalled": repo_installed,
        "repoHookRuntimePinned": false,
        "repoHookShimPath": repo_hook_shim_path,
        "userHookPath": user_hook_path,
        "userHookInstalled": user_installed,
        "userHookRuntimePinned": false,
        "userHookShimPath": user_hook_shim_path,
        "sessionStart": session_start,
        "userPromptSubmitted": user_prompt_submitted,
        "sessionEnd": session_end,
        "renderMode": COPILOT_HOOK_RENDER_MODE,
        "reason": if installed { Value::Null } else if !activated { Value::String("workspace not activated yet - install the Copilot plugin with arc plugin install, then launch Copilot normally".to_owned()) } else { Value::String("missing one or more ARC hook events".to_owned()) }
    });
    if installed {
        status.as_object_mut().unwrap().remove("reason");
    }
    status
}

fn install_copilot_prompt_hook(workspace: &Path) -> Result<()> {
    write_activation(workspace, "json-hooks")?;
    let arc_bin = current_exe_string();
    let repo_hook_path = workspace.join(".github/hooks/agent-run-cache.json");
    let user_hook_path = copilot_user_hooks_dir().join("agent-run-cache.json");
    write_hook_config(&repo_hook_path, &arc_bin)?;
    write_hook_config(&user_hook_path, &arc_bin)?;
    Ok(())
}

fn write_hook_config(path: &Path, arc_bin: &str) -> Result<()> {
    let command = |hook_name: &str| {
        shell_words(
            [arc_bin, "hook", "copilot", hook_name]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
                .iter()
                .map(String::as_str),
        )
    };
    write_pretty_json(
        path,
        &json!({
            "version": 1,
            "hooks": {
                "sessionStart": [{ "type": "command", "command": command("SessionStart"), "timeoutSec": 20 }],
                "userPromptSubmitted": [{ "type": "command", "command": command("UserPromptSubmit"), "timeoutSec": 20 }],
                "sessionEnd": [{ "type": "command", "command": command("SessionEnd"), "timeoutSec": 20 }]
            }
        }),
    )
}

fn read_hook_file(path: &Path) -> (bool, bool, bool, bool) {
    let Ok(raw) = fs::read_to_string(path) else {
        return (false, false, false, false);
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return (false, false, false, false);
    };
    let hooks = &value["hooks"];
    let session_start = hook_command_includes(&hooks["sessionStart"], "SessionStart");
    let user_prompt = hook_command_includes(&hooks["userPromptSubmitted"], "UserPromptSubmit");
    let session_end = hook_command_includes(&hooks["sessionEnd"], "SessionEnd");
    (
        session_start && user_prompt && session_end,
        session_start,
        user_prompt,
        session_end,
    )
}

fn hook_command_includes(value: &Value, hook_name: &str) -> bool {
    value.as_array().is_some_and(|items| {
        items.iter().any(|entry| {
            entry["command"].as_str().is_some_and(|command| {
                command.contains(hook_name)
                    && (command.contains("hook copilot")
                        || command.contains("copilot-hook.mjs")
                        || command.contains("agent-run-cache"))
            })
        })
    })
}

pub(crate) fn extension_status(workspace: &Path) -> Value {
    let active_path = activation_path(workspace);
    let project_extension_path = workspace.join(".github/extensions/agent-run-cache/extension.mjs");
    let user_extension_path = copilot_user_extensions_dir().join("agent-run-cache/extension.mjs");
    let project_installed = sdk_ui_extension_installed(&project_extension_path);
    let user_installed = sdk_ui_extension_installed(&user_extension_path);
    let project_legacy = legacy_sdk_extension_installed(&project_extension_path);
    let user_legacy = legacy_sdk_extension_installed(&user_extension_path);
    let activated = active_path.exists();
    let experimental = copilot_experimental_status();
    let installed = project_installed || user_installed;
    json!({
        "installed": installed,
        "activated": activated,
        "host": {
            "experimental": experimental,
            "likelyLoadsExtensions": installed && experimental["enabled"].as_bool().unwrap_or(false),
            "elicitationAvailable": installed && experimental["enabled"].as_bool().unwrap_or(false),
            "canvasesApiPresent": false,
            "reason": if installed && experimental["enabled"].as_bool().unwrap_or(false) { Value::Null } else if installed { Value::String("SDK extension installed; enable Copilot experimental mode for /arc.".to_owned()) } else { Value::String("SDK UI extension is not installed.".to_owned()) }
        },
        "activationPath": active_path,
        "projectExtensionPath": project_extension_path,
        "projectInstalled": project_installed,
        "projectLegacyInstalled": project_legacy,
        "projectRuntimePinned": false,
        "userExtensionPath": user_extension_path,
        "userInstalled": user_installed,
        "userLegacyInstalled": user_legacy,
        "userRuntimePinned": user_extension_path.with_file_name("arc-bin.txt").exists(),
        "pathFile": user_extension_path.with_file_name("arc-bin.txt"),
        "runtime": current_runtime(),
        "reason": if installed { Value::Null } else if project_legacy || user_legacy { Value::String("legacy SDK extension installed; run arc setup to replace it with the UI-only /arc extension".to_owned()) } else if activated { Value::String("missing SDK UI extension; run arc setup".to_owned()) } else { Value::String("workspace is not activated - install the Copilot plugin with arc plugin install, then launch Copilot normally".to_owned()) }
    })
}

fn install_sdk_ui_extension() -> Value {
    let dir = copilot_user_extensions_dir().join("agent-run-cache");
    let extension_path = dir.join("extension.mjs");
    let path_file = dir.join("arc-bin.txt");
    let arc_bin = current_exe_string();
    match fs::create_dir_all(&dir)
        .and_then(|_| fs::write(&extension_path, SDK_UI_EXTENSION_SOURCE))
        .and_then(|_| fs::write(&path_file, format!("{arc_bin}\n")))
    {
        Ok(_) => json!({
            "installed": true,
            "changed": true,
            "extensionPath": extension_path,
            "pathFile": path_file,
            "arcBin": arc_bin
        }),
        Err(error) => json!({
            "installed": false,
            "changed": false,
            "extensionPath": extension_path,
            "pathFile": path_file,
            "arcBin": arc_bin,
            "reason": error.to_string()
        }),
    }
}

fn disable_legacy_sdk_extensions(workspace: &Path) -> Value {
    let paths = [
        workspace.join(".github/extensions/agent-run-cache/extension.mjs"),
        copilot_user_extensions_dir().join("agent-run-cache/extension.mjs"),
    ];
    let mut moved = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    for path in paths {
        if !path.exists() {
            continue;
        }
        if !legacy_sdk_extension_installed(&path) {
            skipped.push(json!({ "path": path, "reason": "not an ARC legacy SDK extension" }));
            continue;
        }
        let disabled = legacy_extension_disabled_path(&path);
        match fs::rename(&path, &disabled) {
            Ok(_) => moved.push(json!({ "from": path, "to": disabled })),
            Err(error) => errors.push(json!({ "path": path, "reason": error.to_string() })),
        }
    }
    json!({
        "changed": !moved.is_empty(),
        "moved": moved,
        "skipped": skipped,
        "errors": errors
    })
}

fn disable_legacy_json_hooks(workspace: &Path) -> Value {
    let paths = [
        copilot_user_hooks_dir().join("agent-run-cache.json"),
        workspace.join(".github/hooks/agent-run-cache.json"),
        arc_home().join("bin/copilot-hook.mjs"),
        cache_dir(workspace).join("bin/copilot-hook.mjs"),
    ];
    let mut moved = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    for path in paths {
        if !path.exists() {
            continue;
        }
        if !legacy_json_hook_file(&path) {
            skipped.push(json!({ "path": path, "reason": "not an ARC legacy JSON hook file" }));
            continue;
        }
        let disabled = legacy_hook_disabled_path(&path);
        match fs::rename(&path, &disabled) {
            Ok(_) => moved.push(json!({ "from": path, "to": disabled })),
            Err(error) => errors.push(json!({ "path": path, "reason": error.to_string() })),
        }
    }
    json!({
        "changed": !moved.is_empty(),
        "moved": moved,
        "skipped": skipped,
        "errors": errors
    })
}

fn legacy_sdk_extension_installed(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|source| source.contains(SDK_EXTENSION_SENTINEL))
        .unwrap_or(false)
}

fn sdk_ui_extension_installed(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|source| {
            source.contains(SDK_UI_EXTENSION_SENTINEL)
                && source.contains("joinSession")
                && source.contains("commands")
                && !source.contains("copilot-sdk-active")
        })
        .unwrap_or(false)
}

fn copilot_settings_path() -> PathBuf {
    copilot_home().join("settings.json")
}

fn copilot_experimental_status() -> Value {
    let path = copilot_settings_path();
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(value) => json!({
                "path": path,
                "enabled": value["experimental"].as_bool().unwrap_or(false),
                "present": value.get("experimental").is_some()
            }),
            Err(error) => json!({
                "path": path,
                "enabled": false,
                "present": false,
                "reason": format!("could not parse settings.json: {error}")
            }),
        },
        Err(error) => json!({
            "path": path,
            "enabled": false,
            "present": false,
            "reason": error.to_string()
        }),
    }
}

fn enable_copilot_experimental() -> Result<()> {
    let path = copilot_settings_path();
    let mut value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    value
        .as_object_mut()
        .unwrap()
        .insert("experimental".to_owned(), Value::Bool(true));
    write_pretty_json(&path, &value)
}

fn legacy_json_hook_file(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|source| {
            source.contains("copilot-hook.mjs")
                || source.contains("dist/cli.js")
                || source.contains("AGENT_RUN_CACHE_ARC_ENTRYPOINT")
        })
        .unwrap_or(false)
}

fn legacy_extension_disabled_path(path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.disabled-by-arc-{}",
        path.display(),
        random_suffix()
    ))
}

fn legacy_hook_disabled_path(path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.disabled-by-arc-clean-{}",
        path.display(),
        random_suffix()
    ))
}

pub(crate) fn copilot_plugin_status() -> Value {
    let plugin_dir = plugin_dir();
    let output = Command::new("copilot").args(["plugin", "list"]).output();
    match output {
        Ok(output) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .trim()
            .to_owned();
            let installed = output.status.success()
                && Regex::new(r"\bagent-run-cache\b")
                    .unwrap()
                    .is_match(&combined);
            let mut status = json!({
                "pluginDir": plugin_dir,
                "installed": installed,
                "listOutput": combined,
                "reason": if output.status.success() { Value::Null } else { Value::String(if combined.is_empty() { format!("copilot plugin list exited {}", output.status.code().unwrap_or(-1)) } else { combined.clone() }) }
            });
            if output.status.success() {
                status.as_object_mut().unwrap().remove("reason");
            }
            status
        }
        Err(error) => {
            json!({ "pluginDir": plugin_dir, "installed": false, "listOutput": "", "reason": error.to_string() })
        }
    }
}

fn install_copilot_plugin() -> Value {
    let plugin_dir = match ensure_runtime_plugin_dir() {
        Ok(path) => path,
        Err(error) => {
            return json!({ "pluginDir": plugin_dir(), "installed": false, "listOutput": "", "reason": error.to_string() });
        }
    };
    if !resolve_arc_on_path() {
        return json!({ "pluginDir": plugin_dir, "installed": false, "listOutput": "", "reason": "arc is not on PATH. Install the Rust binary before installing the Copilot plugin." });
    }
    let output = Command::new("copilot")
        .args(["plugin", "install", &plugin_dir.to_string_lossy()])
        .output();
    match output {
        Ok(output) if output.status.success() => copilot_plugin_status(),
        Ok(output) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .trim()
            .to_owned();
            json!({ "pluginDir": plugin_dir, "installed": false, "listOutput": combined, "reason": if combined.is_empty() { format!("copilot plugin install exited {}", output.status.code().unwrap_or(-1)) } else { combined } })
        }
        Err(error) => {
            json!({ "pluginDir": plugin_dir, "installed": false, "listOutput": "", "reason": error.to_string() })
        }
    }
}

fn plugin_dir() -> PathBuf {
    env::var("AGENT_RUN_CACHE_PLUGIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| runtime_plugin_dir())
}

fn runtime_plugin_dir() -> PathBuf {
    arc_home().join("plugin")
}

fn ensure_runtime_plugin_dir() -> Result<PathBuf> {
    if let Ok(path) = env::var("AGENT_RUN_CACHE_PLUGIN_DIR") {
        let path = PathBuf::from(path);
        if !path.join("plugin.json").exists() {
            return Err(anyhow!(
                "ARC plugin manifest not found at {}",
                path.display()
            ));
        }
        return Ok(path);
    }
    let dir = runtime_plugin_dir();
    fs::create_dir_all(&dir)?;
    write_runtime_plugin_files(&dir)?;
    Ok(dir)
}

fn write_runtime_plugin_files(dir: &Path) -> Result<()> {
    let arc_bin = current_exe_string();
    write_pretty_json(
        &dir.join("plugin.json"),
        &json!({
            "name": "agent-run-cache",
            "description": "Local ARC hooks and MCP tools for recalling verified coding-agent run methods.",
            "version": SERVER_VERSION,
            "author": { "name": "Agent Run Cache" },
            "license": "Apache-2.0",
            "keywords": ["copilot-cli", "hooks", "mcp", "local-cache"],
            "hooks": "hooks.json",
            "mcpServers": ".mcp.json"
        }),
    )?;
    write_pretty_json(
        &dir.join("hooks.json"),
        &json!({
            "version": 1,
            "hooks": {
                "sessionStart": [runtime_plugin_hook(&arc_bin, "SessionStart")],
                "userPromptSubmitted": [runtime_plugin_hook(&arc_bin, "UserPromptSubmit")],
                "sessionEnd": [runtime_plugin_hook(&arc_bin, "SessionEnd")]
            }
        }),
    )?;
    write_pretty_json(
        &dir.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "arc": {
                    "type": "stdio",
                    "command": arc_bin,
                    "args": ["mcp"],
                    "tools": [
                        "arc_search",
                        "arc_status",
                        "arc_capsule",
                        "arc_pause",
                        "arc_resume",
                        "arc_set_judge",
                        "arc_list_judges",
                        "arc_delete_capsule",
                        "arc_share_capsule"
                    ],
                    "deferTools": "never",
                    "timeout": 10000
                }
            }
        }),
    )?;
    Ok(())
}

fn runtime_plugin_hook(arc_bin: &str, hook_name: &str) -> Value {
    json!({
        "type": "command",
        "command": shell_words([arc_bin, "hook", "copilot", hook_name].into_iter()),
        "timeoutSec": 20,
        "env": { "AGENT_RUN_CACHE_COPILOT_PLUGIN": "1" }
    })
}

pub(crate) fn current_runtime() -> Value {
    json!({
        "node": Value::Null,
        "entrypoint": current_exe_string(),
        "packageRoot": env!("CARGO_MANIFEST_DIR"),
        "transient": false
    })
}

pub(crate) fn write_activation(workspace: &Path, integration: &str) -> Result<()> {
    write_pretty_json(
        &activation_path(workspace),
        &json!({
            "version": 1,
            "workspace": workspace,
            "integration": integration,
            "runtime": current_runtime(),
            "activatedAt": now_iso()
        }),
    )
}

pub(crate) fn read_activation_integration(workspace: &Path) -> Option<String> {
    let raw = fs::read_to_string(activation_path(workspace)).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    match value["integration"].as_str()? {
        "copilot-plugin" | "sdk-extension" | "json-hooks" => {
            Some(value["integration"].as_str().unwrap().to_owned())
        }
        _ => None,
    }
}

pub(crate) fn is_workspace_activated(workspace: &Path) -> bool {
    activation_path(workspace).exists()
}

pub(crate) fn is_plugin_hook() -> bool {
    env::var("AGENT_RUN_CACHE_COPILOT_PLUGIN").ok().as_deref() == Some("1")
}

pub(crate) fn remember_copilot_plugin_workspace(workspace: &Path) -> Result<()> {
    write_pretty_json(
        &copilot_plugin_workspace_path(),
        &json!({
            "version": 1,
            "workspace": workspace,
            "updatedAt": now_iso(),
            "pid": std::process::id()
        }),
    )
}

pub(crate) fn copilot_plugin_workspace_path() -> PathBuf {
    arc_home().join("copilot-plugin-workspace.json")
}

fn resolve_arc_on_path() -> bool {
    command_exists(if cfg!(windows) { "arc.exe" } else { "arc" }) || command_exists("arc")
}
