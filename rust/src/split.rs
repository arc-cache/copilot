use super::*;

const ZELLIJ_APPLIANCE_VERSION: &str = "0.44.3-arc-appliance.1";
const SPLIT_CONFIG: &str = include_str!("../../assets/zellij/config.kdl");
const SPLIT_LAYOUT: &str = include_str!("../../assets/zellij/arc-split.kdl");
#[cfg(test)]
const ZELLIJ_APPLIANCE_PATCH: &str =
    include_str!("../../patches/zellij-0.44.3-arc-appliance.patch");

pub(crate) fn run_split(args: &[String], workspace: &Path) -> Result<()> {
    if cfg!(windows) {
        return run_windows_split(args, workspace);
    }
    if env::var_os("ZELLIJ").is_some() {
        return Err(anyhow!(
            "arc split cannot start inside an existing zellij session; detach first, then run arc split"
        ));
    }

    let copilot_command = split_copilot_command(args)?;
    let zellij = ensure_zellij()?;
    let arc = env::current_exe().context("could not locate the running arc binary")?;
    let generated_dir = arc_home().join("split");
    fs::create_dir_all(&generated_dir)?;
    let config = generated_dir.join("config.kdl");
    let layout = generated_dir.join(format!("{}.kdl", workspace_key(workspace)));
    write_generated_file(&config, SPLIT_CONFIG)?;
    write_generated_file(
        &layout,
        &SPLIT_LAYOUT
            .replace("{{COPILOT_COMMAND}}", &kdl_escape(&copilot_command))
            .replace("{{WORKSPACE}}", &kdl_escape(&workspace.to_string_lossy()))
            .replace("{{ARC_BIN}}", &kdl_escape(&shell_squote(&arc.to_string_lossy())))
            .replace(
                "{{ZELLIJ_BIN}}",
                &kdl_escape(&shell_squote(&zellij.to_string_lossy())),
            ),
    )?;

    let status = Command::new(&zellij)
        .args([
            "--config",
            &config.to_string_lossy(),
            "--new-session-with-layout",
            &layout.to_string_lossy(),
        ])
        .env("ARC_ZELLIJ_APPLIANCE", "1")
        .current_dir(workspace)
        .status()
        .with_context(|| format!("failed to start bundled zellij at {}", zellij.display()))?;
    // Exiting Copilot (or quitting the ARC pane) closes the split via
    // `zellij action close-tab`, which kills the panes before Copilot can fire
    // its SessionEnd hook. Harvest the session that just ran so the trace is
    // captured instead of relying on a hook that never arrives. Run it detached
    // so the review pipeline (judge/embeddings) can't block the shell after
    // zellij exits.
    let spawned = Command::new(&arc)
        .args(["harvest", "--latest"])
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let _ = debug(
        workspace,
        "split.harvest_spawned",
        serde_json::json!({ "ok": spawned.is_ok() }),
    );
    if !status.success() {
        return Err(anyhow!(
            "zellij exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

fn split_copilot_command(args: &[String]) -> Result<String> {
    assert_known_flags(args, &["--copilot-command"])?;
    if args.iter().any(|arg| arg == "--copilot-command")
        && option_value(args, "--copilot-command").is_none()
    {
        return Err(anyhow!("Missing value for --copilot-command"));
    }
    Ok(option_value(args, "--copilot-command")
        .map(str::to_owned)
        .or_else(|| env::var("AGENT_RUN_CACHE_SPLIT_COPILOT_COMMAND").ok())
        .or_else(|| {
            load_arc_config()
                .ok()
                .and_then(|config| config.sidecar_copilot_command)
        })
        .unwrap_or_else(|| "copilot".to_owned()))
}

fn ensure_zellij() -> Result<PathBuf> {
    if let Some(path) = env::var_os("AGENT_RUN_CACHE_ZELLIJ_BIN").map(PathBuf::from) {
        return compatible_zellij(path, "AGENT_RUN_CACHE_ZELLIJ_BIN");
    }
    if let Some(path) = packaged_zellij() {
        return compatible_zellij(path, "the ARC package");
    }

    Err(anyhow!(
        "arc split requires bundled Zellij {ZELLIJ_APPLIANCE_VERSION}; run `npm rebuild arc-copilot` or build it with `node scripts/build-zellij-appliance.cjs`"
    ))
}

pub(crate) fn cached_zellij() -> Option<PathBuf> {
    env::var_os("AGENT_RUN_CACHE_ZELLIJ_BIN")
        .map(PathBuf::from)
        .filter(|path| is_compatible_zellij(path))
        .or_else(|| packaged_zellij().filter(|path| is_compatible_zellij(path)))
}

fn packaged_zellij() -> Option<PathBuf> {
    let current = env::current_exe().ok()?;
    packaged_zellij_for(&current)
}

fn packaged_zellij_for(current: &Path) -> Option<PathBuf> {
    let sibling = current.parent()?.join("zellij");
    if sibling.is_file() {
        return Some(sibling);
    }
    let resolved = fs::canonicalize(current).ok()?;
    let sibling = resolved.parent()?.join("zellij");
    sibling.is_file().then_some(sibling)
}

fn compatible_zellij(path: PathBuf, source: &str) -> Result<PathBuf> {
    if !path.is_file() {
        return Err(anyhow!(
            "{source} does not point to a file: {}",
            path.display()
        ));
    }
    let output = Command::new(&path)
        .arg("--version")
        .output()
        .with_context(|| format!("could not inspect zellij at {}", path.display()))?;
    let version = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() || !is_appliance_version(&version) {
        return Err(anyhow!(
            "{source} contains an incompatible zellij at {}; ARC requires {ZELLIJ_APPLIANCE_VERSION}",
            path.display()
        ));
    }
    Ok(path)
}

fn is_compatible_zellij(path: &Path) -> bool {
    compatible_zellij(path.to_path_buf(), "candidate").is_ok()
}

fn is_appliance_version(version: &str) -> bool {
    version.contains(ZELLIJ_APPLIANCE_VERSION)
}

fn kdl_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// Wrap a value in single quotes for safe embedding in a `/bin/sh -lc` string,
/// so binary paths containing spaces don't get word-split.
fn shell_squote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_generated_file(path: &Path, value: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temp, value)?;
    fs::rename(&temp, path)?;
    Ok(())
}

#[cfg(windows)]
fn run_windows_split(args: &[String], workspace: &Path) -> Result<()> {
    let copilot_command = split_copilot_command(args)?;
    let arc = env::current_exe().context("could not locate the running arc binary")?;
    let status = Command::new("wt.exe")
        .args([
            "-w",
            "0",
            "new-tab",
            "--title",
            "Copilot",
            "-d",
            &workspace.to_string_lossy(),
            "cmd.exe",
            "/C",
            &copilot_command,
            ";",
            "split-pane",
            "--title",
            "ARC",
            "-V",
            "-s",
            "0.30",
            "-d",
            &workspace.to_string_lossy(),
            &arc.to_string_lossy(),
            "ui",
        ])
        .status()
        .context(
            "Windows fallback requires Windows Terminal (wt.exe); run `arc ui` in a separate terminal if it is unavailable",
        )?;
    if !status.success() {
        return Err(anyhow!(
            "Windows Terminal split fallback exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn run_windows_split(_args: &[String], _workspace: &Path) -> Result<()> {
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kdl_values_are_escaped() {
        assert_eq!(kdl_escape("a\\b\"c\nnext"), "a\\\\b\\\"c\\nnext");
    }

    #[test]
    fn split_assets_define_a_locked_mouse_appliance() {
        assert!(SPLIT_CONFIG.contains("default_mode \"locked\""));
        assert!(SPLIT_CONFIG.contains("keybinds clear-defaults=true"));
        assert_eq!(SPLIT_CONFIG.matches("bind \"").count(), 1);
        assert!(SPLIT_CONFIG.contains("bind \"Ctrl q\" { Quit; }"));
        assert!(SPLIT_CONFIG.contains("mouse_mode true"));
        assert!(SPLIT_CONFIG.contains("mouse_click_through true"));
        assert!(SPLIT_CONFIG.contains("advanced_mouse_actions true"));
        assert!(SPLIT_CONFIG.contains("mouse_hover_effects false"));
        assert!(SPLIT_CONFIG.contains("copy_clipboard \"system\""));
        assert!(SPLIT_CONFIG.contains("pane_frames true"));
        assert!(SPLIT_CONFIG.contains("theme \"arc-appliance\""));
        assert!(SPLIT_CONFIG.contains("frame_unselected"));
        assert!(SPLIT_CONFIG.contains("frame_selected"));
        assert!(SPLIT_CONFIG.contains("load_plugins {}"));
        for forbidden in [
            "SwitchToMode",
            "NewPane",
            "NewTab",
            "CloseFocus",
            "CloseTab",
            "ToggleFocusFullscreen",
            "ToggleFloatingPanes",
            "MovePane",
        ] {
            assert!(!SPLIT_CONFIG.contains(forbidden));
        }
        for plugin in ["status-bar", "tab-bar", "compact-bar"] {
            assert!(!SPLIT_LAYOUT.contains(plugin));
        }
        assert!(!SPLIT_LAYOUT.contains("plugin location="));
        assert!(SPLIT_LAYOUT.contains("ARC_SPLIT_APPLIANCE=1"));
        // Only the Copilot pane closes the split: exiting Copilot closes the
        // whole tab (ARC pane included). The ARC pane is a companion viewer with
        // no independent close, so a stray keystroke can't kill the split.
        assert_eq!(SPLIT_LAYOUT.matches("{{ZELLIJ_BIN}} action close-tab").count(), 1);
        assert!(ZELLIJ_APPLIANCE_PATCH.contains("ARC_ZELLIJ_APPLIANCE"));
        assert!(ZELLIJ_APPLIANCE_PATCH.contains(ZELLIJ_APPLIANCE_VERSION));
    }

    #[test]
    fn split_keeps_copilot_in_the_users_workspace_and_state_home() {
        assert_eq!(SPLIT_LAYOUT.matches("cwd \"{{WORKSPACE}}\"").count(), 2);
        for isolated_home in ["COPILOT_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] {
            assert!(
                !SPLIT_LAYOUT.contains(isolated_home),
                "the interactive Copilot pane must retain the user's {isolated_home}"
            );
        }
    }

    #[test]
    fn only_the_arc_appliance_zellij_version_is_accepted() {
        assert!(is_appliance_version("zellij 0.44.3-arc-appliance.1\n"));
        assert!(!is_appliance_version("zellij 0.44.3\n"));
    }

    #[cfg(unix)]
    #[test]
    fn packaged_zellij_follows_the_global_arc_symlink() {
        use std::os::unix::fs::symlink;

        let root = env::temp_dir().join(format!("arc-zellij-symlink-{}", std::process::id()));
        let package_bin = root.join("package/bin");
        let global_bin = root.join("global/bin");
        fs::create_dir_all(&package_bin).unwrap();
        fs::create_dir_all(&global_bin).unwrap();
        fs::write(package_bin.join("arc"), "").unwrap();
        fs::write(package_bin.join("zellij"), "").unwrap();
        symlink(package_bin.join("arc"), global_bin.join("arc")).unwrap();

        assert_eq!(
            packaged_zellij_for(&global_bin.join("arc")),
            Some(fs::canonicalize(package_bin.join("zellij")).unwrap())
        );

        fs::remove_dir_all(root).unwrap();
    }
}
