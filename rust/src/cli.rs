use super::*;

pub(crate) fn run() -> Result<()> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().cloned();
    if command.is_some() {
        args.remove(0);
    }
    let workspace = workspace_root(env::current_dir()?)?;
    match command.as_deref() {
        None => {
            if io::stdout().is_terminal() {
                run_ui(&[], &workspace)
            } else {
                let model = load_ui_view_model(&workspace, UiOptions::default())?;
                println!("{}", render_status_summary(&model));
                Ok(())
            }
        }
        Some("help") | Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some("ui") => run_ui(&args, &workspace),
        Some("split") => run_split(&args, &workspace),
        Some("tab") => run_tab(&args, &workspace),
        Some("status") => run_status(&args, &workspace),
        Some("capsules") => run_capsules(&args, &workspace),
        Some("capsule") => run_capsule(&args, &workspace),
        Some("events") => run_events(&args, &workspace),
        Some("probe") | Some("consult") | Some("inject") => {
            run_probe(&args, &workspace, command.as_deref().unwrap_or("probe"))
        }
        Some("judge") => run_judge(&args, &workspace),
        Some("pause") => run_pause(&args),
        Some("resume") => run_resume(&args),
        Some("mcp") => run_mcp(),
        Some("hook") => run_hook(&args),
        Some("plugin") => run_plugin(&args),
        Some("setup") => run_setup(&args, &workspace),
        Some("doctor") => run_doctor(&args, &workspace),
        Some("import-copilot") => run_import_copilot(&args, &workspace),
        Some("import-otel") => run_import_otel(&args, &workspace),
        Some("harvest") => run_harvest(&args, &workspace),
        Some("logs") => run_logs(&args, &workspace),
        Some("reset") => run_reset(&args, &workspace),
        Some("debug-bundle") => run_debug_bundle(&args, &workspace),
        Some("smoke") => run_smoke_command(&workspace),
        Some("ask") => run_ask(&args, &workspace),
        Some("json-hooks") => run_json_hooks(&args, &workspace),
        Some("copilot-tab") => run_copilot_tab(&args),
        Some("acp") | Some("sdk-extension") | Some("extension") => Err(anyhow!(
            "{:?} is not yet ported in the Rust binary",
            command.unwrap()
        )),
        Some(other) => Err(anyhow!("Unknown command: {other}")),
    }
}

fn print_help() {
    println!(
        "Agent Run Cache\n\nUsage:\n  arc\n  arc ui\n  arc split [--copilot-command \"<command>\"]\n  arc plugin install|status|path [--json]\n  arc setup [--sidecar-copilot-command \"<command>\"] [--enable-experimental]\n  arc mcp\n  arc hook copilot <Event>\n  arc status|capsules|events|probe --json\n  arc capsule <id> [--json]\n  arc capsules [set|delete|share|declined|promote] ... [--json]\n  arc pause [1h|2h|today|off] [--json]\n  arc resume [--json]\n  arc judge [status|models|decisions|reputation|set] [--json]\n  arc import-copilot <events.jsonl>\n  arc import-otel <otel.jsonl> [session-id]\n  arc harvest <copilot-session-id>\n  arc logs [--follow]\n  arc debug-bundle [out-dir]\n  arc ask [--runner opencode] <prompt>\n  arc reset --yes\n  arc smoke\n\nRun `arc split` for Copilot with a mouse-driven ARC pane beside it, `arc ui` for the standalone dashboard, or `/arc` inside Copilot after `/settings experimental on` for the in-session menu. Plain Copilot launches still use plugin hooks and MCP tools without the experimental flag.\n\nRust port note: plugin hooks, MCP, retrieval, judge ledger, capture/review, managed embeddings, UI, and long-tail inspection/debug commands are implemented. Legacy experimental acp/sdk-extension/copilot-tab surfaces are explicit demoted commands and are not part of the normal plugin flow."
    );
}
