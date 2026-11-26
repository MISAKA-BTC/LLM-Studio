//! Strata Metal's native engines, behind its upstream OpenAI server.
//! Only a prepared profile's exact native model is routed here. Dense GGUFs and
//! unrelated MoE architectures never acquire SSD support just by choosing a backend.
use super::openai_child::{ChildEngine, ChildEngineConfig};
use super::{Availability, GenerationRequest, InferenceBackend, LoadRequest, LoadedModel, StreamEvent};
use crate::{Error, Result};
use futures_util::{future::BoxFuture, stream::BoxStream};
use misaka_studio_core::{
    hardware::HardwareSnapshot,
    model::{FitVerdict, LocalModel, ModelSource},
    provenance::RuntimeDescriptor,
    settings::{Settings, StrataSettings},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const BRIDGE: &str = include_str!("../../../../sidecars/strata/bridge.py");
const INKLING_ARCH: &str = "inkling2_loop";
// Default directory used by scripts/install-strata.py.
pub(crate) const MANAGED_INSTALL: &str = "engines/strata/c62d5e3a15b4";

#[derive(Deserialize)]
struct Profile {
    exe: PathBuf,
    cwd: Option<PathBuf>,
    tokenizer: PathBuf,
    backend: String,
    arch: Option<String>,
    args: Vec<String>,
}

pub struct PreparedProfile {
    pub path: PathBuf,
    pub root: PathBuf,
    pub native: PathBuf,
    pub exe: PathBuf,
    pub inkling: bool,
}

impl PreparedProfile {
    pub fn read(path: &Path) -> Result<Self> {
        let path = path.canonicalize().map_err(|e| Error::io(path.display(), e))?;
        let text = std::fs::read_to_string(&path).map_err(|e| Error::io(path.display(), e))?;
        let cfg: Profile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|e| Error::bad_request(format!("Invalid Strata profile: {e}")))?;
        if cfg.backend != "metal" {
            return Err(Error::bad_request("Strata currently requires a prepared Metal profile"));
        }
        let parent = path.parent().expect("canonical file has parent");
        let cwd = cfg.cwd.unwrap_or_else(|| parent.to_path_buf());
        let root = if cwd.is_absolute() { cwd } else { parent.join(cwd) };
        let resolve = |p: &Path| -> Result<PathBuf> {
            let p = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
            p.canonicalize().map_err(|e| Error::io(p.display(), e))
        };
        let exe = resolve(&cfg.exe)?;
        if !exe.is_file() || !root.join("serve/server.py").is_file() {
            return Err(Error::bad_request("Strata engine or serve/server.py is missing; prepare the upstream installation first"));
        }
        resolve(&cfg.tokenizer)?;
        let value = |flag: &str| -> Result<PathBuf> {
            let matches: Vec<_> = cfg.args.iter().enumerate().filter(|(_, arg)| arg.as_str() == flag).collect();
            if matches.len() != 1 {
                return Err(Error::bad_request(format!("Strata profile requires exactly one {flag}")));
            }
            let v = cfg
                .args
                .get(matches[0].0 + 1)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| Error::bad_request(format!("Missing Strata {flag} value")))?;
            resolve(Path::new(v))
        };
        let native = value("--native")?;
        let inkling = cfg.arch.as_deref() == Some(INKLING_ARCH);
        if inkling {
            inspect_inkling_pack(&native, Default::default())?;
        } else {
            value("--pack")?;
            value("--ple-gguf")?;
            let model = LocalModel::inspect(&native, Default::default())?;
            if model.expert_count.unwrap_or(0) == 0 {
                return Err(Error::bad_request("Strata SSD streaming requires a prepared MoE model; this GGUF has no experts"));
            }
        }
        Ok(Self { path, root, native, exe, inkling })
    }

    pub fn matches(&self, model: &LocalModel) -> bool {
        model.path.canonicalize().is_ok_and(|p| p == self.native)
    }
}

pub(crate) fn is_inkling_pack(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("strata"))
}

pub(crate) fn inspect_inkling_pack(path: &Path, source: ModelSource) -> Result<LocalModel> {
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|_| is_inkling_pack(path))
        .ok_or_else(|| Error::bad_request("Select a prepared Inkling .strata model pack"))?;
    let mut file = std::fs::File::open(path).map_err(|e| Error::io(path.display(), e))?;
    let meta = file.metadata().map_err(|e| Error::io(path.display(), e))?;
    let mut header = [0; 24];
    file.read_exact(&mut header).map_err(|e| Error::io(path.display(), e))?;
    // Official packs can append metadata after the extent declared in the v1.1 header.
    let declared_size = u64::from_le_bytes(header[16..24].try_into().expect("eight-byte size"));
    if &header[..12] != b"STRATA\0\x01\x01\0\0\0" || !(header.len() as u64..=meta.len()).contains(&declared_size) {
        return Err(Error::bad_request("Inkling .strata pack is incomplete or has an unsupported header"));
    }
    Ok(LocalModel {
        id: name.into(),
        name: name.into(),
        path: path.to_path_buf(),
        size_bytes: meta.len(),
        quantization: None,
        architecture: Some(INKLING_ARCH.into()),
        parameter_count: None,
        context_length: None,
        block_count: None,
        expert_count: None,
        kv_cache_bytes_per_token: None,
        has_chat_template: false,
        source,
        sha256: None,
        modified_at: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
    })
}

pub(crate) fn discover_managed_profile(data_dir: &Path) -> Option<PathBuf> {
    let root = data_dir.join(MANAGED_INSTALL).canonicalize().ok()?;
    let exe = root.join("build-metal/strata");
    if !exe.is_file() || exe.canonicalize().ok()? != exe {
        return None;
    }
    let mut profiles = std::fs::read_dir(&root)
        .ok()?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| entry.file_name().to_str().is_some_and(|name| name.starts_with("strata-") && name.ends_with(".json")))
        .filter_map(|entry| PreparedProfile::read(&entry.path()).ok())
        .filter(|profile| profile.exe == exe && profile.root.canonicalize().is_ok_and(|path| path == root));
    let profile = profiles.next()?;
    // When multiple packs are present let the user choose which model to register.
    profiles.next().is_none().then_some(profile.path)
}

pub fn validate_settings(settings: &StrataSettings, hardware: &HardwareSnapshot) -> Result<()> {
    if !(1..=16).contains(&settings.io_threads) || settings.prefetch_experts > 32 {
        return Err(Error::bad_request("Strata SSD readers must be 1–16; prefetch experts must be 0–32"));
    }
    if let Some(gb) = settings.arena_gb {
        // The arena is only the expert cache. Dense tensors, KV, staging and macOS
        // still need memory. Explicit upstream budgets otherwise bypass adaptive shrinking.
        let max = hardware.total_memory.saturating_sub(15_000_000_000) / 1_000_000_000;
        if gb == 0 || u64::from(gb) > max {
            return Err(Error::bad_request(format!("Strata cache must be 1–{max} decimal GB on this machine, or Auto")));
        }
    }
    Ok(())
}

/// Read routing identity independently of readiness. A missing companion must report
/// a Strata preflight error, rather than silently sending this model to llama.cpp.
pub fn native_path(path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    let cfg: Profile = serde_json::from_str(std::fs::read_to_string(&path).ok()?.trim_start_matches('\u{feff}')).ok()?;
    let parent = path.parent()?;
    let cwd = cfg.cwd.unwrap_or_else(|| parent.to_path_buf());
    let root = if cwd.is_absolute() { cwd } else { parent.join(cwd) };
    let i = cfg.args.iter().position(|a| a == "--native")?;
    let native = Path::new(cfg.args.get(i + 1)?);
    (if native.is_absolute() { native.to_path_buf() } else { root.join(native) }).canonicalize().ok()
}

pub fn model_roots(settings: &Settings) -> Vec<PathBuf> {
    let mut roots = vec![settings.models_dir.clone()];
    if let Some(p) = settings.backend.strata.config_path.as_deref().and_then(native_path) {
        roots.push(p);
    }
    roots
}

pub fn configured_for(settings: &StrataSettings, model: &LocalModel) -> bool {
    settings.config_path.as_deref().and_then(native_path).is_some_and(|p| model.path.canonicalize().ok().as_ref() == Some(&p))
}

pub fn streaming_fit(settings: &StrataSettings, hardware: &HardwareSnapshot) -> FitVerdict {
    if hardware.total_memory < 16 * (1 << 30) {
        FitVerdict::DoesNotFit { needed_bytes: 16 * (1 << 30), available_bytes: hardware.total_memory }
    } else {
        FitVerdict::SsdStreaming { cache_budget_bytes: settings.arena_gb.map(|gb| u64::from(gb) * 1_000_000_000) }
    }
}

pub struct StrataBackend {
    settings: StrataSettings,
    hardware: HardwareSnapshot,
    engine: ChildEngine,
    readiness: tokio::sync::Mutex<Option<(Instant, Availability)>>,
}

impl StrataBackend {
    pub fn new(settings: StrataSettings, hardware: HardwareSnapshot, timeout: Duration) -> Self {
        let profile = settings.config_path.as_deref().and_then(|p| PreparedProfile::read(p).ok());
        let python = settings
            .python_path
            .clone()
            .or_else(|| {
                let root = &profile.as_ref()?.root;
                [root.join("python/bin/python"), root.join(".venv/bin/python")].into_iter().find(|path| path.is_file())
            })
            .unwrap_or_else(|| "python3".into());
        let options = settings.clone();
        Self {
            settings,
            hardware,
            readiness: tokio::sync::Mutex::new(None),
            engine: ChildEngine::new(ChildEngineConfig {
                name: "strata",
                program: python,
                args: Box::new(move |request, port| bridge_args(&options, request.context_size, port)),
                health_path: "/health",
                context_from_health: Some(|v| u32::try_from(v.get("max_context")?.as_u64()?).ok()),
                startup_timeout: timeout,
                env: vec![("PYTHONUNBUFFERED".into(), "1".into())],
                offload_from_log: None,
            }),
        }
    }

    fn profile(&self) -> Result<PreparedProfile> {
        let path = self.settings.config_path.as_deref().ok_or_else(|| {
            Error::bad_request("Prepare a Strata model in the default installation or choose its profile in Settings → Backend")
        })?;
        validate_settings(&self.settings, &self.hardware)?;
        PreparedProfile::read(path)
    }
}

fn bridge_args(settings: &StrataSettings, context: u32, port: u16) -> Vec<String> {
    let mut args = vec![
        "-c".into(),
        BRIDGE.into(),
        "--profile".into(),
        settings
            .config_path
            .as_ref()
            .map(|p| p.canonicalize().unwrap_or_else(|_| p.clone()).display().to_string())
            .unwrap_or_default(),
        "--context".into(),
        context.to_string(),
        "--port".into(),
        port.to_string(),
        "--io-threads".into(),
        settings.io_threads.to_string(),
        "--prefetch".into(),
        settings.prefetch_experts.to_string(),
    ];
    if let Some(gb) = settings.arena_gb {
        args.extend(["--arena-gb".into(), gb.to_string()]);
    }
    args
}

impl InferenceBackend for StrataBackend {
    fn name(&self) -> &'static str {
        "strata"
    }
    fn descriptor(&self) -> BoxFuture<'_, RuntimeDescriptor> {
        Box::pin(async move {
            // Fingerprint the actual native engine and profile, never Python's version.
            let profile = self.profile().ok();
            let engine = if profile.as_ref().is_some_and(|p| p.inkling) { "inkling" } else { "ssd" };
            let fingerprint = profile
                .and_then(|p| {
                    let mut h = Sha256::new();
                    h.update(BRIDGE.as_bytes());
                    h.update(std::fs::read(p.exe).ok()?);
                    h.update(std::fs::read(p.path).ok()?);
                    h.update(serde_json::to_vec(&self.settings).ok()?);
                    Some(hex::encode(h.finalize()))
                })
                .unwrap_or_else(|| "unknown".into());
            RuntimeDescriptor {
                backend: "strata".into(),
                engine_commit: "unknown".into(),
                engine_patch_sha256: "unknown".into(),
                engine_build_number: 0,
                build_profile: format!("{}-{}-metal-{engine}:{fingerprint}", std::env::consts::OS, std::env::consts::ARCH),
                class_tag: format!("strata-metal-{engine}-nonconsensus"),
            }
        })
    }
    fn availability(&self) -> BoxFuture<'_, Availability> {
        Box::pin(async move {
            let mut cache = self.readiness.lock().await;
            if let Some((when, value)) = cache.as_ref()
                && when.elapsed() < Duration::from_secs(60)
            {
                return value.clone();
            }
            let remedy =
                "Prepare Strata on Apple Silicon/macOS 15+, then set its strata-<model>.json and Python interpreter in Settings.";
            if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                return Availability::Unavailable {
                    reason: "Strata SSD backend requires Apple Silicon".into(),
                    remedy: remedy.into(),
                };
            }
            let profile = match self.profile() {
                Ok(profile) => profile,
                Err(e) => return Availability::Unavailable { reason: e.to_string(), remedy: remedy.into() },
            };
            let mut args = bridge_args(&self.settings, 8192, 0);
            args.push("--check".into());
            let result = match tokio::time::timeout(
                Duration::from_secs(15),
                tokio::process::Command::new(self.engine.program()).args(args).kill_on_drop(true).output(),
            )
            .await
            {
                Ok(Ok(out)) if out.status.success() => {
                    let model = if profile.inkling { "Inkling" } else { "SSD expert paging" };
                    Availability::Available { detail: format!("Strata Metal · {model} · loopback server") }
                }
                Ok(Ok(out)) => Availability::Unavailable {
                    reason: String::from_utf8_lossy(&out.stderr).chars().rev().take(1500).collect::<String>().chars().rev().collect(),
                    remedy: remedy.into(),
                },
                _ => Availability::Unavailable { reason: "Strata Python preflight failed or timed out".into(), remedy: remedy.into() },
            };
            *cache = Some((Instant::now(), result.clone()));
            result
        })
    }
    fn load(&self, request: LoadRequest) -> BoxFuture<'_, Result<LoadedModel>> {
        Box::pin(async move {
            let p = self.profile()?;
            if request.model_path.canonicalize().ok().as_ref() != Some(&p.native) {
                return Err(Error::bad_request("This model is not the native model in the prepared Strata profile"));
            }
            if self.hardware.total_memory < 16 * (1 << 30) {
                return Err(Error::bad_request("Strata streaming requires at least 16 GiB of unified memory"));
            }
            self.engine.load(request).await
        })
    }
    fn unload(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.engine.unload().await })
    }
    fn loaded(&self) -> BoxFuture<'_, Option<LoadedModel>> {
        Box::pin(async move { self.engine.loaded().await })
    }
    fn generate(&self, request: GenerationRequest) -> BoxFuture<'_, Result<BoxStream<'static, Result<StreamEvent>>>> {
        Box::pin(async move { self.engine.generate(request).await })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use futures_util::StreamExt;
    use misaka_studio_core::provenance::SamplingCommitment;

    pub(crate) fn fixture(root: &Path, experts: u32) -> PathBuf {
        std::fs::create_dir_all(root.join("serve")).unwrap();
        std::fs::create_dir_all(root.join("pack/tokenizer")).unwrap();
        std::fs::write(root.join("strata"), "fixture engine").unwrap();
        std::fs::write(root.join("ple.gguf"), "fixture companion").unwrap();
        std::fs::write(root.join("serve/server.py"), "# fixture server").unwrap();
        let mut gguf = b"GGUF".to_vec();
        gguf.extend(3u32.to_le_bytes());
        gguf.extend(0u64.to_le_bytes());
        gguf.extend(2u64.to_le_bytes());
        let mut kv = |key: &str, ty: u32, value: &[u8]| {
            gguf.extend((key.len() as u64).to_le_bytes());
            gguf.extend(key.as_bytes());
            gguf.extend(ty.to_le_bytes());
            gguf.extend(value);
        };
        let mut arch = 9u64.to_le_bytes().to_vec();
        arch.extend(b"qwen3next");
        kv("general.architecture", 8, &arch);
        kv("qwen3next.expert_count", 4, &experts.to_le_bytes());
        std::fs::write(root.join("native.gguf"), gguf).unwrap();
        let path = root.join("strata-test.json");
        std::fs::write(&path, serde_json::to_vec(&serde_json::json!({"exe":"strata", "cwd":".", "tokenizer":"pack/tokenizer", "backend":"metal", "args":["--native","native.gguf","--pack","pack","--ple-gguf","ple.gguf"]})).unwrap()).unwrap();
        path
    }

    fn hardware() -> HardwareSnapshot {
        let mut h = HardwareSnapshot::probe();
        h.total_memory = 24 * (1 << 30);
        h.available_memory = 12 * (1 << 30);
        h
    }

    #[tokio::test]
    async fn inkling_pack_is_registered_through_its_profile() {
        let dir = tempfile::tempdir().unwrap();
        let profile = fixture(dir.path(), 512);
        let path = dir.path().join("Inkling-2-Mini-SQ-10.strata");
        let mut header = [0u8; 80];
        header[..12].copy_from_slice(b"STRATA\0\x01\x01\0\0\0");
        header[16..24].copy_from_slice(&64u64.to_le_bytes());
        std::fs::write(&path, header).unwrap();
        std::fs::write(
            &profile,
            serde_json::to_vec(&serde_json::json!({
                "exe": "strata", "cwd": ".", "tokenizer": "pack/tokenizer", "backend": "metal",
                "arch": "inkling2_loop", "args": ["--native", "Inkling-2-Mini-SQ-10.strata"]
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(PreparedProfile::read(&profile).unwrap().inkling);
        let mut settings = Settings { models_dir: dir.path().join("models"), ..Default::default() };
        settings.backend.strata.config_path = Some(profile.clone());
        let store = crate::store::ModelStore::new(model_roots(&settings));
        let models = store.refresh().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "Inkling-2-Mini-SQ-10");
        assert!(configured_for(&settings.backend.strata, &models[0]));
        std::fs::write(&path, &header[..32]).unwrap();
        assert!(PreparedProfile::read(&profile).is_err());
    }

    #[tokio::test]
    async fn registers_only_native_file_and_keeps_routing_on_missing_companion() {
        let dir = tempfile::tempdir().unwrap();
        let profile = fixture(dir.path(), 512);
        let mut settings = Settings { models_dir: dir.path().join("empty-models"), ..Default::default() };
        settings.backend.strata.config_path = Some(profile.clone());
        let store = crate::store::ModelStore::new(model_roots(&settings));
        let models = store.refresh().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].expert_count, Some(512));
        assert!(configured_for(&settings.backend.strata, &models[0]));
        std::fs::remove_file(dir.path().join("ple.gguf")).unwrap();
        assert!(PreparedProfile::read(&profile).is_err());
        assert!(configured_for(&settings.backend.strata, &models[0]));
    }

    #[test]
    fn rejects_dense_profile_and_bounds_cache_without_requiring_all_weights_in_ram() {
        let dir = tempfile::tempdir().unwrap();
        let profile = fixture(dir.path(), 0);
        assert!(PreparedProfile::read(&profile).err().unwrap().to_string().contains("no experts"));
        let mut s = StrataSettings { arena_gb: Some(90), ..Default::default() };
        assert!(validate_settings(&s, &hardware()).is_err());
        s.arena_gb = Some(6);
        assert!(validate_settings(&s, &hardware()).is_ok());
        assert!(matches!(streaming_fit(&s, &hardware()), FitVerdict::SsdStreaming { cache_budget_bytes: Some(6_000_000_000) }));
        s.io_threads = 0;
        assert!(validate_settings(&s, &hardware()).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervises_real_http_child_applies_paging_settings_and_stops_it() {
        let dir = tempfile::tempdir().unwrap();
        let profile = fixture(dir.path(), 512);
        // This server is an API contract fixture, not a simulated successful model benchmark.
        std::fs::write(dir.path().join("serve/server.py"), r#"
import argparse, json, os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
if __name__ == '__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('--config'); ap.add_argument('--port',type=int); ap.add_argument('--engine'); ap.add_argument('--host'); ap.add_argument('--parallel')
    a=ap.parse_args()
    cfg=json.loads(Path(a.config).read_text())
    assert cfg['host']=='127.0.0.1' and os.environ['STRATA_METAL_STREAM']=='1'
    assert cfg['env']['STRATA_METAL_ARENA_GB']=='6' and cfg['env']['STRATA_METAL_PREFETCH']=='2'
    Path(cfg['cwd'],'observed.json').write_text(json.dumps(dict(port=a.port,config=cfg)))
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"loaded":true,"max_context":4096}')
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"paging fixture"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    HTTPServer((a.host,a.port),Handler).serve_forever()
"#).unwrap();
        let backend = StrataBackend::new(
            StrataSettings { config_path: Some(profile), arena_gb: Some(6), prefetch_experts: 2, ..Default::default() },
            hardware(),
            Duration::from_secs(10),
        );
        let loaded = backend
            .load(LoadRequest {
                model_id: "native".into(),
                model_path: dir.path().join("native.gguf"),
                context_size: 8192,
                gpu_layers: None,
                threads: None,
                flash_attention: Default::default(),
                use_mmap: true,
                use_mlock: false,
                needs_default_chat_template: false,
                extra_args: vec!["--host=0.0.0.0".into()],
            })
            .await
            .unwrap();
        assert_eq!(loaded.context_size, 4096);
        let events = backend
            .generate(GenerationRequest {
                model: "native".into(),
                messages: vec![super::super::ChatMessage::new("user", "test")],
                prompt: None,
                params: SamplingCommitment::default(),
                stop: vec![],
                prompt_tokens: Some(1),
                disable_thinking: true,
            })
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().any(|e| matches!(e, Ok(StreamEvent::Delta(s)) if s == "paging fixture")));
        assert!(events.iter().any(|e| matches!(e, Ok(StreamEvent::Done { .. }))));
        let observed: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join("observed.json")).unwrap()).unwrap();
        let url = format!("http://127.0.0.1:{}/health", observed["port"]);
        backend.unload().await.unwrap();
        assert!(backend.loaded().await.is_none());
        assert!(reqwest::Client::builder().no_proxy().build().unwrap().get(url).send().await.is_err());
    }
}
