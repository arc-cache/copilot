use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
enum ManagedEmbeddingState {
    Idle,
    DownloadingRuntime,
    DownloadingModel,
    Starting,
    Ready,
    Stopped,
    Error,
}

struct ManagedEmbeddingRuntime {
    state: ManagedEmbeddingState,
    detail: String,
    endpoint: Option<String>,
    child: Option<Child>,
}

static EMBEDDING_RUNTIME: OnceLock<Mutex<ManagedEmbeddingRuntime>> = OnceLock::new();

fn embedding_runtime() -> &'static Mutex<ManagedEmbeddingRuntime> {
    EMBEDDING_RUNTIME.get_or_init(|| {
        Mutex::new(ManagedEmbeddingRuntime {
            state: ManagedEmbeddingState::Idle,
            detail: "local embedding model not started".to_owned(),
            endpoint: None,
            child: None,
        })
    })
}

pub(crate) fn embed_texts(texts: &[String], workspace: &Path) -> Result<Option<Vec<Vec<f64>>>> {
    let input = texts
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();
    if input.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let endpoint = env::var("AGENT_RUN_CACHE_EMBEDDING_ENDPOINT")
        .or_else(|_| env::var("AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT"))
        .unwrap_or_default();
    let endpoint = endpoint.trim().to_owned();
    let base_url = if !endpoint.is_empty() {
        endpoint
    } else {
        match ensure_local_embeddings(workspace) {
            Ok(Some(endpoint)) => endpoint,
            Ok(None) => return Ok(None),
            Err(error) => {
                set_embedding_state(
                    ManagedEmbeddingState::Error,
                    format!(
                        "local embeddings unavailable: {}",
                        truncate_error(&error.to_string())
                    ),
                );
                debug(
                    workspace,
                    "local_embeddings.start_failed",
                    json!({ "error": error.to_string() }),
                )?;
                return Ok(None);
            }
        }
    };
    let url = format!("{}/embeddings", base_url.trim_end_matches('/'));
    let result = (|| -> Result<Vec<Vec<f64>>> {
        let response = ureq::post(&url)
            .timeout(Duration::from_millis(embedding_timeout_ms()))
            .set("content-type", "application/json")
            .send_json(json!({ "model": LOCAL_EMBEDDING_MODEL_NAME, "input": input }))?;
        let json: Value = response.into_json()?;
        let vectors = json["data"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .map(|item| {
                item["embedding"]
                    .as_array()
                    .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        if vectors.len() != input.len() || vectors.iter().any(Vec::is_empty) {
            return Err(anyhow!("embedding endpoint returned incomplete vectors"));
        }
        Ok(vectors)
    })();
    match result {
        Ok(vectors) => Ok(Some(vectors)),
        Err(error) => {
            debug(
                workspace,
                "local_embeddings.embed_failed",
                json!({ "error": error.to_string(), "count": input.len() }),
            )?;
            Ok(None)
        }
    }
}

fn ensure_local_embeddings(workspace: &Path) -> Result<Option<String>> {
    if !local_embeddings_wanted() {
        if let Ok(mut runtime) = embedding_runtime().lock() {
            if runtime.state == ManagedEmbeddingState::Idle {
                runtime.detail =
                    "managed local embeddings disabled for this configuration".to_owned();
            }
        }
        return Ok(None);
    }
    if let Some(endpoint) = embedding_endpoint_override() {
        return Ok(Some(endpoint));
    }
    if let Ok(runtime) = embedding_runtime().lock() {
        if runtime.state == ManagedEmbeddingState::Ready {
            if let Some(endpoint) = &runtime.endpoint {
                return Ok(Some(endpoint.clone()));
            }
        }
    }
    let binary = ensure_runtime_binary(workspace)?;
    let model = ensure_weights(workspace)?;
    let (endpoint, child) = start_embedding_server(&binary, &model, workspace)?;
    let mut runtime = embedding_runtime()
        .lock()
        .map_err(|_| anyhow!("embedding runtime lock poisoned"))?;
    runtime.state = ManagedEmbeddingState::Ready;
    runtime.detail = format!("{LOCAL_EMBEDDING_MODEL_NAME} ready");
    runtime.endpoint = Some(endpoint.clone());
    runtime.child = Some(child);
    Ok(Some(endpoint))
}

fn local_embeddings_wanted() -> bool {
    if embedding_endpoint_override().is_some() {
        return true;
    }
    let setting = env::var("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS")
        .or_else(|_| env::var("AGENT_RUN_CACHE_EMBEDDINGS"))
        .unwrap_or_else(|_| "auto".to_owned())
        .trim()
        .to_lowercase();
    if setting == "off" {
        return false;
    }
    if setting == "on" {
        return true;
    }
    total_memory_bytes() >= min_total_memory_bytes()
}

pub(crate) fn stop_local_embeddings() {
    let Ok(mut runtime) = embedding_runtime().lock() else {
        return;
    };
    if let Some(child) = runtime.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    runtime.child = None;
    runtime.endpoint = None;
    runtime.state = ManagedEmbeddingState::Stopped;
    runtime.detail = "local embedding model stopped".to_owned();
}

fn ensure_runtime_binary(workspace: &Path) -> Result<PathBuf> {
    let release = llama_release();
    let release_dir = runtime_dir().join(format!("llama-{release}"));
    if let Some(existing) = find_llama_server(&release_dir) {
        return Ok(existing);
    }
    set_embedding_state(
        ManagedEmbeddingState::DownloadingRuntime,
        format!("downloading llama.cpp {release}"),
    );
    debug(
        workspace,
        "local_embeddings.runtime_download_started",
        json!({ "release": release }),
    )?;
    fs::create_dir_all(&release_dir)?;
    let asset = platform_asset(&release)?;
    let url = format!("https://github.com/ggml-org/llama.cpp/releases/download/{release}/{asset}");
    let archive = release_dir.join(&asset);
    download_file(&url, &archive, None)?;
    let extract = Command::new("tar")
        .args([
            "-xf",
            &archive.to_string_lossy(),
            "-C",
            &release_dir.to_string_lossy(),
        ])
        .output()
        .context("failed to run tar for llama.cpp runtime")?;
    if !extract.status.success() {
        return Err(anyhow!(
            "failed to extract {asset}: {}",
            truncate_error(&String::from_utf8_lossy(&extract.stderr))
        ));
    }
    let _ = fs::remove_file(&archive);
    let binary = find_llama_server(&release_dir)
        .ok_or_else(|| anyhow!("llama-server not found in extracted {asset}"))?;
    debug(
        workspace,
        "local_embeddings.runtime_download_completed",
        json!({ "release": release, "binary": binary }),
    )?;
    Ok(binary)
}

fn ensure_weights(workspace: &Path) -> Result<PathBuf> {
    let file = embedding_model_file();
    let target = models_dir().join(&file);
    if target.exists() && fs::metadata(&target).map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(target);
    }
    set_embedding_state(
        ManagedEmbeddingState::DownloadingModel,
        format!("downloading {LOCAL_EMBEDDING_MODEL_NAME} (0%)"),
    );
    let url = embedding_model_url(&file);
    debug(
        workspace,
        "local_embeddings.model_download_started",
        json!({ "url": url }),
    )?;
    fs::create_dir_all(models_dir())?;
    download_file(
        &url,
        &target,
        Some(Box::new(|percent| {
            set_embedding_state(
                ManagedEmbeddingState::DownloadingModel,
                format!("downloading {LOCAL_EMBEDDING_MODEL_NAME} ({percent}%)"),
            );
        })),
    )?;
    debug(
        workspace,
        "local_embeddings.model_download_completed",
        json!({ "path": target }),
    )?;
    Ok(target)
}

fn start_embedding_server(
    binary: &Path,
    model_path: &Path,
    workspace: &Path,
) -> Result<(String, Child)> {
    set_embedding_state(
        ManagedEmbeddingState::Starting,
        format!("loading {LOCAL_EMBEDDING_MODEL_NAME}"),
    );
    let port = free_port()?;
    let started_at = now_millis();
    let mut child = Command::new(binary)
        .args([
            "--model",
            &model_path.to_string_lossy(),
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--ctx-size",
            "8192",
            "-ngl",
            "99",
            "--no-webui",
            "--embedding",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to start {}", binary.display()))?;
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 2048];
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut value) = tail.lock() {
                            value.push_str(&String::from_utf8_lossy(&buffer[..n]));
                            if value.len() > 4000 {
                                let start = value.len() - 4000;
                                *value = value[start..].to_owned();
                            }
                        }
                    }
                }
            }
        });
    }
    let endpoint = format!("http://127.0.0.1:{port}/v1");
    let health_url = format!("http://127.0.0.1:{port}/health");
    if !wait_for_health(&health_url, &mut child)? {
        let _ = child.kill();
        let stderr = stderr_tail
            .lock()
            .ok()
            .map(|v| v.clone())
            .unwrap_or_default();
        return Err(anyhow!(
            "llama-server did not become healthy: {}",
            truncate_error(&stderr)
        ));
    }
    debug(
        workspace,
        "local_embeddings.started",
        json!({ "port": port, "loadMs": now_millis().saturating_sub(started_at), "binary": binary }),
    )?;
    Ok((endpoint, child))
}

fn wait_for_health(url: &str, child: &mut Child) -> Result<bool> {
    let deadline = SystemTime::now() + Duration::from_millis(startup_timeout_ms());
    while SystemTime::now() < deadline {
        if child.try_wait()?.is_some() {
            return Ok(false);
        }
        if ureq::get(url)
            .timeout(Duration::from_millis(1000))
            .call()
            .is_ok_and(|response| response.status() < 400)
        {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(false)
}

pub(crate) fn download_file(
    url: &str,
    target: &Path,
    mut on_percent: Option<Box<dyn FnMut(u64)>>,
) -> Result<()> {
    let attempts = env_number("AGENT_RUN_CACHE_DOWNLOAD_ATTEMPTS", 3.0).max(1.0) as usize;
    let mut last_error: Option<anyhow::Error> = None;
    for _ in 0..attempts {
        match download_file_once(url, target, &mut on_percent) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("download failed for {url}")))
}

fn download_file_once(
    url: &str,
    target: &Path,
    on_percent: &mut Option<Box<dyn FnMut(u64)>>,
) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = target.with_extension("part");
    let _ = fs::remove_file(&partial);
    let response = ureq::get(url)
        .timeout(Duration::from_millis(download_stall_timeout_ms()))
        .call()
        .with_context(|| format!("download failed for {url}"))?;
    if response.status() >= 400 {
        return Err(anyhow!(
            "download failed with {} for {url}",
            response.status()
        ));
    }
    let total = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = response.into_reader();
    let mut writer = fs::File::create(&partial)?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut received = 0_u64;
    let mut last_percent = u64::MAX;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        received += read as u64;
        if total > 0 {
            let percent = ((received as f64 / total as f64) * 100.0).floor() as u64;
            if percent != last_percent {
                last_percent = percent;
                if let Some(callback) = on_percent.as_mut() {
                    callback(percent);
                }
            }
        }
    }
    fs::rename(&partial, target)?;
    Ok(())
}

fn find_llama_server(dir: &Path) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let mut queue = vec![dir.to_path_buf()];
    while let Some(current) = queue.pop() {
        let Ok(entries) = fs::read_dir(current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push(path);
            } else if entry.file_name().to_string_lossy() == name {
                return Some(path);
            }
        }
    }
    None
}

fn platform_asset(release: &str) -> Result<String> {
    let arch = if env::consts::ARCH == "aarch64" || env::consts::ARCH == "arm64" {
        "arm64"
    } else {
        "x64"
    };
    match env::consts::OS {
        "macos" => Ok(format!("llama-{release}-bin-macos-{arch}.tar.gz")),
        "linux" => Ok(format!("llama-{release}-bin-ubuntu-{arch}.tar.gz")),
        "windows" => Ok(format!("llama-{release}-bin-win-cpu-{arch}.zip")),
        other => Err(anyhow!("no prebuilt llama.cpp asset for platform {other}")),
    }
}

fn free_port() -> Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn embedding_endpoint_override() -> Option<String> {
    env::var("AGENT_RUN_CACHE_EMBEDDING_ENDPOINT")
        .or_else(|_| env::var("AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn set_embedding_state(state: ManagedEmbeddingState, detail: String) {
    if let Ok(mut runtime) = embedding_runtime().lock() {
        runtime.state = state;
        runtime.detail = detail;
    }
}

fn models_dir() -> PathBuf {
    env::var("AGENT_RUN_CACHE_MODELS_DIR")
        .map(PathBuf::from)
        .map(absolutize)
        .unwrap_or_else(|_| home_dir().join(".agent-run-cache/models"))
}

fn runtime_dir() -> PathBuf {
    env::var("AGENT_RUN_CACHE_RUNTIME_DIR")
        .map(PathBuf::from)
        .map(absolutize)
        .unwrap_or_else(|_| home_dir().join(".agent-run-cache/runtime"))
}

fn llama_release() -> String {
    env::var("AGENT_RUN_CACHE_LLAMA_RELEASE").unwrap_or_else(|_| DEFAULT_LLAMA_RELEASE.to_owned())
}

fn embedding_model_file() -> String {
    env::var("AGENT_RUN_CACHE_EMBEDDING_MODEL_FILE")
        .unwrap_or_else(|_| DEFAULT_EMBEDDING_MODEL_FILE.to_owned())
}

fn embedding_model_url(file: &str) -> String {
    env::var("AGENT_RUN_CACHE_EMBEDDING_MODEL_URL").unwrap_or_else(|_| {
        format!("https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/{file}")
    })
}

fn startup_timeout_ms() -> u64 {
    env_number("AGENT_RUN_CACHE_EMBEDDING_STARTUP_TIMEOUT_MS", 120_000.0).max(1.0) as u64
}

fn min_total_memory_bytes() -> u64 {
    let gb = env::var("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS_MIN_TOTAL_MEM_GB")
        .or_else(|_| env::var("AGENT_RUN_CACHE_EMBEDDING_MIN_TOTAL_MEM_GB"))
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(8.0);
    (gb * 1024.0 * 1024.0 * 1024.0) as u64
}

fn total_memory_bytes() -> u64 {
    sysinfo::System::new_all().total_memory()
}

fn download_stall_timeout_ms() -> u64 {
    env_number("AGENT_RUN_CACHE_DOWNLOAD_STALL_TIMEOUT_MS", 30_000.0).max(1.0) as u64
}

fn truncate_error(error: &str) -> String {
    truncate(error, 300)
}
