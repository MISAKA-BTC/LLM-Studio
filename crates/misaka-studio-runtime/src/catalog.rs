//! The model catalog — searching Hugging Face and reading what a repository actually contains.
//!
//! # Two calls, on purpose
//!
//! Search returns repositories; a repository holds up to twenty quantizations of one model, and
//! choosing between them is the decision this whole app exists to make easy. So the file list is
//! a second call, made when a repository is opened, and it carries the size and digest of every
//! file — which is what lets the UI say "Q4_K_M, 4.7 GB, fits" before anything is downloaded.
//!
//! # `lfs.oid` is the SHA-256, and that is worth a great deal
//!
//! Hugging Face stores large files in Git LFS, whose object id **is** the file's SHA-256. The
//! tree endpoint hands it over for free, so the Studio knows a model's digest before downloading
//! it: the download can be verified against a digest published by the repository rather than
//! against itself, and `h_M` can be derived the moment the file lands — with no 40 GB re-read.
//!
//! # The endpoint is configurable
//!
//! `HF_ENDPOINT` is the variable the rest of the ecosystem uses for mirrors and corporate
//! proxies, and it is what this reads. Nothing here hardcodes `huggingface.co` except the
//! default.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OnceCell};

struct Cached<V> {
    value: V,
    at: Instant,
    used: Instant,
}

type SharedRequest<V> = OnceCell<std::result::Result<V, String>>;

/// Instance-local: changing endpoint or credentials replaces the Catalog and all its entries.
/// Only successful responses enter the bounded TTL cache. Overlapping callers share the same
/// result (including an error); cancelled initializers are retried by OnceCell's next waiter.
struct RequestCache<K, V> {
    entries: Mutex<HashMap<K, Cached<V>>>,
    requests: Mutex<HashMap<K, Weak<SharedRequest<V>>>>,
    ttl: Duration,
    capacity: usize,
}

impl<K: Clone + Eq + Hash, V: Clone> RequestCache<K, V> {
    fn new(ttl: Duration, capacity: usize) -> Self {
        Self { entries: Mutex::new(HashMap::new()), requests: Mutex::new(HashMap::new()), ttl, capacity }
    }

    async fn get(&self, key: &K) -> Option<V> {
        let mut entries = self.entries.lock().await;
        let entry = entries.get_mut(key)?;
        if entry.at.elapsed() >= self.ttl {
            entries.remove(key);
            return None;
        }
        entry.used = Instant::now();
        Some(entry.value.clone())
    }

    async fn insert(&self, key: K, value: V) {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, entry| entry.at.elapsed() < self.ttl);
        if entries.len() >= self.capacity
            && !entries.contains_key(&key)
            && let Some(oldest) = entries.iter().min_by_key(|(_, entry)| entry.used).map(|(key, _)| key.clone())
        {
            entries.remove(&oldest);
        }
        let now = Instant::now();
        entries.insert(key, Cached { value, at: now, used: now });
    }

    async fn load<F, Fut>(&self, key: K, fetch: F) -> Result<V>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<V>>,
    {
        if let Some(value) = self.get(&key).await {
            return Ok(value);
        }
        let request = {
            let mut requests = self.requests.lock().await;
            requests.retain(|_, request| request.strong_count() > 0);
            match requests.get(&key).and_then(Weak::upgrade) {
                Some(request) => request,
                None => {
                    let request = Arc::new(OnceCell::new());
                    requests.insert(key.clone(), Arc::downgrade(&request));
                    request
                }
            }
        };
        request
            .get_or_init(|| async {
                // Another caller may have completed between the first lookup and joining the flight.
                if let Some(value) = self.get(&key).await {
                    return Ok(value);
                }
                let result = fetch().await.map_err(|error| match error {
                    Error::Catalog { message } => message,
                    error => error.to_string(),
                });
                if let Ok(value) = &result {
                    self.insert(key, value.clone()).await;
                }
                result
            })
            .await
            .clone()
            .map_err(|message| Error::Catalog { message })
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchFormat {
    All,
    #[default]
    Gguf,
    Mlx,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSort {
    BestMatch,
    Trending,
    #[default]
    Downloads,
    Likes,
    Updated,
}

impl SearchSort {
    fn field(self, query: &str) -> Option<&'static str> {
        match self {
            Self::BestMatch if !query.is_empty() => None,
            Self::BestMatch | Self::Trending => Some("trendingScore"),
            Self::Downloads => Some("downloads"),
            Self::Likes => Some("likes"),
            Self::Updated => Some("lastModified"),
        }
    }
}

/// A repository, as search returns it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// `bartowski/Qwen3-4B-Instruct-GGUF`.
    pub id: String,
    pub downloads: u64,
    pub likes: u64,
    #[serde(default)]
    pub tags: Vec<String>,
    pub last_modified: Option<String>,
    /// Gated repositories need an accepted licence and a token; the UI says so instead of
    /// letting the download fail with a 401.
    pub gated: bool,
    pub pipeline_tag: Option<String>,
    pub trending_score: Option<f64>,
    #[serde(default)]
    pub base_model: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    #[serde(default)]
    pub parameters: Option<u64>,
    #[serde(default)]
    pub context_length: Option<u64>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

/// Binary image bytes fetched through the catalog proxy (organization/user avatar or README media).
#[derive(Clone, Debug)]
pub struct CatalogImage {
    pub content_type: String,
    pub bytes: bytes::Bytes,
}

/// One downloadable file.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CatalogFile {
    /// Path within the repository.
    pub path: String,
    pub size: Option<u64>,
    /// The LFS object id — the file's SHA-256 — when the file is LFS-tracked.
    pub sha256: Option<String>,
    /// Quantization parsed from the filename, so a file list can be sorted by quality.
    pub quantization: Option<misaka_studio_core::quant::Quantization>,
}

/// A repository with its files.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CatalogRepo {
    pub id: String,
    /// The commit the listing was taken at. Recorded in the sidecar so a downloaded model names
    /// an immutable revision rather than a branch that moves.
    pub revision: Option<String>,
    pub gated: bool,
    pub files: Vec<CatalogFile>,
    /// The base (unquantized) repository, from the card's `base_model` tag. Part of `h_M`.
    pub base_model: Option<String>,
    pub entry: CatalogEntry,
    pub architecture: Option<String>,
    pub parameters: Option<u64>,
    pub context_length: Option<u64>,
    pub license: Option<String>,
    pub variants: Vec<CatalogVariant>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFormat {
    Gguf,
    Mlx,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CatalogVariant {
    pub id: String,
    pub format: ModelFormat,
    pub label: String,
    pub size: Option<u64>,
    pub files: Vec<CatalogFile>,
}

pub(crate) fn split_repo(id: &str) -> Option<(&str, &str)> {
    let (author, name) = id.split_once('/')?;
    let valid = |part: &str| {
        safe_component(part) && !part.starts_with('.') && part.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    };
    (valid(author) && valid(name)).then_some((author, name))
}

pub(crate) fn install_directory(root: &std::path::Path, repo: &str, variant: &str) -> Option<std::path::PathBuf> {
    let (author, name) = split_repo(repo)?;
    let folder =
        if variant == "mlx" { "mlx".into() } else { format!("gguf-{}", &hex::encode(Sha256::digest(variant.as_bytes()))[..16]) };
    Some(root.join(author).join(name).join(folder))
}

fn safe_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.ends_with(['.', ' '])
        && !component.chars().any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
}

pub(crate) fn gguf_shard(path: &str) -> Option<(&str, u32, u32)> {
    let (stem, extension) = path.rsplit_once('.')?;
    if !extension.eq_ignore_ascii_case("gguf") {
        return None;
    }
    indexed_shard(stem)
}

fn indexed_shard(stem: &str) -> Option<(&str, u32, u32)> {
    let (prefix, total) = stem.rsplit_once("-of-")?;
    let (prefix, part) = prefix.rsplit_once('-')?;
    if total.len() != 5 || part.len() != 5 {
        return None;
    }
    let (part, total) = (part.parse().ok()?, total.parse().ok()?);
    (part > 0 && part <= total).then_some((prefix, part, total))
}

fn gguf_variants(files: &[CatalogFile]) -> Vec<CatalogVariant> {
    let mut variants = Vec::new();
    let mut groups = BTreeMap::<(&str, u32), BTreeMap<u32, CatalogFile>>::new();
    for file in files {
        let name = file.path.rsplit('/').next().unwrap_or(&file.path);
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("mmproj") || lower.starts_with("imatrix") {
            continue;
        }
        if let Some((prefix, part, total)) = gguf_shard(&file.path) {
            groups.entry((prefix, total)).or_default().insert(part, file.clone());
        } else {
            variants.push(gguf_variant(vec![file.clone()]));
        }
    }
    for ((_, total), parts) in groups {
        if parts.len() == total as usize {
            variants.push(gguf_variant(parts.into_values().collect()));
        }
    }
    variants.sort_by(|a, b| b.size.cmp(&a.size).then(a.id.cmp(&b.id)));
    variants
}

fn gguf_variant(files: Vec<CatalogFile>) -> CatalogVariant {
    let first = &files[0];
    let label = first
        .quantization
        .as_ref()
        .map(|q| q.label.clone())
        .unwrap_or_else(|| first.path.rsplit('/').next().unwrap_or(&first.path).to_string());
    CatalogVariant { id: first.path.clone(), format: ModelFormat::Gguf, label, size: total_size(&files), files }
}

fn mlx_variant(files: Vec<CatalogFile>, config: Option<&RawConfig>) -> Option<CatalogVariant> {
    let files: Vec<_> = files
        .into_iter()
        .filter(|file| {
            let path = file.path.as_str();
            !path.starts_with('.')
                && !path.contains('/')
                && path.rsplit_once('.').is_some_and(|(_, ext)| {
                    matches!(ext, "json" | "safetensors" | "model" | "txt" | "tiktoken" | "jinja" | "vocab" | "merges" | "spm")
                })
        })
        .collect();
    let weights: Vec<_> = files.iter().filter_map(|file| file.path.strip_suffix(".safetensors")).collect();
    if weights.is_empty() || !files.iter().any(|file| file.path == "config.json") {
        return None;
    }
    let mut shards = BTreeMap::new();
    for weight in weights {
        if let Some((prefix, part, total)) = indexed_shard(weight) {
            shards.entry((prefix, total)).or_insert_with(std::collections::BTreeSet::new).insert(part);
        }
    }
    if shards.iter().any(|((_, total), parts)| parts.len() != *total as usize) {
        return None;
    }
    let bits = config.and_then(|c| c.quantization_config.as_ref().or(c.quantization.as_ref())).and_then(|quant| quant.bits);
    Some(CatalogVariant {
        id: "mlx".into(),
        format: ModelFormat::Mlx,
        label: bits.map_or_else(|| "MLX weights".into(), |bits| format!("{bits}-bit")),
        size: total_size(&files),
        files,
    })
}

fn total_size(files: &[CatalogFile]) -> Option<u64> {
    files.iter().try_fold(0u64, |sum, file| sum.checked_add(file.size?))
}

/// Hugging Face's HTTP API.
pub struct Catalog {
    endpoint: String,
    token: Option<String>,
    http: reqwest::Client,
    searches: RequestCache<(String, usize, String, String), Vec<CatalogEntry>>,
    repositories: RequestCache<(String, String), CatalogRepo>,
    avatars: RequestCache<String, Option<CatalogImage>>,
    images: RequestCache<String, CatalogImage>,
}

impl Catalog {
    pub fn new(endpoint: impl Into<String>, token: Option<String>) -> Self {
        Catalog {
            endpoint: endpoint.into().trim_end_matches('/').to_string(),
            token,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .user_agent(concat!("misaka-studio/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client builds"),
            searches: RequestCache::new(Duration::from_secs(30), 64),
            repositories: RequestCache::new(Duration::from_secs(60), 32),
            avatars: RequestCache::new(Duration::from_secs(3600), 128),
            images: RequestCache::new(Duration::from_secs(1800), 96),
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    fn authorized(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(token) => builder.bearer_auth(token),
            None => builder,
        }
    }

    /// Search for GGUF repositories.
    ///
    /// `filter=gguf` is what keeps the list to things this app can actually run: without it, a
    /// search for "qwen" returns hundreds of PyTorch repositories that no local runtime here
    /// loads, and every one of them is a dead end the user has to learn to recognise.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<CatalogEntry>> {
        self.search_models(query, limit, SearchFormat::Gguf, SearchSort::Downloads).await
    }

    pub async fn search_models(&self, query: &str, limit: usize, format: SearchFormat, sort: SearchSort) -> Result<Vec<CatalogEntry>> {
        let query = query.trim();
        let limit = limit.clamp(1, 100);
        let search = |format| self.search_format(query, limit, format, sort);
        match format {
            SearchFormat::Gguf => search("gguf").await,
            SearchFormat::Mlx => search("mlx").await,
            SearchFormat::All => {
                let (gguf, mlx) = tokio::try_join!(search("gguf"), search("mlx"))?;
                let mut seen = std::collections::HashSet::new();
                let mut combined: Vec<_> = gguf
                    .into_iter()
                    .enumerate()
                    .chain(mlx.into_iter().enumerate())
                    .filter(|(_, item)| seen.insert(item.id.clone()))
                    .collect();
                match sort.field(query) {
                    Some("downloads") => combined.sort_by_key(|(_, e)| std::cmp::Reverse(e.downloads)),
                    Some("likes") => combined.sort_by_key(|(_, e)| std::cmp::Reverse(e.likes)),
                    Some("lastModified") => combined.sort_by(|(_, a), (_, b)| b.last_modified.cmp(&a.last_modified)),
                    Some("trendingScore") => combined.sort_by(|(_, a), (_, b)| {
                        b.trending_score.unwrap_or_default().total_cmp(&a.trending_score.unwrap_or_default())
                    }),
                    _ => combined.sort_by_key(|(rank, _)| *rank),
                }
                Ok(combined.into_iter().take(limit).map(|(_, entry)| entry).collect())
            }
        }
    }

    async fn search_format(&self, query: &str, limit: usize, format: &str, sort: SearchSort) -> Result<Vec<CatalogEntry>> {
        let key = (query.to_string(), limit, format.to_string(), format!("{sort:?}"));
        self.searches.load(key, || self.fetch_search(query, limit, format, sort)).await
    }

    async fn fetch_search(&self, query: &str, limit: usize, format: &str, sort: SearchSort) -> Result<Vec<CatalogEntry>> {
        let url = format!("{}/api/models", self.endpoint);
        let limit = limit.to_string();
        let mut params = vec![("filter", format), ("limit", limit.as_str())];
        if let Some((author, name)) = split_repo(query) {
            params.extend([("author", author), ("search", name)]);
        } else if !query.is_empty() {
            params.push(("search", query));
        }
        if let Some(field) = sort.field(query) {
            params.extend([("sort", field), ("direction", "-1")]);
        }
        for field in ["tags", "gated", "downloads", "likes", "lastModified", "pipeline_tag", "trendingScore", "cardData", "gguf"] {
            params.push(("expand[]", field));
        }
        let response = self
            .authorized(self.http.get(&url).query(&params))
            .send()
            .await
            .map_err(|e| Error::Catalog { message: format!("{url}: {e}") })?;

        let response = check(response, &url).await?;
        let raw: Vec<RawModel> = decode(response, &url).await?;
        Ok(raw
            .into_iter()
            .filter_map(RawModel::into_entry)
            .filter(|entry| format != "mlx" || entry.tags.iter().any(|tag| tag == "safetensors"))
            .collect())
    }

    /// The files in a repository, at a revision (`main` by default).
    pub async fn repo(&self, repo_id: &str, revision: Option<&str>) -> Result<CatalogRepo> {
        let revision = revision.unwrap_or("main");
        self.repositories.load((repo_id.to_string(), revision.to_string()), || self.fetch_repo(repo_id, revision)).await
    }

    async fn fetch_repo(&self, repo_id: &str, revision: &str) -> Result<CatalogRepo> {
        let (author, name) =
            split_repo(repo_id).ok_or_else(|| Error::bad_request("Expected a Hugging Face repository in author/model form"))?;
        let info_url = self.url(["api", "models", author, name, "revision", revision])?;
        let response = self
            .authorized(self.http.get(info_url.clone()))
            .send()
            .await
            .map_err(|e| Error::Catalog { message: format!("{info_url}: {e}") })?;
        let response = check(response, info_url.as_str()).await?;
        let info: RawRepoInfo = decode(response, info_url.as_str()).await?;

        let pinned = info.sha.as_deref().unwrap_or(revision);
        let tree = self.tree(author, name, pinned).await?;
        let is_mlx = info.model.tags.iter().any(|tag| tag == "mlx") || info.library_name.as_deref() == Some("mlx");

        let mut all_files: Vec<CatalogFile> = tree
            .into_iter()
            .filter(|e| e.kind.as_deref() != Some("directory"))
            .filter(|e| e.path.split('/').all(safe_component))
            .map(|e| {
                let quantization = misaka_studio_core::quant::Quantization::from_filename(&e.path);
                CatalogFile {
                    // The LFS block carries the authoritative size and digest; the plain `size`
                    // of an LFS pointer is the size of the pointer, not the file.
                    size: e.lfs.as_ref().and_then(|l| l.size).or(e.size),
                    sha256: e.lfs.as_ref().and_then(|l| l.oid.clone()),
                    path: e.path,
                    quantization,
                }
            })
            .collect();
        // Largest first: within one repository, size tracks quality, and the top of the list is
        // where someone with a big machine should be looking.
        all_files.sort_by_key(|f| std::cmp::Reverse(f.size));
        let has_mmproj =
            all_files.iter().any(|f| f.path.rsplit('/').next().unwrap_or(&f.path).to_ascii_lowercase().starts_with("mmproj"));
        let files: Vec<_> = all_files.iter().filter(|f| f.path.to_ascii_lowercase().ends_with(".gguf")).cloned().collect();
        let mut variants = gguf_variants(&files);
        if is_mlx && let Some(variant) = mlx_variant(all_files, info.config.as_ref()) {
            variants.push(variant);
        }
        let config = info.config.unwrap_or_default();
        let license =
            info.model.card_data.as_ref().and_then(|card| card.license.clone()).or_else(|| license_from_tags(&info.model.tags));
        let mut entry = info.model.entry(repo_id.to_string());
        let architecture = entry.architecture.take().or(config.model_type);
        let parameters = entry.parameters.take().or_else(|| info.safetensors.and_then(|t| t.total));
        let context_length = entry.context_length.take().or(config.max_position_embeddings);
        if has_mmproj && !entry.capabilities.iter().any(|c| c == "vision") {
            entry.capabilities.insert(0, "vision".into());
        }
        entry.architecture = architecture.clone();
        entry.parameters = parameters;
        entry.context_length = context_length;
        let base_model = entry.base_model.clone();

        Ok(CatalogRepo {
            id: entry.id.clone(),
            revision: info.sha,
            gated: entry.gated,
            base_model,
            architecture,
            parameters,
            context_length,
            license,
            variants,
            entry,
            files,
        })
    }

    async fn tree(&self, author: &str, name: &str, revision: &str) -> Result<Vec<RawTreeEntry>> {
        let mut url = self.url(["api", "models", author, name, "tree", revision])?;
        url.query_pairs_mut().append_pair("recursive", "true");
        let tree_path = url.path().to_string();
        let mut entries = Vec::new();
        for _ in 0..20 {
            let response = self
                .authorized(self.http.get(url.clone()))
                .send()
                .await
                .map_err(|e| Error::Catalog { message: format!("{url}: {e}") })?;
            let response = check(response, url.as_str()).await?;
            let next = response
                .headers()
                .get(reqwest::header::LINK)
                .and_then(|h| h.to_str().ok())
                .and_then(|links| links.split(',').find(|link| link.contains("rel=\"next\"")))
                .and_then(|link| link.trim().strip_prefix('<')?.split_once('>').map(|(href, _)| href))
                .and_then(|href| url.join(href).ok())
                .filter(|next| next.origin() == url.origin() && next.path() == tree_path && next != &url);
            entries.extend(decode::<Vec<RawTreeEntry>>(response, url.as_str()).await?);
            let Some(next) = next else { return Ok(entries) };
            url = next;
        }
        Err(Error::Catalog { message: "The repository file list exceeds 20 pages".into() })
    }

    pub async fn readme(&self, repo_id: &str, revision: Option<&str>) -> Result<Option<String>> {
        let (author, name) =
            split_repo(repo_id).ok_or_else(|| Error::bad_request("Expected a Hugging Face repository in author/model form"))?;
        let url = self.url([author, name, "resolve", revision.unwrap_or("main"), "README.md"])?;
        let response =
            self.authorized(self.http.get(url.clone())).send().await.map_err(|e| Error::Catalog { message: format!("{url}: {e}") })?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let mut response = check(response, url.as_str()).await?;
        let mut text = Vec::new();
        const MAX_README_BYTES: usize = 256 * 1024;
        while let Some(chunk) = response.chunk().await.map_err(|e| Error::Catalog { message: format!("{url}: {e}") })? {
            let take = (MAX_README_BYTES - text.len()).min(chunk.len());
            text.extend_from_slice(&chunk[..take]);
            if text.len() == MAX_README_BYTES {
                break;
            }
        }
        let text = String::from_utf8_lossy(&text);
        let body = text
            .strip_prefix("---\n")
            .or_else(|| text.strip_prefix("---\r\n"))
            .and_then(|card| card.split_once("\n---"))
            .map_or(text.as_ref(), |(_, body)| body.trim_start());
        Ok(Some(body.to_string()))
    }

    fn url<'a>(&self, segments: impl IntoIterator<Item = &'a str>) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&self.endpoint).map_err(|e| Error::Catalog { message: e.to_string() })?;
        url.path_segments_mut()
            .map_err(|_| Error::bad_request("Hugging Face endpoint must be an HTTP URL"))?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    /// The URL a file is downloaded from.
    pub fn download_url(&self, repo_id: &str, revision: &str, path: &str) -> String {
        self.url(repo_id.split('/').chain(["resolve", revision]).chain(path.split('/'))).map(|url| url.to_string()).unwrap_or_default()
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// Resolve an organization or user avatar on Hugging Face and return its bytes.
    pub async fn avatar(&self, owner: &str) -> Result<Option<CatalogImage>> {
        let valid = safe_component(owner)
            && !owner.starts_with('.')
            && owner.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c));
        if !valid {
            return Err(Error::bad_request("Invalid catalog owner"));
        }
        self.avatars.load(owner.to_ascii_lowercase(), || self.fetch_avatar(owner)).await
    }

    async fn fetch_avatar(&self, owner: &str) -> Result<Option<CatalogImage>> {
        #[derive(Deserialize)]
        struct RawAvatar {
            #[serde(default, rename = "avatarUrl")]
            avatar_url: Option<String>,
        }

        let mut avatar_url = None;
        for kind in ["organizations", "users"] {
            let url = self.url(["api", kind, owner, "avatar"])?;
            let response = self
                .authorized(self.http.get(url.clone()))
                .send()
                .await
                .map_err(|e| Error::Catalog { message: format!("{url}: {e}") })?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                continue;
            }
            let response = check(response, url.as_str()).await?;
            let raw: RawAvatar = decode(response, url.as_str()).await?;
            if let Some(found) = raw.avatar_url.filter(|u| !u.trim().is_empty()) {
                avatar_url = Some(found);
                break;
            }
        }
        let Some(raw_url) = avatar_url else { return Ok(None) };
        let base = reqwest::Url::parse(&self.endpoint).map_err(|e| Error::Catalog { message: e.to_string() })?;
        let resolved = base.join(&raw_url).map_err(|e| Error::Catalog { message: e.to_string() })?;
        if !self.allowed_image_url(&resolved)? {
            return Ok(None);
        }
        const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;
        self.fetch_binary_image(&resolved, MAX_AVATAR_BYTES).await.map(Some)
    }

    /// Fetch an image referenced by a repository README (relative asset or allowed HTTPS URL).
    pub async fn image(&self, repo_id: Option<&str>, revision: Option<&str>, src: &str) -> Result<CatalogImage> {
        let resolved = self.resolve_image_url(repo_id, revision, src)?;
        if !self.allowed_image_url(&resolved)? {
            return Err(Error::bad_request("Image host is not permitted by catalog policy"));
        }
        const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
        self.images.load(resolved.to_string(), || self.fetch_binary_image(&resolved, MAX_IMAGE_BYTES)).await
    }

    fn resolve_image_url(&self, repo_id: Option<&str>, revision: Option<&str>, src: &str) -> Result<reqwest::Url> {
        let trimmed = src.trim();
        if trimmed.is_empty() {
            return Err(Error::bad_request("Missing image source"));
        }
        let endpoint = reqwest::Url::parse(&self.endpoint).map_err(|e| Error::Catalog { message: e.to_string() })?;
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let mut parsed = reqwest::Url::parse(trimmed).map_err(|_| Error::bad_request("Invalid image URL"))?;
            // Rewrite Hugging Face `/blob/<rev>/...` viewer URLs into `/resolve/<rev>/...` raw URLs.
            let is_hub = parsed.origin() == endpoint.origin() || matches!(parsed.host_str(), Some("huggingface.co" | "hf.co"));
            if is_hub
                && let Some(segments) = parsed.path_segments().map(|s| s.map(str::to_string).collect::<Vec<_>>())
                && segments.len() >= 5
                && matches!(segments[2].as_str(), "blob" | "raw")
                && let Ok(mut out) = parsed.path_segments_mut()
            {
                out.clear();
                out.push(&segments[0]);
                out.push(&segments[1]);
                out.push("resolve");
                for rest in &segments[3..] {
                    out.push(rest);
                }
            }
            return Ok(parsed);
        }
        let repo_id = repo_id.ok_or_else(|| Error::bad_request("Relative image path requires a repository id"))?;
        let (author, name) =
            split_repo(repo_id).ok_or_else(|| Error::bad_request("Expected a Hugging Face repository in author/model form"))?;
        let clean = trimmed.split(['?', '#']).next().unwrap_or(trimmed).trim_start_matches("./").trim_start_matches('/');
        let parts: Vec<&str> = clean.split('/').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() || !parts.iter().copied().all(safe_component) {
            return Err(Error::bad_request("Invalid relative image path"));
        }
        self.url([author, name, "resolve", revision.unwrap_or("main")].into_iter().chain(parts))
    }

    fn allowed_image_url(&self, url: &reqwest::Url) -> Result<bool> {
        let endpoint = reqwest::Url::parse(&self.endpoint).map_err(|e| Error::Catalog { message: e.to_string() })?;
        if url.origin() == endpoint.origin() {
            return Ok(true);
        }
        if url.scheme() != "https" {
            return Ok(false);
        }
        let Some(host) = url.host_str() else { return Ok(false) };
        let host = host.to_ascii_lowercase();
        Ok(host == "huggingface.co"
            || host.ends_with(".huggingface.co")
            || host == "hf.co"
            || host.ends_with(".hf.co")
            || host == "raw.githubusercontent.com"
            || host == "user-images.githubusercontent.com"
            || host == "avatars.githubusercontent.com"
            || host == "camo.githubusercontent.com"
            || host == "objects.githubusercontent.com"
            || host == "github.com"
            || host == "img.shields.io")
    }

    async fn fetch_binary_image(&self, url: &reqwest::Url, max_bytes: usize) -> Result<CatalogImage> {
        let endpoint = reqwest::Url::parse(&self.endpoint).map_err(|e| Error::Catalog { message: e.to_string() })?;
        let builder = self.http.get(url.clone());
        let builder = if url.origin() == endpoint.origin() { self.authorized(builder) } else { builder };
        let response = builder.send().await.map_err(|e| Error::Catalog { message: format!("{url}: {e}") })?;
        let mut response = check(response, url.as_str()).await?;
        let header_mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(|v| v.trim().to_ascii_lowercase());
        let guessed = mime_guess::from_path(url.path()).first().map(|m| m.essence_str().to_string());
        let content_type = match header_mime.as_deref() {
            Some(m) if m.starts_with("image/") => m.to_string(),
            Some("application/octet-stream") | None => match guessed {
                Some(m) if m.starts_with("image/") => m,
                _ => return Err(Error::Catalog { message: format!("{url}: response is not an image") }),
            },
            Some(other) => return Err(Error::Catalog { message: format!("{url}: expected image/*, got {other}") }),
        };
        let mut buf = bytes::BytesMut::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| Error::Catalog { message: format!("{url}: {e}") })? {
            if buf.len() + chunk.len() > max_bytes {
                return Err(Error::Catalog { message: format!("{url}: image exceeds {} MiB limit", max_bytes >> 20) });
            }
            buf.extend_from_slice(&chunk);
        }
        Ok(CatalogImage { content_type, bytes: buf.freeze() })
    }
}

/// Turn a non-2xx into an error that names what to do about it.
/// Decode a JSON body, saying *what* failed when it fails.
///
/// `Response::json()` collapses every parse failure into the string "error decoding response
/// body" — no field, no offset, no clue whether the cause was the network or the shape. Hugging
/// Face adds and changes fields regularly, so that is precisely the error a user of this app is
/// most likely to hit, and it is the one that tells them least.
///
/// Reading the body first costs one allocation and buys a serde error that names the field and
/// the line, plus the text that was actually there. A search response is kilobytes; a repository
/// tree is tens of kilobytes. Neither is worth protecting at the cost of an unactionable error.
async fn decode<T: serde::de::DeserializeOwned>(response: reqwest::Response, url: &str) -> Result<T> {
    let body =
        response.text().await.map_err(|e| Error::Catalog { message: format!("{url}: the response body could not be read: {e}") })?;
    serde_json::from_str(&body).map_err(|e| {
        // The line serde stopped on, so the message carries the offending text and not just a
        // coordinate the reader has no way to look up.
        let context = body.lines().nth(e.line().saturating_sub(1)).map(|line| {
            let from = e.column().saturating_sub(60);
            let snippet: String = line.chars().skip(from).take(160).collect();
            format!(" — near: {snippet}")
        });
        Error::Catalog {
            message: format!("{url}: the response did not match what this client expects: {e}{}", context.unwrap_or_default()),
        }
    })
}

async fn check(response: reqwest::Response, url: &str) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let hint = match status.as_u16() {
        401 | 403 => " — this repository is gated or private; accept its licence on Hugging Face and add an access token in Settings",
        404 => " — no such repository or revision",
        429 => " — Hugging Face is rate-limiting this address; adding an access token in Settings raises the limit",
        _ => "",
    };
    Err(Error::Catalog { message: format!("{url} returned {status}{hint}. {}", body.chars().take(200).collect::<String>()) })
}

// --- wire shapes -----------------------------------------------------------
// Deserialization structs kept private and lenient: Hugging Face adds fields regularly, and a
// strict shape here would turn every upstream addition into a broken search box.

#[derive(Deserialize)]
struct RawModel {
    /// Hugging Face sends **both** `id` and `modelId`, carrying the same value.
    ///
    /// `#[serde(alias = "modelId")]` looks like the lenient way to accept either name and is the
    /// exact opposite: an alias points both names at one field, so a payload carrying both is a
    /// *duplicate field* and serde rejects the entire response — every search, for every query,
    /// with an error that named neither the field nor the cause. Two optional fields accept
    /// either name, both, or neither.
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "modelId")]
    model_id: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default)]
    gated: Option<Gated>,
    #[serde(default, rename = "pipeline_tag")]
    pipeline_tag: Option<String>,
    #[serde(default, rename = "trendingScore")]
    trending_score: Option<f64>,
    #[serde(default, rename = "cardData")]
    card_data: Option<RawCardData>,
    #[serde(default)]
    gguf: Option<RawGguf>,
}

fn base_model_from_tags(tags: &[String]) -> Option<String> {
    let mut fallback = None;
    for tag in tags {
        let Some(rest) = tag.strip_prefix("base_model:") else { continue };
        if split_repo(rest).is_some() {
            return Some(rest.to_string());
        }
        if fallback.is_none()
            && let Some(inner) = rest
                .strip_prefix("quantized:")
                .or_else(|| rest.strip_prefix("finetune:"))
                .or_else(|| rest.strip_prefix("adapter:"))
                .or_else(|| rest.strip_prefix("merge:"))
            && split_repo(inner).is_some()
        {
            fallback = Some(inner.to_string());
        }
    }
    fallback
}

fn license_from_tags(tags: &[String]) -> Option<String> {
    tags.iter().find_map(|tag| tag.strip_prefix("license:").map(str::to_string))
}

fn infer_capabilities(pipeline_tag: Option<&str>, tags: &[String], chat_template: Option<&str>) -> Vec<String> {
    let has_tag = |needle: &str| tags.iter().any(|t| t.eq_ignore_ascii_case(needle));
    let tpl = chat_template.unwrap_or_default();
    let mut out = Vec::new();
    if pipeline_tag == Some("image-text-to-text")
        || has_tag("image-text-to-text")
        || has_tag("vision")
        || has_tag("multimodal")
        || has_tag("vlm")
    {
        out.push("vision".into());
    }
    if has_tag("tool-calling")
        || has_tag("function-calling")
        || has_tag("tool-use")
        || has_tag("tools")
        || tpl.contains("if tools")
        || tpl.contains("for tool in tools")
        || tpl.contains("<|message_tool|>")
        || tpl.contains("<tool_call>")
        || tpl.contains("tool_calls")
        || tpl.contains("[TOOL_CALLS]")
    {
        out.push("tools".into());
    }
    if has_tag("reasoning")
        || has_tag("thinking")
        || has_tag("cot")
        || tpl.contains("reasoning_effort")
        || tpl.contains("<think>")
        || tpl.contains("enable_thinking")
        || tpl.contains("<|thought|>")
    {
        out.push("reasoning".into());
    }
    out
}

impl RawModel {
    /// `None` for an entry carrying no identifier under either name: there is nothing to open and
    /// nothing to download, so it is dropped rather than allowed to fail the whole search.
    fn into_entry(self) -> Option<CatalogEntry> {
        let id = self.id.clone().or_else(|| self.model_id.clone())?;
        Some(self.entry(id))
    }

    fn entry(self, fallback: String) -> CatalogEntry {
        let id = self.id.or(self.model_id).unwrap_or(fallback);
        let card = self.card_data.unwrap_or_default();
        let gguf = self.gguf.unwrap_or_default();
        let mut merged_tags = self.tags;
        for extra in card.tags.unwrap_or_default() {
            if !merged_tags.iter().any(|t| t.eq_ignore_ascii_case(&extra)) {
                merged_tags.push(extra);
            }
        }
        let pipeline_tag = self.pipeline_tag.or(card.pipeline_tag);
        let base_model = card.base_model.and_then(BaseModel::first).or_else(|| base_model_from_tags(&merged_tags));
        let creator = base_model
            .as_deref()
            .and_then(split_repo)
            .map(|(owner, _)| owner.to_string())
            .or_else(|| split_repo(&id).map(|(owner, _)| owner.to_string()));
        let capabilities = infer_capabilities(pipeline_tag.as_deref(), &merged_tags, gguf.chat_template.as_deref());
        let summary = card.model_summary.or(card.description).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

        CatalogEntry {
            id,
            downloads: self.downloads,
            likes: self.likes,
            tags: merged_tags,
            last_modified: self.last_modified,
            gated: self.gated.map(|g| g.is_gated()).unwrap_or(false),
            pipeline_tag,
            trending_score: self.trending_score,
            base_model,
            creator,
            architecture: gguf.architecture,
            parameters: gguf.total,
            context_length: gguf.context_length,
            capabilities,
            summary,
        }
    }
}

/// `gated` is `false`, `"auto"` or `"manual"` depending on the repository — an untagged union
/// that a plain `bool` field fails to parse, taking the whole search result with it.
#[derive(Deserialize)]
#[serde(untagged)]
enum Gated {
    Flag(bool),
    Kind(String),
}

impl Gated {
    fn is_gated(&self) -> bool {
        match self {
            Gated::Flag(b) => *b,
            Gated::Kind(s) => s != "false",
        }
    }
}

#[derive(Deserialize)]
struct RawRepoInfo {
    #[serde(flatten)]
    model: RawModel,
    #[serde(default)]
    sha: Option<String>,
    config: Option<RawConfig>,
    safetensors: Option<RawWeights>,
    library_name: Option<String>,
}

#[derive(Default, Deserialize)]
struct RawCardData {
    #[serde(default)]
    base_model: Option<BaseModel>,
    license: Option<String>,
    pipeline_tag: Option<String>,
    tags: Option<Vec<String>>,
    model_summary: Option<String>,
    description: Option<String>,
}

#[derive(Default, Deserialize)]
struct RawGguf {
    architecture: Option<String>,
    context_length: Option<u64>,
    total: Option<u64>,
    chat_template: Option<String>,
}

#[derive(Default, Deserialize)]
struct RawConfig {
    model_type: Option<String>,
    max_position_embeddings: Option<u64>,
    quantization_config: Option<RawQuantization>,
    quantization: Option<RawQuantization>,
}

#[derive(Deserialize)]
struct RawQuantization {
    bits: Option<u64>,
}

#[derive(Deserialize)]
struct RawWeights {
    total: Option<u64>,
}

/// `base_model` is a string in most cards and a list in merges.
#[derive(Deserialize)]
#[serde(untagged)]
enum BaseModel {
    One(String),
    Many(Vec<String>),
}

impl BaseModel {
    fn first(self) -> Option<String> {
        match self {
            BaseModel::One(s) => Some(s),
            BaseModel::Many(v) => v.into_iter().next(),
        }
    }
}

#[derive(Deserialize)]
struct RawTreeEntry {
    #[serde(rename = "type")]
    kind: Option<String>,
    path: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    lfs: Option<RawLfs>,
}

#[derive(Deserialize)]
struct RawLfs {
    #[serde(default)]
    oid: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;
    use axum::routing::get;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[tokio::test]
    async fn concurrent_requests_share_a_result_and_failures_do_not_become_a_negative_cache() {
        let cache = Arc::new(RequestCache::new(Duration::from_secs(30), 4));
        let calls = Arc::new(AtomicU64::new(0));
        let mut requests = Vec::new();
        for _ in 0..100 {
            let cache = cache.clone();
            let calls = calls.clone();
            requests.push(tokio::spawn(async move {
                cache
                    .load("same", || async {
                        calls.fetch_add(1, Ordering::Relaxed);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Err::<u64, _>(Error::Catalog { message: "temporary outage".into() })
                    })
                    .await
            }));
        }
        for request in requests {
            assert!(request.await.unwrap().unwrap_err().to_string().contains("temporary outage"));
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let value = cache
            .load("same", || async {
                calls.fetch_add(1, Ordering::Relaxed);
                Ok(42)
            })
            .await
            .unwrap();
        assert_eq!(value, 42);
        assert_eq!(calls.load(Ordering::Relaxed), 2, "a later request can recover immediately");
    }

    #[tokio::test]
    async fn cancelled_initializers_do_not_leave_other_callers_waiting_forever() {
        let cache = Arc::new(RequestCache::new(Duration::from_secs(30), 4));
        let (started, ready) = tokio::sync::oneshot::channel();
        let first_cache = cache.clone();
        let first = tokio::spawn(async move {
            first_cache
                .load("same", || async {
                    let _ = started.send(());
                    std::future::pending::<Result<u64>>().await
                })
                .await
        });
        ready.await.unwrap();
        let next_cache = cache.clone();
        let next = tokio::spawn(async move { next_cache.load("same", || async { Ok(7) }).await });
        tokio::task::yield_now().await;
        first.abort();
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), next).await.unwrap().unwrap().unwrap(), 7);
    }

    #[tokio::test]
    async fn successful_entries_expire_and_least_recently_used_entries_are_bounded() {
        let cache = RequestCache::new(Duration::from_secs(30), 2);
        assert_eq!(cache.load(1, || async { Ok(11) }).await.unwrap(), 11);
        assert_eq!(cache.load(2, || async { Ok(22) }).await.unwrap(), 22);
        assert_eq!(cache.load(1, || async { panic!("fresh result is reused") }).await.unwrap(), 11);
        cache.load(3, || async { Ok(33) }).await.unwrap();
        assert_eq!(cache.entries.lock().await.len(), 2);
        assert!(cache.entries.lock().await.contains_key(&1));
        assert!(!cache.entries.lock().await.contains_key(&2));
        cache.entries.lock().await.get_mut(&1).unwrap().at = Instant::now() - Duration::from_secs(31);
        assert_eq!(cache.load(1, || async { Ok(44) }).await.unwrap(), 44, "expired entries fetch again");
    }

    async fn counting_hub() -> (String, Arc<AtomicU64>, Arc<std::sync::Mutex<Vec<String>>>) {
        let calls = Arc::new(AtomicU64::new(0));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let search_calls = calls.clone();
        let search_seen = seen.clone();
        let tree_calls = calls.clone();
        let tree_seen = seen.clone();
        let app = axum::Router::new()
            .route(
                "/api/models",
                get(move |headers: axum::http::HeaderMap| {
                    let calls = search_calls.clone();
                    let seen = search_seen.clone();
                    async move {
                        calls.fetch_add(1, Ordering::Relaxed);
                        seen.lock().unwrap().push(
                            headers.get("authorization").and_then(|value| value.to_str().ok()).unwrap_or("anonymous").to_string(),
                        );
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        Json(serde_json::json!([{ "id": "org/model", "gated": false }]))
                    }
                }),
            )
            .route(
                "/api/models/{*rest}",
                get(move |axum::extract::Path(rest): axum::extract::Path<String>| {
                    let calls = tree_calls.clone();
                    let seen = tree_seen.clone();
                    async move {
                        calls.fetch_add(1, Ordering::Relaxed);
                        seen.lock().unwrap().push(rest.clone());
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        Json(if rest.contains("/tree/") {
                            serde_json::json!([{ "type": "file", "path": "model.gguf", "size": 64 }])
                        } else {
                            serde_json::json!({ "sha": "immutable-commit", "gated": false })
                        })
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), calls, seen)
    }

    #[tokio::test]
    async fn actual_search_http_is_reused_without_crossing_limits_or_credentials() {
        let (endpoint, calls, seen) = counting_hub().await;
        let catalog = Catalog::new(&endpoint, Some("fixture-token-a".into()));
        for _ in 0..10 {
            assert_eq!(catalog.search("model", 20).await.unwrap().len(), 1);
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        catalog.search("model", 100).await.unwrap();
        catalog.search("model", 1000).await.unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2, "the normalized limit is part of the cache key");
        Catalog::new(&endpoint, Some("fixture-token-b".into())).search("model", 20).await.unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        assert_eq!(seen.lock().unwrap().last().map(String::as_str), Some("Bearer fixture-token-b"));
    }

    #[tokio::test]
    async fn simultaneous_repo_http_calls_share_two_requests_and_pin_the_tree_revision() {
        let (endpoint, calls, seen) = counting_hub().await;
        let catalog = Arc::new(Catalog::new(endpoint, None));
        let mut requests = Vec::new();
        for _ in 0..100 {
            let catalog = catalog.clone();
            requests.push(tokio::spawn(async move { catalog.repo("org/model", None).await.unwrap() }));
        }
        for request in requests {
            assert_eq!(request.await.unwrap().revision.as_deref(), Some("immutable-commit"));
        }
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert_eq!(*seen.lock().unwrap(), vec!["org/model/revision/main", "org/model/tree/immutable-commit"]);
    }

    /// A stand-in for the Hugging Face API, so the catalog is tested against HTTP rather than
    /// against a mocked client — the wire shapes are exactly what this module gets wrong.
    async fn fake_hub() -> String {
        let app = axum::Router::new()
            .route(
                "/api/models",
                get(|| async {
                    Json(serde_json::json!([
                        // **Both** `id` and `modelId`, because that is what the real endpoint
                        // sends on every entry. This fixture used to carry one name per entry and
                        // never both, which is how `#[serde(alias = "modelId")]` on `id` — a
                        // duplicate field against a real response — passed its own test while
                        // failing every search in the shipped app.
                        {
                            "_id": "66e98ae0be5913b903da60c1",
                            "id": "bartowski/Qwen3-4B-Instruct-GGUF",
                            "modelId": "bartowski/Qwen3-4B-Instruct-GGUF",
                            "downloads": 12345, "likes": 42,
                            "tags": ["gguf", "text-generation"],
                            "lastModified": "2026-01-02T03:04:05.000Z",
                            "gated": false,
                            "pipeline_tag": "text-generation"
                        },
                        // `gated: "manual"` — a string where a bool would be expected. The shape
                        // that breaks a naive client.
                        { "id": "meta/gated-model-GGUF", "downloads": 7, "gated": "manual" },
                        // Only `modelId`: the older shape, still accepted.
                        { "modelId": "legacy/only-model-id-GGUF", "downloads": 3 },
                        // No identifier under either name — dropped, and it must not cost the
                        // user the other three results.
                        { "downloads": 1 }
                    ]))
                }),
            )
            .route(
                "/api/models/{*rest}",
                get(|axum::extract::Path(rest): axum::extract::Path<String>| async move {
                    if rest.contains("/tree/") {
                        Json(serde_json::json!([
                            { "type": "directory", "path": "docs" },
                            { "type": "file", "path": "README.md", "size": 900 },
                            { "type": "file", "path": "Qwen3-4B-Q4_K_M.gguf", "size": 135,
                              "lfs": { "oid": "aa11", "size": 2_600_000_000u64 } },
                            { "type": "file", "path": "Qwen3-4B-Q8_0.gguf", "size": 135,
                              "lfs": { "oid": "bb22", "size": 4_300_000_000u64 } }
                        ]))
                    } else {
                        Json(serde_json::json!({
                            "sha": "abc123def456",
                            "gated": false,
                            "cardData": { "base_model": ["Qwen/Qwen3-4B-Instruct"] }
                        }))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("binds");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn search_reads_both_id_shapes_and_both_gated_shapes() {
        let catalog = Catalog::new(fake_hub().await, None);
        let results = catalog.search("qwen", 10).await.expect("searches");
        assert_eq!(results.len(), 3, "the entry with no identifier is dropped, the rest survive");
        // Carries `id` and `modelId` together, as every real entry does.
        assert_eq!(results[0].id, "bartowski/Qwen3-4B-Instruct-GGUF");
        assert_eq!(results[0].downloads, 12345);
        assert!(!results[0].gated);
        assert_eq!(results[1].id, "meta/gated-model-GGUF");
        assert!(results[1].gated, "\"manual\" is gated");
        assert_eq!(results[2].id, "legacy/only-model-id-GGUF", "`modelId` alone still identifies a repository");
    }

    #[tokio::test]
    async fn a_repo_listing_gives_sizes_digests_and_quantizations() {
        let catalog = Catalog::new(fake_hub().await, None);
        let repo = catalog.repo("bartowski/Qwen3-4B-Instruct-GGUF", None).await.expect("lists");
        assert_eq!(repo.revision.as_deref(), Some("abc123def456"));
        assert_eq!(repo.base_model.as_deref(), Some("Qwen/Qwen3-4B-Instruct"));
        assert_eq!(repo.files.len(), 2, "only GGUFs");

        // Largest first, and the LFS size wins over the pointer's own size.
        assert_eq!(repo.files[0].path, "Qwen3-4B-Q8_0.gguf");
        assert_eq!(repo.files[0].size, Some(4_300_000_000));
        assert_eq!(repo.files[0].sha256.as_deref(), Some("bb22"));
        assert_eq!(repo.files[1].quantization.as_ref().expect("quant").label, "Q4_K_M");
    }

    #[test]
    fn only_complete_weight_sets_are_download_options() {
        let file = |path: &str, size| CatalogFile {
            path: path.into(),
            size: Some(size),
            sha256: None,
            quantization: misaka_studio_core::quant::Quantization::from_filename(path),
        };
        let files = [
            file("Q4/example-Q4_K_M-00002-of-00002.gguf", 2),
            file("Q4/example-Q4_K_M-00001-of-00002.gguf", 4),
            file("Q8/example-Q8_0-00001-of-00002.gguf", 7),
            file("mmproj-example.gguf", 1),
            file("imatrix_clean.gguf", 1),
        ];
        let choices = gguf_variants(&files);
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].label, "Q4_K_M");
        assert_eq!(choices[0].files[0].path, files[1].path);
        assert_eq!(choices[0].size, Some(6));

        let mut mlx = vec![file("config.json", 1), file("model-00001-of-00002.safetensors", 2)];
        assert!(mlx_variant(mlx.clone(), None).is_none());
        mlx.push(file("model-00002-of-00002.safetensors", 2));
        mlx.push(file("tokenizer.json", 3));
        let option = mlx_variant(mlx, None).unwrap();
        assert_eq!(option.files.len(), 4);
        assert_eq!(option.size, Some(8));
    }

    #[tokio::test]
    async fn a_missing_repo_explains_itself() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("binds");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let app = axum::Router::new()
                .route("/api/models/{*rest}", get(|| async { (axum::http::StatusCode::NOT_FOUND, "Repo not found") }));
            let _ = axum::serve(listener, app).await;
        });
        let catalog = Catalog::new(format!("http://{addr}"), None);
        let err = catalog.repo("nobody/nothing", None).await.unwrap_err();
        assert!(err.to_string().contains("no such repository"), "got {err}");
    }

    #[test]
    fn download_urls_pin_the_revision() {
        let catalog = Catalog::new("https://example.test", None);
        assert_eq!(
            catalog.download_url("org/repo", "abc123", "model-Q4_K_M.gguf"),
            "https://example.test/org/repo/resolve/abc123/model-Q4_K_M.gguf"
        );
    }

    #[tokio::test]
    async fn avatars_readme_images_and_capabilities_resolve_through_catalog() {
        let png: &'static [u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        let app = axum::Router::new()
            .route(
                "/api/models",
                get(|| async {
                    Json(serde_json::json!([{
                        "id": "lmstudio-community/Inkling-2-Mini-GGUF",
                        "downloads": 31613,
                        "likes": 8,
                        "tags": ["gguf", "base_model:thinkingmachines/Inkling-2-Mini", "image-text-to-text"],
                        "cardData": { "model_summary": "Open-weight multimodal mixture-of-experts model." },
                        "gguf": {
                            "total": 26_400_000_000u64,
                            "architecture": "inkling2_loop",
                            "context_length": 1_048_576u64,
                            "chat_template": "{% if tools %}<|message_tool|>{% endif %}{{ reasoning_effort }}"
                        }
                    }]))
                }),
            )
            .route(
                "/api/organizations/{owner}/avatar",
                get(|axum::extract::Path(owner): axum::extract::Path<String>| async move {
                    if owner == "thinkingmachines" {
                        (axum::http::StatusCode::OK, Json(serde_json::json!({ "avatarUrl": "/avatars/tm.png" })))
                    } else {
                        (axum::http::StatusCode::NOT_FOUND, Json(serde_json::json!({})))
                    }
                }),
            )
            .route("/avatars/tm.png", get(move || async move { ([(axum::http::header::CONTENT_TYPE, "image/png")], png) }))
            .route(
                "/thinkingmachines/Inkling-2-Mini/resolve/main/assets/arch.png",
                get(move || async move { ([(axum::http::header::CONTENT_TYPE, "image/png")], png) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("binds");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let endpoint = format!("http://{addr}");
        let catalog = Catalog::new(&endpoint, None);

        let entries = catalog.search("inkling", 10).await.expect("search");
        assert_eq!(entries[0].creator.as_deref(), Some("thinkingmachines"));
        assert_eq!(entries[0].base_model.as_deref(), Some("thinkingmachines/Inkling-2-Mini"));
        assert_eq!(entries[0].architecture.as_deref(), Some("inkling2_loop"));
        assert_eq!(entries[0].parameters, Some(26_400_000_000));
        assert_eq!(entries[0].capabilities, vec!["vision", "tools", "reasoning"]);
        assert_eq!(entries[0].summary.as_deref(), Some("Open-weight multimodal mixture-of-experts model."));

        let avatar = catalog.avatar("thinkingmachines").await.expect("avatar").expect("present");
        assert_eq!(avatar.content_type, "image/png");
        assert_eq!(avatar.bytes.as_ref(), png);

        let relative =
            catalog.image(Some("thinkingmachines/Inkling-2-Mini"), Some("main"), "./assets/arch.png").await.expect("relative image");
        assert_eq!(relative.bytes.as_ref(), png);

        let blob_url = format!("{endpoint}/thinkingmachines/Inkling-2-Mini/blob/main/assets/arch.png");
        let rewritten = catalog.image(None, None, &blob_url).await.expect("blob url rewritten to resolve");
        assert_eq!(rewritten.bytes.as_ref(), png);

        let blocked = catalog.image(None, None, "http://169.254.169.254/latest/meta-data").await;
        assert!(blocked.is_err(), "untrusted image hosts must be rejected");
    }
}
