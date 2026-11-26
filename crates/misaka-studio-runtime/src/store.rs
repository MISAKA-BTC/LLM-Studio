//! The local model store: what is on this disk, and what is known about it.
//!
//! # Scanning is cheap, hashing is not
//!
//! A scan reads each model's header — kilobytes — and is safe to run whenever a directory might
//! have changed. A SHA-256 reads every byte, and on a 40 GB model that is a minute of disk at
//! full tilt. So they are separate operations: [`ModelStore::refresh`] happens freely,
//! [`ModelStore::ensure_hashed`] happens when someone asks for the provenance identity, and the
//! result is cached in a sidecar so it happens once per file.
//!
//! # The sidecar
//!
//! `<model>.gguf.misaka.json` holds what the file itself cannot: which repository and revision it
//! came from, and its digest. Both are needed for `h_M`, and neither is inside a GGUF. It sits
//! beside the model rather than in a central database so that moving a model directory to
//! another disk — the thing people do with 200 GB of models — moves its provenance with it.
//!
//! The sidecar records the **size at hash time**. A file whose size no longer matches has been
//! replaced, and the cached digest is discarded rather than trusted: a stale hash is a wrong
//! identity, which is worse than no identity.

use crate::{Error, Result};
use misaka_studio_core::image_model::LocalImageModel;
use misaka_studio_core::model::{LocalModel, ModelSource};
use misaka_studio_core::palw;
use misaka_studio_core::quant::Quantization;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::SystemTime;
use tokio::sync::{Mutex, RwLock};

/// How deep a model directory is walked. Deep enough for `models/org/repo/file.gguf`, shallow
/// enough that pointing the Studio at a home directory does not walk the whole disk.
const MAX_DEPTH: usize = 6;

/// Suffix of the metadata file written beside a model.
pub const SIDECAR_SUFFIX: &str = ".misaka.json";

#[derive(Clone)]
struct Roots {
    paths: Vec<PathBuf>,
    epoch: u64,
}

struct StoreSnapshot {
    models: Arc<Vec<LocalModel>>,
    images: Arc<Vec<LocalImageModel>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl FileStamp {
    fn read(path: &Path) -> std::io::Result<Self> {
        let metadata = std::fs::metadata(path)?;
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified()?,
            created: metadata.created().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (metadata.dev(), metadata.ino(), metadata.ctime(), metadata.ctime_nsec())
            },
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileSignature {
    model: FileStamp,
    sidecar: Option<FileStamp>,
}

impl FileSignature {
    fn read(path: &Path) -> Option<Self> {
        let model = FileStamp::read(path).ok()?;
        let sidecar = match FileStamp::read(&Sidecar::path_for(path)) {
            Ok(stamp) => Some(stamp),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return None,
        };
        Some(Self { model, sidecar })
    }
}

struct CachedModelFile {
    signature: FileSignature,
    model: LocalModel,
}

#[derive(Default, Debug)]
struct ScanCounts {
    directories: u64,
    inspected: u64,
    reused: u64,
}

#[derive(Default)]
struct ScanState {
    completed: u64,
    files: HashMap<PathBuf, CachedModelFile>,
    scans: u64,
    last: ScanCounts,
    #[cfg(test)]
    after_scan: Option<Box<dyn FnMut() + Send>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Sidecar {
    pub source: ModelSource,
    pub catalog_id: Option<String>,
    pub sha256: Option<String>,
    /// File size when the digest was computed. The guard against a stale hash.
    pub hashed_size: Option<u64>,
}

impl Sidecar {
    pub fn path_for(model: &Path) -> PathBuf {
        if model.is_dir() {
            return model.join(SIDECAR_SUFFIX);
        }
        Self::adjacent_path(model)
    }

    fn adjacent_path(model: &Path) -> PathBuf {
        let mut name = model.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        name.push_str(SIDECAR_SUFFIX);
        model.with_file_name(name)
    }

    pub fn load(model: &Path) -> Self {
        std::fs::read_to_string(Self::path_for(model))
            .or_else(|error| if model.is_dir() { std::fs::read_to_string(Self::adjacent_path(model)) } else { Err(error) })
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, model: &Path) -> Result<()> {
        let path = Self::path_for(model);
        let json = serde_json::to_string_pretty(self).map_err(|e| Error::io(path.display(), std::io::Error::other(e)))?;
        std::fs::write(&path, json).map_err(|e| Error::io(path.display(), e))
    }
}

/// Every model directory the Studio watches.
pub struct ModelStore {
    roots: RwLock<Roots>,
    cache: RwLock<StoreSnapshot>,
    /// The scan owns header caches and runs at most one filesystem walk at a time. Chat and
    /// diffusers results are published together, while remaining distinct lists in the snapshot.
    scan: Arc<Mutex<ScanState>>,
    requested: AtomicU64,
    file_ops: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

impl ModelStore {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        ModelStore {
            roots: RwLock::new(Roots { paths: roots, epoch: 0 }),
            cache: RwLock::new(StoreSnapshot { models: Arc::new(Vec::new()), images: Arc::new(Vec::new()) }),
            scan: Arc::new(Mutex::new(ScanState::default())),
            requested: AtomicU64::new(0),
            file_ops: Mutex::new(HashMap::new()),
        }
    }

    pub async fn roots(&self) -> Vec<PathBuf> {
        self.roots.read().await.paths.clone()
    }

    /// Replace the watched directories and rescan.
    pub async fn set_roots(&self, roots: Vec<PathBuf>) -> Result<Arc<Vec<LocalModel>>> {
        {
            let mut current = self.roots.write().await;
            current.paths = roots;
            current.epoch = current.epoch.wrapping_add(1);
        }
        self.refresh().await
    }

    /// Walk the directories and rebuild both lists. One walk of the disk serves both — a
    /// diffusers checkpoint and a GGUF are never the same file, but scanning twice would still
    /// mean stalling the same slow network drive twice for no benefit.
    pub async fn refresh(&self) -> Result<Arc<Vec<LocalModel>>> {
        let request = self.requested.fetch_add(1, Ordering::AcqRel) + 1;
        let mut scan = self.scan.clone().lock_owned().await;
        if scan.completed >= request {
            return Ok(self.list().await);
        }
        loop {
            let roots = self.roots.read().await.clone();
            let through = self.requested.load(Ordering::Acquire);
            let epoch = roots.epoch;
            // Requests arriving while this pass is walking are covered by one later pass, so
            // a just-finished download cannot be lost behind a scan that started before it.
            // Keep the owned guard in the blocking job even if its HTTP caller is cancelled.
            let (models, images, returned) = tokio::task::spawn_blocking(move || {
                let (models, images, counts) = scan_roots(&roots.paths, &mut scan.files);
                scan.scans += 1;
                scan.last = counts;
                #[cfg(test)]
                if let Some(after_scan) = &mut scan.after_scan {
                    after_scan();
                }
                (models, images, scan)
            })
            .await
            .map_err(|e| Error::io("model scan", std::io::Error::other(e)))?;
            scan = returned;
            let current_roots = self.roots.read().await;
            if current_roots.epoch != epoch {
                continue;
            }
            let models = Arc::new(models);
            *self.cache.write().await = StoreSnapshot { models: models.clone(), images: Arc::new(images) };
            scan.completed = through;
            tracing::debug!(
                directories = scan.last.directories,
                inspected = scan.last.inspected,
                reused = scan.last.reused,
                "model scan completed"
            );
            return Ok(models);
        }
    }

    /// The last scan's result. Cheap; call [`Self::refresh`] to make it current.
    pub async fn list(&self) -> Arc<Vec<LocalModel>> {
        self.cache.read().await.models.clone()
    }

    /// The diffusers-format checkpoints found by the last scan.
    pub async fn list_images(&self) -> Arc<Vec<LocalImageModel>> {
        self.cache.read().await.images.clone()
    }

    pub async fn get_image(&self, id: &str) -> Option<LocalImageModel> {
        self.cache.read().await.images.iter().find(|m| m.id == id).cloned()
    }

    pub async fn require_image(&self, id: &str) -> Result<LocalImageModel> {
        self.get_image(id).await.ok_or_else(|| Error::ModelNotFound { id: id.to_string() })
    }

    pub async fn get(&self, id: &str) -> Option<LocalModel> {
        self.cache.read().await.models.iter().find(|m| m.id == id).cloned()
    }

    pub async fn require(&self, id: &str) -> Result<LocalModel> {
        self.get(id).await.ok_or_else(|| Error::ModelNotFound { id: id.to_string() })
    }

    async fn file_lock(&self, path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.file_ops.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    /// Delete a model and its sidecar.
    ///
    /// The path comes from the scan cache and is checked against the roots before anything is
    /// unlinked. Both halves matter: an id is user input, and "delete the model named
    /// `../../../etc/passwd`" must be impossible by construction rather than by the id happening
    /// not to contain a slash.
    pub async fn delete(&self, id: &str) -> Result<()> {
        let model = self.require(id).await?;
        let roots = self.roots.read().await.paths.clone();
        let path = model.path.clone();
        let permit = self.file_lock(&path).await;
        tokio::task::spawn_blocking(move || -> Result<()> {
            let _permit = permit;
            let canonical = std::fs::canonicalize(&path).map_err(|e| Error::io(path.display(), e))?;
            let inside = roots.iter().any(|root| std::fs::canonicalize(root).map(|r| canonical.starts_with(r)).unwrap_or(false));
            if !inside {
                return Err(Error::bad_request(format!(
                    "{} is outside every configured model directory; delete it with your file manager",
                    path.display()
                )));
            }
            let meta = Sidecar::load(&canonical);
            let catalog_dir = meta.catalog_id.as_ref().and(meta.source.repo.as_deref()).zip(meta.source.filename.as_deref()).and_then(
                |(repo, file)| {
                    roots.iter().filter_map(|root| std::fs::canonicalize(root).ok()).find_map(|root| {
                        let folder = crate::catalog::install_directory(&root, repo, file)?;
                        (canonical.starts_with(&folder) && folder.join(file) == canonical).then_some(folder)
                    })
                },
            );
            let sidecar = Sidecar::adjacent_path(&canonical);
            if let Some(folder) = catalog_dir {
                std::fs::remove_dir_all(&folder).map_err(|e| Error::io(folder.display(), e))?;
            } else if canonical.is_dir() {
                std::fs::remove_dir_all(&canonical).map_err(|e| Error::io(canonical.display(), e))?;
            } else {
                std::fs::remove_file(&canonical).map_err(|e| Error::io(canonical.display(), e))?;
            }
            let _ = std::fs::remove_file(&sidecar);
            Ok(())
        })
        .await
        .map_err(|e| Error::io("delete", std::io::Error::other(e)))??;

        self.refresh().await?;
        Ok(())
    }

    /// Compute the file's SHA-256 if it is not already known, and cache it.
    ///
    /// Returns the model with `sha256` filled in — which is what makes
    /// [`LocalModel::identity`](misaka_studio_core::model::LocalModel::identity) available, and
    /// with it the chain-compatible `h_M`.
    pub async fn ensure_hashed(&self, id: &str) -> Result<LocalModel> {
        let model = self.require(id).await?;
        if !single_file_identity(&model.path) {
            return Err(Error::bad_request("A single-file identity is unavailable for multi-file models"));
        }
        let permit = self.file_lock(&model.path).await;
        // The sidecar read and write are filesystem operations too. Keeping the whole operation
        // under one per-file guard also prevents two callers hashing the same 40 GB concurrently.
        let updated = tokio::task::spawn_blocking(move || -> Result<LocalModel> {
            let _permit = permit;
            let sidecar = Sidecar::load(&model.path);
            if let (Some(sha), Some(hashed_size)) = (sidecar.sha256, sidecar.hashed_size)
                && hashed_size == model.size_bytes
            {
                return Ok(LocalModel { sha256: Some(sha), ..model });
            }
            let digest = sha256_file(&model.path)?;
            let mut sidecar = Sidecar::load(&model.path);
            sidecar.sha256 = Some(digest.clone());
            sidecar.hashed_size = Some(model.size_bytes);
            sidecar.save(&model.path)?;
            Ok(LocalModel { sha256: Some(digest), ..model })
        })
        .await
        .map_err(|e| Error::io("hash", std::io::Error::other(e)))??;
        // Keep the cache in step so the next request does not re-read the sidecar.
        {
            let mut cache = self.cache.write().await;
            let mut models = (*cache.models).clone();
            if let Some(slot) =
                models.iter_mut().find(|m| m.id == updated.id && m.path == updated.path && m.size_bytes == updated.size_bytes)
            {
                // A refresh may have published newer shape/source metadata while hashing.
                slot.sha256 = updated.sha256.clone();
            }
            cache.models = Arc::new(models);
        }
        Ok(updated)
    }

    /// Record where a model came from — called by the downloader when a file lands.
    pub async fn write_source(&self, path: &Path, source: ModelSource) -> Result<()> {
        let path = path.to_path_buf();
        let permit = self.file_lock(&path).await;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut sidecar = Sidecar::load(&path);
            sidecar.source = source;
            sidecar.save(&path)
        })
        .await
        .map_err(|e| Error::io("model source", std::io::Error::other(e)))?
    }
}

/// SHA-256 of a file, read in 8 MiB blocks.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|e| Error::io(path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 8 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|e| Error::io(path.display(), e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

struct ScanFiles<'a> {
    cache: &'a mut HashMap<PathBuf, CachedModelFile>,
    seen: HashSet<PathBuf>,
    counts: ScanCounts,
}

impl ScanFiles<'_> {
    fn inspect(&mut self, path: &Path) -> Option<LocalModel> {
        self.seen.insert(path.to_path_buf());
        let signature = FileSignature::read(path);
        if let Some(cached) = self.cache.get(path)
            && signature.as_ref() == Some(&cached.signature)
        {
            self.counts.reused += 1;
            return Some(cached.model.clone());
        }
        self.cache.remove(path);
        self.counts.inspected += 1;
        let sidecar = Sidecar::load(path);
        let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
        let model = if palw::is_artifact_filename(&name) {
            inspect_palw_artifact(path, sidecar)
        } else if crate::backend::strata::is_inkling_pack(path) {
            crate::backend::strata::inspect_inkling_pack(path, sidecar.source).ok()
        } else {
            match LocalModel::inspect(path, sidecar.source.clone()) {
                Ok(mut model) => {
                    if let Some(id) = sidecar.catalog_id {
                        model.id = id;
                        if let Some((_, _, count)) = crate::catalog::gguf_shard(&name)
                            && count > 1
                        {
                            let original = path.file_name()?.to_str()?;
                            let (prefix, _, _) = crate::catalog::gguf_shard(original)?;
                            let extension = original.rsplit_once('.').map_or("gguf", |(_, ext)| ext);
                            model.size_bytes = (1..=count).try_fold(0u64, |sum, part| {
                                let shard = path.with_file_name(format!("{prefix}-{part:05}-of-{count:05}.{extension}"));
                                sum.checked_add(std::fs::metadata(shard).ok()?.len())
                            })?;
                        }
                    }
                    if sidecar.hashed_size == Some(model.size_bytes) && single_file_identity(path) {
                        model.sha256 = sidecar.sha256;
                    }
                    Some(model)
                }
                Err(error) => {
                    tracing::warn!(path = %path.display(), "skipping: {error}");
                    None
                }
            }
        }?;
        // Never retain a header that raced a file/sidecar replacement. Failed metadata reads
        // also bypass this cache. Directory models are deliberately rescanned: a directory's
        // own mtime cannot tell us whether one of its nested weight files changed.
        if let Some(signature) = signature
            && FileSignature::read(path).as_ref() == Some(&signature)
        {
            self.cache.insert(path.to_path_buf(), CachedModelFile { signature, model: model.clone() });
        }
        Some(model)
    }
}

fn scan_roots(
    roots: &[PathBuf],
    cache: &mut HashMap<PathBuf, CachedModelFile>,
) -> (Vec<LocalModel>, Vec<LocalImageModel>, ScanCounts) {
    let mut found: HashMap<String, LocalModel> = HashMap::new();
    let mut found_images: HashMap<String, LocalImageModel> = HashMap::new();
    let mut files = ScanFiles { cache, seen: HashSet::new(), counts: ScanCounts::default() };
    for root in roots {
        if root.is_file() {
            if let Some(model) = files.inspect(root) {
                found.insert(model.id.clone(), model);
            }
        } else {
            scan_dir(root, 0, &mut found, &mut found_images, &mut files);
        }
    }
    let seen = &files.seen;
    files.cache.retain(|path, _| seen.contains(path));
    let mut models: Vec<LocalModel> = found.into_values().collect();
    models.sort_by_cached_key(|m| m.name.to_lowercase());
    let mut image_models: Vec<LocalImageModel> = found_images.into_values().collect();
    image_models.sort_by_cached_key(|m| m.name.to_lowercase());
    (models, image_models, files.counts)
}

fn scan_dir(
    dir: &Path,
    depth: usize,
    found: &mut HashMap<String, LocalModel>,
    found_images: &mut HashMap<String, LocalImageModel>,
    files: &mut ScanFiles<'_>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    files.counts.directories += 1;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else { continue };

        if file_type.is_dir() {
            // A diffusers checkpoint is a directory named by `model_index.json`, checked before
            // the MLX directory shape below — the two never collide (MLX ships `config.json`,
            // diffusers ships `model_index.json`) but the more specific signal goes first.
            if let Some(model) = inspect_diffusers_dir(&path) {
                found_images.entry(model.id.clone()).or_insert(model);
                continue;
            }
            // An MLX model is a directory, so a directory is checked as a model before being
            // descended into.
            if let Some(model) = inspect_mlx_dir(&path) {
                found.entry(model.id.clone()).or_insert(model);
                continue;
            }
            scan_dir(&path, depth + 1, found, found_images, files);
            continue;
        }

        // A PALW artifact is one model file, like a GGUF, and belongs in the same list — the
        // MISAKA runtime backend loads it and no other backend can. Its shape is NOT read here:
        // this crate does not parse `.palwart`, and inventing a layer count from an extension
        // would put a guess in a record. The engine reports the real shape at `/health` when it
        // loads the file.
        let lower = name.to_ascii_lowercase();
        if palw::is_artifact_filename(&lower) {
            if let Some(model) = files.inspect(&path) {
                found.entry(model.id.clone()).or_insert(model);
            }
            continue;
        }
        if !lower.ends_with(".gguf") {
            continue;
        }
        // A multi-part GGUF is one model: llama.cpp is pointed at part 1 and finds the rest, so
        // listing every shard would offer the user four broken entries and one that works.
        if is_non_first_shard(&name) {
            continue;
        }
        if let Some(model) = files.inspect(&path) {
            found.entry(model.id.clone()).or_insert(model);
        }
    }
}

pub(crate) fn single_file_identity(path: &Path) -> bool {
    !path.is_dir()
        && path.file_name().and_then(|name| name.to_str()).and_then(crate::catalog::gguf_shard).is_none_or(|(_, _, count)| count == 1)
}

/// **A `.palwart` as a model entry: what the file proves, and nothing else.**
///
/// The size and the digest are facts about the file, and the sidecar's repository is a fact about
/// where it came from. The layer count and the context window come from the file's own shape
/// block (`palw::read_artifact_header`, 64 bytes) when its format is one this build reads, and
/// stay `None` otherwise: a `context_length` guessed here was shown as "4K context" on an artifact
/// whose rotary table holds 512 positions, in the one place a user reads to size a model.
/// `kv_cache_bytes_per_token` stays `None` — the header does not say how the runtime stores its
/// cache, and the estimate says it is one.
fn inspect_palw_artifact(path: &Path, sidecar: Sidecar) -> Option<LocalModel> {
    let metadata = std::fs::metadata(path).ok()?;
    let size_bytes = metadata.len();
    let modified_at = metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
    let name = path.file_stem()?.to_string_lossy().to_string();
    let header = palw::read_artifact_header(path);
    let mut model = LocalModel {
        id: name.clone(),
        name,
        path: path.to_path_buf(),
        size_bytes,
        quantization: None,
        architecture: Some("palw".into()),
        parameter_count: None,
        context_length: header.map(|h| h.max_position),
        block_count: header.map(|h| h.n_layers),
        expert_count: None,
        kv_cache_bytes_per_token: None,
        // The runtime renders Qwen's template itself, from the tokenizer file it is given — the
        // artifact carries a tokenizer COMMITMENT, never a template.
        has_chat_template: false,
        source: sidecar.source.clone(),
        sha256: None,
        modified_at,
    };
    if let (Some(sha), Some(hashed)) = (sidecar.sha256, sidecar.hashed_size)
        && hashed == size_bytes
    {
        model.sha256 = Some(sha);
    }
    Some(model)
}

/// `model-00002-of-00003.gguf` is a continuation shard; part 1 represents the model.
fn is_non_first_shard(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(idx) = lower.find("-of-") else { return false };
    let before = &lower[..idx];
    let Some(dash) = before.rfind('-') else { return false };
    let part = &before[dash + 1..];
    part.len() >= 3 && part.chars().all(|c| c.is_ascii_digit()) && part.parse::<u32>().map(|n| n != 1).unwrap_or(false)
}

/// An MLX model directory: `config.json` plus safetensors.
fn inspect_mlx_dir(path: &Path) -> Option<LocalModel> {
    let config_path = path.join("config.json");
    if !config_path.is_file() {
        return None;
    }
    let has_weights = std::fs::read_dir(path).ok()?.flatten().any(|e| e.file_name().to_string_lossy().ends_with(".safetensors"));
    if !has_weights {
        return None;
    }

    let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&config_path).ok()?).ok()?;
    let sidecar = Sidecar::load(path);
    let name = path.file_name()?.to_string_lossy().into_owned();
    let name = if sidecar.catalog_id.is_some() {
        sidecar.source.repo.as_deref().and_then(|repo| repo.rsplit_once('/')).map_or(name, |(_, repo)| repo.to_string())
    } else {
        name
    };
    let id = sidecar.catalog_id.unwrap_or_else(|| name.clone());
    let size_bytes = dir_size(path);
    let bits = config.get("quantization").and_then(|q| q.get("bits")).and_then(|b| b.as_u64());

    Some(LocalModel {
        name,
        id,
        path: path.to_path_buf(),
        size_bytes,
        quantization: bits.map(|b| Quantization::unknown(format!("MLX-{b}bit"))).or_else(|| Some(Quantization::unknown("MLX-fp16"))),
        architecture: config
            .get("model_type")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| config.get("architectures").and_then(|a| a.get(0)).and_then(|v| v.as_str()).map(str::to_string)),
        parameter_count: None,
        context_length: config.get("max_position_embeddings").and_then(|v| v.as_u64()),
        block_count: config.get("num_hidden_layers").and_then(|v| v.as_u64()),
        expert_count: config.get("num_experts").and_then(|v| v.as_u64()),
        kv_cache_bytes_per_token: None,
        has_chat_template: path.join("tokenizer_config.json").is_file(),
        source: sidecar.source,
        sha256: None,
        modified_at: None,
    })
}

/// A diffusers checkpoint directory: `model_index.json` plus `.safetensors` weights, directly
/// inside or one level down (`unet/`, `transformer/`, `vae/`, `text_encoder/`, ...) — the
/// standard Hugging Face `diffusers` layout. Checked before [`inspect_mlx_dir`] in [`scan_dir`]:
/// the two shapes never overlap (MLX ships `config.json` at the top level, diffusers ships
/// `model_index.json`), but the more specific file name is the one to trust first.
fn inspect_diffusers_dir(path: &Path) -> Option<LocalImageModel> {
    let index_path = path.join("model_index.json");
    if !index_path.is_file() {
        return None;
    }
    if !dir_has_safetensors(path, 0) {
        return None;
    }

    let index: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&index_path).ok()?).ok()?;
    let id = path.file_name()?.to_string_lossy().into_owned();
    let size_bytes = dir_size(path);
    let architecture = index.get("_class_name").and_then(|v| v.as_str()).map(str::to_string);
    // A checkpoint is worth offering reference/edit images for when its own pipeline class says
    // so (Qwen-Image-Edit, an Img2Img/Inpaint/ControlNet variant) or it declares an image
    // encoder component — better than guessing from the model's name, which the directory need
    // not match.
    let supports_reference_images = architecture
        .as_deref()
        .map(|a| a.contains("Img2Img") || a.contains("Edit") || a.contains("Inpaint") || a.contains("ControlNet"))
        .unwrap_or(false)
        || index.get("image_encoder").is_some();
    let modified_at = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    Some(LocalImageModel {
        name: id.clone(),
        id,
        path: path.to_path_buf(),
        size_bytes,
        architecture,
        supports_reference_images,
        source: Sidecar::load(path).source,
        sha256: None,
        modified_at,
    })
}

/// Whether a directory has `.safetensors` files at its top level or one level down — diffusers
/// checkpoints commonly split weights across component subfolders.
fn dir_has_safetensors(path: &Path, depth: usize) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else { return false };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_file() && entry.file_name().to_string_lossy().ends_with(".safetensors") {
            return true;
        }
        if file_type.is_dir() && depth == 0 && dir_has_safetensors(&entry.path(), depth + 1) {
            return true;
        }
    }
    false
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            _ => e.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a minimal but real GGUF so the store is tested on files, not mocks.
    fn write_gguf(path: &Path, arch: &str, ftype: u32) {
        let mut out = Vec::new();
        out.extend_from_slice(b"GGUF");
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes()); // tensors
        out.extend_from_slice(&2u64.to_le_bytes()); // kv pairs
        let kv = |key: &str, value: &[u8], ty: u32, out: &mut Vec<u8>| {
            out.extend_from_slice(&(key.len() as u64).to_le_bytes());
            out.extend_from_slice(key.as_bytes());
            out.extend_from_slice(&ty.to_le_bytes());
            out.extend_from_slice(value);
        };
        let mut arch_value = Vec::new();
        arch_value.extend_from_slice(&(arch.len() as u64).to_le_bytes());
        arch_value.extend_from_slice(arch.as_bytes());
        kv("general.architecture", &arch_value, 8, &mut out);
        kv("general.file_type", &ftype.to_le_bytes(), 4, &mut out);
        std::fs::write(path, out).expect("write gguf");
    }

    async fn wait_for_requests(store: &ModelStore, count: u64) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while store.requested.load(Ordering::Acquire) < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("requests queued");
    }

    async fn pause_next_scan(store: &ModelStore) -> (tokio::sync::oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (started, receiver) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let mut started = Some(started);
        store.scan.lock().await.after_scan = Some(Box::new(move || {
            if let Some(started) = started.take() {
                let _ = started.send(());
                released.recv_timeout(std::time::Duration::from_secs(3)).expect("scan released");
            }
        }));
        (receiver, release)
    }

    #[tokio::test]
    async fn a_burst_of_refresh_requests_shares_one_filesystem_pass() {
        let dir = tempfile::tempdir().unwrap();
        write_gguf(&dir.path().join("one.gguf"), "llama", 15);
        let store = Arc::new(ModelStore::new(vec![dir.path().to_path_buf()]));
        let gate = store.scan.clone().lock_owned().await;
        let mut requests = Vec::new();
        for _ in 0..100 {
            let store = store.clone();
            requests.push(tokio::spawn(async move { store.refresh().await.unwrap() }));
        }
        wait_for_requests(&store, 100).await;
        drop(gate);
        for request in requests {
            assert_eq!(request.await.unwrap().len(), 1);
        }
        assert_eq!(store.scan.lock().await.scans, 1);
    }

    #[tokio::test]
    async fn changes_during_an_active_scan_get_one_trailing_pass() {
        let dir = tempfile::tempdir().unwrap();
        write_gguf(&dir.path().join("before.gguf"), "llama", 15);
        let store = Arc::new(ModelStore::new(vec![dir.path().to_path_buf()]));
        let (started, release) = pause_next_scan(&store).await;
        let first_store = store.clone();
        let first = tokio::spawn(async move { first_store.refresh().await.unwrap() });
        started.await.unwrap();
        write_gguf(&dir.path().join("landed-during-scan.gguf"), "llama", 15);
        let mut requests = Vec::new();
        for _ in 0..100 {
            let store = store.clone();
            requests.push(tokio::spawn(async move { store.refresh().await.unwrap() }));
        }
        wait_for_requests(&store, 101).await;
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap().len(), 1);
        for request in requests {
            assert_eq!(request.await.unwrap().len(), 2);
        }
        assert_eq!(store.scan.lock().await.scans, 2, "all later requests share the trailing pass");
    }

    #[tokio::test]
    async fn an_old_scan_cannot_publish_after_the_watched_roots_change() {
        let before = tempfile::tempdir().unwrap();
        let after = tempfile::tempdir().unwrap();
        write_gguf(&before.path().join("before.gguf"), "llama", 15);
        write_gguf(&after.path().join("after.gguf"), "qwen3", 15);
        let store = Arc::new(ModelStore::new(vec![before.path().to_path_buf()]));
        let (started, release) = pause_next_scan(&store).await;
        let first_store = store.clone();
        let first = tokio::spawn(async move { first_store.refresh().await.unwrap() });
        started.await.unwrap();
        let next_store = store.clone();
        let path = after.path().to_path_buf();
        let next = tokio::spawn(async move { next_store.set_roots(vec![path]).await.unwrap() });
        wait_for_requests(&store, 2).await;
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap()[0].id, "after", "the old-root result is discarded");
        assert_eq!(next.await.unwrap()[0].id, "after");
        assert_eq!(store.list().await[0].id, "after");
        assert_eq!(store.scan.lock().await.files.len(), 1, "removed roots leave no header-cache entries");
    }

    #[tokio::test]
    async fn thousand_model_rescans_read_only_changed_headers_and_track_sidecars_and_deletions() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..1000 {
            write_gguf(&dir.path().join(format!("model-{index:04}.gguf")), "llama", 15);
        }
        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        assert_eq!(store.refresh().await.unwrap().len(), 1000);
        assert_eq!(store.scan.lock().await.last.inspected, 1000);
        assert_eq!(store.refresh().await.unwrap().len(), 1000);
        {
            let scan = store.scan.lock().await;
            assert_eq!(scan.last.inspected, 0);
            assert_eq!(scan.last.reused, 1000);
        }
        let changed = dir.path().join("model-0500.gguf");
        write_gguf(&changed, "a-different-architecture", 7);
        store.refresh().await.unwrap();
        assert_eq!(store.scan.lock().await.last.inspected, 1);
        assert_eq!(store.get("model-0500").await.unwrap().architecture.as_deref(), Some("a-different-architecture"));
        store.write_source(&changed, ModelSource { repo: Some("org/changed".into()), ..Default::default() }).await.unwrap();
        store.refresh().await.unwrap();
        assert_eq!(store.scan.lock().await.last.inspected, 1, "sidecar updates also invalidate the cache");
        assert_eq!(store.get("model-0500").await.unwrap().source.repo.as_deref(), Some("org/changed"));
        std::fs::remove_file(&changed).unwrap();
        assert_eq!(store.refresh().await.unwrap().len(), 999);
        assert_eq!(store.scan.lock().await.files.len(), 999);
    }

    #[tokio::test]
    async fn a_same_size_edit_and_a_corrupt_replacement_do_not_reuse_old_headers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.gguf");
        write_gguf(&path, "llama", 15);
        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        store.refresh().await.unwrap();
        let old_size = std::fs::metadata(&path).unwrap().len();
        write_gguf(&path, "qwen3", 15);
        // Explicit mtime avoids depending on the filesystem timestamp's clock resolution.
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(100))
            .unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), old_size);
        store.refresh().await.unwrap();
        assert_eq!(store.get("model").await.unwrap().architecture.as_deref(), Some("qwen3"));
        std::fs::write(&path, b"incomplete replacement").unwrap();
        assert!(store.refresh().await.unwrap().is_empty());
        write_gguf(&path, "llama", 15);
        assert_eq!(store.refresh().await.unwrap().len(), 1, "a repaired file is inspected again");
    }

    #[tokio::test]
    async fn directory_model_weights_are_rescanned_even_when_the_parent_directory_does_not_change() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("mlx");
        std::fs::create_dir(&model).unwrap();
        std::fs::write(model.join("config.json"), r#"{"model_type":"llama"}"#).unwrap();
        let weights = model.join("model.safetensors");
        std::fs::write(&weights, [0u8; 64]).unwrap();
        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        let before = store.refresh().await.unwrap()[0].size_bytes;
        std::fs::write(&weights, [0u8; 128]).unwrap();
        let after = store.refresh().await.unwrap()[0].size_bytes;
        assert_eq!(after - before, 64);
    }

    #[tokio::test]
    async fn scanning_finds_models_and_reads_their_quantization() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_gguf(&dir.path().join("Qwen3-4B-Q4_K_M.gguf"), "qwen3", 15);
        std::fs::create_dir(dir.path().join("nested")).expect("mkdir");
        write_gguf(&dir.path().join("nested/Llama-3-8B-Q8_0.gguf"), "llama", 7);
        std::fs::write(dir.path().join("notes.txt"), "not a model").expect("write");

        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        let models = store.refresh().await.expect("scans");
        assert_eq!(models.len(), 2, "found {:?}", models.iter().map(|m| &m.id).collect::<Vec<_>>());
        let qwen = store.get("Qwen3-4B-Q4_K_M").await.expect("qwen is listed");
        assert_eq!(qwen.quantization.expect("quant").label, "Q4_K_M");
        assert_eq!(qwen.architecture.as_deref(), Some("qwen3"));
    }

    /// A four-shard model must appear once, as its first part — not four times.
    #[test]
    fn continuation_shards_are_not_separate_models() {
        assert!(is_non_first_shard("model-00002-of-00004.gguf"));
        assert!(is_non_first_shard("Deepseek-Q4_K_M-00003-of-00009.gguf"));
        assert!(!is_non_first_shard("model-00001-of-00004.gguf"));
        assert!(!is_non_first_shard("Qwen3-4B-Q4_K_M.gguf"));
    }

    #[tokio::test]
    async fn hashing_is_cached_in_the_sidecar_and_invalidated_by_a_size_change() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("m-Q4_K_M.gguf");
        write_gguf(&path, "llama", 15);
        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        store.refresh().await.expect("scans");

        let hashed = store.ensure_hashed("m-Q4_K_M").await.expect("hashes");
        let digest = hashed.sha256.clone().expect("a digest");
        assert!(Sidecar::path_for(&path).is_file(), "the sidecar is written");

        // The identity is now available, and it re-derives.
        let identity = hashed.identity().expect("identity");
        assert!(identity.verify());

        // Replace the file with different content and a different length: the cached digest must
        // not survive.
        let mut bytes = std::fs::read(&path).expect("read");
        bytes.extend_from_slice(b"different now");
        std::fs::write(&path, bytes).expect("write");
        store.refresh().await.expect("rescans");
        let rehashed = store.ensure_hashed("m-Q4_K_M").await.expect("rehashes");
        assert_ne!(rehashed.sha256.expect("digest"), digest, "a changed file gets a new digest");
    }

    #[tokio::test]
    async fn deleting_removes_the_model_and_its_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("gone-Q4_K_M.gguf");
        write_gguf(&path, "llama", 15);
        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        store.refresh().await.expect("scans");
        store.ensure_hashed("gone-Q4_K_M").await.expect("hashes");

        store.delete("gone-Q4_K_M").await.expect("deletes");
        assert!(!path.exists());
        assert!(!Sidecar::path_for(&path).exists());
        assert!(store.get("gone-Q4_K_M").await.is_none());
    }

    #[tokio::test]
    async fn deleting_an_unknown_model_is_a_not_found_not_a_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        store.refresh().await.expect("scans");
        assert!(matches!(store.delete("nothing").await, Err(Error::ModelNotFound { .. })));
    }

    #[tokio::test]
    async fn an_mlx_directory_is_one_model() {
        let dir = tempfile::tempdir().expect("tempdir");
        let model_dir = dir.path().join("Qwen3-4B-mlx");
        std::fs::create_dir(&model_dir).expect("mkdir");
        std::fs::write(
            model_dir.join("config.json"),
            r#"{"model_type":"qwen3","num_hidden_layers":36,"max_position_embeddings":32768,"quantization":{"bits":4}}"#,
        )
        .expect("write config");
        std::fs::write(model_dir.join("model.safetensors"), vec![0u8; 128]).expect("write weights");

        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        let models = store.refresh().await.expect("scans");
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.id, "Qwen3-4B-mlx");
        assert_eq!(model.block_count, Some(36));
        assert_eq!(model.quantization.as_ref().expect("quant").label, "MLX-4bit");
        assert!(model.size_bytes >= 128);
    }

    #[tokio::test]
    async fn a_diffusers_directory_is_one_image_model_kept_apart_from_chat_models() {
        let dir = tempfile::tempdir().expect("tempdir");
        let model_dir = dir.path().join("qwen-image-2.1");
        std::fs::create_dir(&model_dir).expect("mkdir");
        std::fs::write(model_dir.join("model_index.json"), r#"{"_class_name":"QwenImageEditPipeline"}"#).expect("write index");
        std::fs::create_dir(model_dir.join("transformer")).expect("mkdir transformer");
        std::fs::write(model_dir.join("transformer/diffusion_pytorch_model.safetensors"), vec![0u8; 256]).expect("write weights");

        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        store.refresh().await.expect("scans");

        assert!(store.list().await.is_empty(), "a diffusers checkpoint is not a chat model");
        let images = store.list_images().await;
        assert_eq!(images.len(), 1);
        let model = &images[0];
        assert_eq!(model.id, "qwen-image-2.1");
        assert_eq!(model.architecture.as_deref(), Some("QwenImageEditPipeline"));
        assert!(model.supports_reference_images, "an Edit pipeline supports reference images");
        assert!(model.size_bytes >= 256);

        let fetched = store.require_image("qwen-image-2.1").await.expect("found by id");
        assert_eq!(fetched.id, model.id);
    }

    /// An MLX chat model and a diffusers image model must not be confused for one another even
    /// when scanned from the same root.
    #[tokio::test]
    async fn mlx_and_diffusers_directories_coexist_without_crossing_lists() {
        let dir = tempfile::tempdir().expect("tempdir");

        let mlx_dir = dir.path().join("Qwen3-4B-mlx");
        std::fs::create_dir(&mlx_dir).expect("mkdir");
        std::fs::write(mlx_dir.join("config.json"), r#"{"model_type":"qwen3"}"#).expect("write config");
        std::fs::write(mlx_dir.join("model.safetensors"), vec![0u8; 64]).expect("write weights");

        let image_dir = dir.path().join("flux-klein");
        std::fs::create_dir(&image_dir).expect("mkdir");
        std::fs::write(image_dir.join("model_index.json"), r#"{"_class_name":"FluxPipeline"}"#).expect("write index");
        std::fs::write(image_dir.join("diffusion_pytorch_model.safetensors"), vec![0u8; 64]).expect("write weights");

        let store = ModelStore::new(vec![dir.path().to_path_buf()]);
        store.refresh().await.expect("scans");

        assert_eq!(store.list().await.len(), 1, "only the MLX directory is a chat model");
        assert_eq!(store.list_images().await.len(), 1, "only the diffusers directory is an image model");
    }
}
