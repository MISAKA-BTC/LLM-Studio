//! A backend that generates text without a model.
//!
//! It exists for three things that are otherwise impossible: testing the streaming path in CI
//! (no GPU, no 4 GB download), building the UI without waiting on a load, and giving a first-run
//! user something that responds before they have downloaded anything.
//!
//! Its output is a **deterministic function of the prompt**, which is what makes it usable as a
//! test fixture: the same request produces the same bytes, so the inference hash over a mock run
//! is stable and the provenance path can be tested end to end.
//!
//! It is never a silent fallback. Selecting it is explicit, every reply says what it is, and its
//! runtime class tag (`misaka-studio-mock/v1`) is distinct — so a record produced here can never
//! be confused for one produced by a real engine.

use super::{
    Availability, GeneratedImage, GenerationRequest, ImageBackend, ImageLoadRequest, InferenceBackend, LoadRequest, LoadedImageModel,
    LoadedModel, StreamEvent, Txt2ImgRequest, Usage, approximate_tokens,
};
use crate::{Error, Result};
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use misaka_studio_core::provenance::RuntimeDescriptor;
use std::sync::Mutex;
use std::time::Duration;

/// The class tag every mock record carries. Distinct by construction: nothing that ran on real
/// weights can land in this class.
pub const MOCK_CLASS_TAG: &str = "misaka-studio-mock/v1";

pub struct MockBackend {
    loaded: Mutex<Option<LoadedModel>>,
    /// Delay between tokens. Zero in tests, ~20 ms when driving the UI so streaming looks like
    /// streaming.
    token_delay: Duration,
}

impl MockBackend {
    pub fn new(token_delay: Duration) -> Self {
        MockBackend { loaded: Mutex::new(None), token_delay }
    }

    /// The reply, as a pure function of the request.
    fn compose(request: &GenerationRequest) -> String {
        let ask = request
            .prompt
            .clone()
            .or_else(|| request.messages.iter().rev().find(|m| m.role == "user").map(|m| m.content.clone()))
            .unwrap_or_default();
        let trimmed: String = ask.chars().take(160).collect();
        format!(
            "This is the LLM Studio mock runtime — no model is loaded, so nothing here was inferred. \
             You said: \"{trimmed}\". Load a GGUF from the Models tab to get real answers; every reply \
             then carries its model hash, runtime identity and inference hash."
        )
    }

    /// The reasoning a thinking model would stream ahead of that reply — only when the last user
    /// turn carries Qwen3's `/think` switch and the request did not turn thinking off.
    ///
    /// Opt-in, so every other mock reply, and every fixture built on one, is byte-for-byte what it
    /// was; and a pure function of the request like the reply. What it is for is the UI: the
    /// thinking display can be built and tested against `--backend mock`, with no model loaded.
    fn compose_reasoning(request: &GenerationRequest) -> Option<String> {
        if request.disable_thinking || request.prompt.is_some() {
            return None;
        }
        let ask = request.messages.iter().rev().find(|m| m.role == "user")?;
        ask.content.contains("/think").then(|| {
            format!(
                "The user wrote {} characters and asked me to think first. This is the mock runtime, so there is \
                 nothing to reason about; these words only exercise the reasoning stream.",
                ask.content.chars().count()
            )
        })
    }
}

impl Default for MockBackend {
    fn default() -> Self {
        Self::new(Duration::from_millis(20))
    }
}

impl InferenceBackend for MockBackend {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn descriptor(&self) -> BoxFuture<'_, RuntimeDescriptor> {
        Box::pin(async {
            RuntimeDescriptor {
                backend: "mock".into(),
                engine_commit: "mock".into(),
                engine_patch_sha256: "unpatched".into(),
                engine_build_number: 0,
                build_profile: "mock/deterministic/v1".into(),
                class_tag: MOCK_CLASS_TAG.into(),
            }
        })
    }

    fn availability(&self) -> BoxFuture<'_, Availability> {
        Box::pin(async { Availability::Available { detail: "built in; generates canned text".into() } })
    }

    fn load(&self, request: LoadRequest) -> BoxFuture<'_, Result<LoadedModel>> {
        Box::pin(async move {
            let model = LoadedModel {
                model_id: request.model_id,
                context_size: request.context_size,
                gpu_layers: Some(0),
                load_ms: 0,
                offload: None,
            };
            *self.loaded.lock().expect("mock lock") = Some(model.clone());
            Ok(model)
        })
    }

    fn unload(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            *self.loaded.lock().expect("mock lock") = None;
            Ok(())
        })
    }

    fn loaded(&self) -> BoxFuture<'_, Option<LoadedModel>> {
        Box::pin(async { self.loaded.lock().expect("mock lock").clone() })
    }

    fn generate(&self, request: GenerationRequest) -> BoxFuture<'_, Result<BoxStream<'static, Result<StreamEvent>>>> {
        let delay = self.token_delay;
        Box::pin(async move {
            let text = Self::compose(&request);
            let prompt_tokens = approximate_tokens(
                &request
                    .prompt
                    .clone()
                    .unwrap_or_else(|| request.messages.iter().map(|m| m.content.as_str()).collect::<Vec<_>>().join(" ")),
            );
            // Split on spaces but keep them, so reassembling the deltas reproduces the text
            // exactly — a stream whose concatenation differs from the whole answer is the bug
            // this shape prevents. Reasoning, when asked for, comes first and spends the same
            // token budget, as a real thinking model's does.
            let reasoning = Self::compose_reasoning(&request).unwrap_or_default();
            let chunks: Vec<StreamEvent> = reasoning
                .split_inclusive(' ')
                .map(|c| StreamEvent::Reasoning(c.to_string()))
                .chain(text.split_inclusive(' ').map(|c| StreamEvent::Delta(c.to_string())))
                .collect();
            let completion_tokens = chunks.len() as u64;
            let limit = request.params.max_tokens.max(1);

            let stream = async_stream(move |tx| async move {
                for (i, chunk) in chunks.into_iter().enumerate() {
                    if i as u64 >= limit {
                        let _ = tx
                            .send(Ok(StreamEvent::Done {
                                usage: Usage { prompt_tokens, completion_tokens: limit, total_tokens: prompt_tokens + limit },
                                finish_reason: "length".into(),
                            }))
                            .await;
                        return;
                    }
                    if tx.send(Ok(chunk)).await.is_err() {
                        return; // The client hung up; stop generating.
                    }
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                }
                let _ = tx
                    .send(Ok(StreamEvent::Done {
                        usage: Usage { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
                        finish_reason: "stop".into(),
                    }))
                    .await;
            });
            Ok(stream)
        })
    }
}

/// The image-generation seam's "nothing configured" state.
///
/// The chat seam's `BackendKind::Auto` always resolves to a real engine, but there is no
/// platform-independent default image engine to fall back to — a
/// diffusion sidecar is an opt-in install, not something to launch unasked. This is what
/// `image_backend.kind: none` (the default) builds, and it says so plainly rather than the
/// generic "no model loaded" a missing chat engine would produce.
pub struct NoneImageBackend;

impl ImageBackend for NoneImageBackend {
    fn name(&self) -> &'static str {
        "none"
    }

    fn availability(&self) -> BoxFuture<'_, Availability> {
        Box::pin(async {
            Availability::Unavailable {
                reason: "no image backend is configured".into(),
                remedy: "Set image_backend.kind to \"diffusion\" in Settings, and point python_path/diffusion_server_path at \
                         sidecars/diffusion/server.py."
                    .into(),
            }
        })
    }

    fn load(&self, _request: ImageLoadRequest) -> BoxFuture<'_, Result<LoadedImageModel>> {
        Box::pin(async {
            Err(Error::BackendUnavailable {
                backend: "none".into(),
                reason: "no image backend is configured".into(),
                remedy: "Set image_backend.kind to \"diffusion\" in Settings.".into(),
            })
        })
    }

    fn unload(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn loaded(&self) -> BoxFuture<'_, Option<LoadedImageModel>> {
        Box::pin(async { None })
    }

    fn generate(&self, _request: Txt2ImgRequest) -> BoxFuture<'_, Result<Vec<GeneratedImage>>> {
        Box::pin(async {
            Err(Error::BackendUnavailable {
                backend: "none".into(),
                reason: "no image backend is configured".into(),
                remedy: "Set image_backend.kind to \"diffusion\" in Settings.".into(),
            })
        })
    }
}

/// Built-in preview image backend so the Image Studio UI works out of the box without Python or weights.
#[derive(Default)]
pub struct MockImageBackend {
    loaded: Mutex<Option<LoadedImageModel>>,
}

impl ImageBackend for MockImageBackend {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn availability(&self) -> BoxFuture<'_, Availability> {
        Box::pin(async { Availability::Available { detail: "built in; generates deterministic preview PNGs".into() } })
    }

    fn load(&self, request: ImageLoadRequest) -> BoxFuture<'_, Result<LoadedImageModel>> {
        Box::pin(async move {
            let loaded = LoadedImageModel { model_id: request.model_id, load_ms: 1 };
            *self.loaded.lock().expect("mock image lock") = Some(loaded.clone());
            Ok(loaded)
        })
    }

    fn unload(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            *self.loaded.lock().expect("mock image lock") = None;
            Ok(())
        })
    }

    fn loaded(&self) -> BoxFuture<'_, Option<LoadedImageModel>> {
        Box::pin(async { self.loaded.lock().expect("mock image lock").clone() })
    }

    fn generate(&self, request: Txt2ImgRequest) -> BoxFuture<'_, Result<Vec<GeneratedImage>>> {
        Box::pin(async move {
            let width = request.width.clamp(64, 1536);
            let height = request.height.clamp(64, 1536);
            let count = request.n.clamp(1, 4);
            let base_seed = request.seed.unwrap_or_else(|| {
                request.prompt.bytes().fold(0x9e37_79b9_7f4a_7c15u64, |acc, b| acc.wrapping_mul(1099511628211).wrapping_add(b as u64))
            });
            let mut out = Vec::with_capacity(count as usize);
            for idx in 0..count {
                let png_bytes = render_mock_png(width, height, base_seed.wrapping_add(idx as u64 * 7919), request.reference_images.len());
                out.push(GeneratedImage { png_bytes });
            }
            Ok(out)
        })
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(tag);
    out.extend_from_slice(data);
    let checksum = crc32(&out[start..]);
    out.extend_from_slice(&checksum.to_be_bytes());
}

fn render_mock_png(width: u32, height: u32, seed: u64, refs: usize) -> Vec<u8> {
    // Render at compact preview resolution so uncompressed PNG stays fast and lightweight (~180 KB).
    let w = width.min(384);
    let h = height.min(384);
    let r0 = ((seed & 0xff) as u8).max(28);
    let g0 = (((seed >> 8) & 0xff) as u8).max(36);
    let b0 = (((seed >> 16) & 0xff) as u8).max(64);
    let r1 = (((seed >> 24) & 0xff) as u8).max(48);
    let g1 = (((seed >> 32) & 0xff) as u8).max(96);
    let b1 = (((seed >> 40) & 0xff) as u8).max(140);

    let row_bytes = 1 + (w as usize) * 3;
    let mut raw = Vec::with_capacity(row_bytes * h as usize);
    for y in 0..h {
        raw.push(0); // filter type 0 (None)
        let ty = y as f32 / (h.max(1) as f32);
        for x in 0..w {
            let tx = x as f32 / (w.max(1) as f32);
            let wave = (((x.wrapping_mul(7) ^ y.wrapping_mul(13)) & 31) as f32) / 255.0;
            let mix = (tx * 0.55 + ty * 0.45).clamp(0.0, 1.0);
            let mut r = (r0 as f32 * (1.0 - mix) + r1 as f32 * mix + wave * 24.0).clamp(0.0, 255.0) as u8;
            let mut g = (g0 as f32 * (1.0 - mix) + g1 as f32 * mix + wave * 18.0).clamp(0.0, 255.0) as u8;
            let mut b = (b0 as f32 * (1.0 - mix) + b1 as f32 * mix + wave * 28.0).clamp(0.0, 255.0) as u8;
            // Subtle framing grid + badge accent when reference images are attached.
            if x == 12 || x + 13 == w || y == 12 || y + 13 == h {
                r = r.saturating_add(45);
                g = g.saturating_add(45);
                b = b.saturating_add(55);
            } else if refs > 0 && x >= 20 && x < 20 + (refs.min(6) as u32) * 14 && y >= 20 && y < 30 && (x - 20) % 14 < 10 {
                r = 245;
                g = 200;
                b = 90;
            }
            raw.extend_from_slice(&[r, g, b]);
        }
    }

    // Wrap `raw` in valid zlib + stored deflate blocks (65535 bytes max per block).
    let mut zlib = Vec::with_capacity(raw.len() + (raw.len() / 65535 + 2) * 5 + 6);
    zlib.extend_from_slice(&[0x78, 0x01]);
    let chunks: Vec<&[u8]> = if raw.is_empty() { vec![&[]] } else { raw.chunks(65_535).collect() };
    for (i, block) in chunks.iter().enumerate() {
        let last = i + 1 == chunks.len();
        zlib.push(u8::from(last));
        let len = block.len() as u16;
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    let mut s1 = 1u32;
    let mut s2 = 0u32;
    for &byte in &raw {
        s1 = (s1 + byte as u32) % 65_521;
        s2 = (s2 + s1) % 65_521;
    }
    zlib.extend_from_slice(&((s2 << 16) | s1).to_be_bytes());

    let mut png = Vec::with_capacity(zlib.len() + 64);
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&w.to_be_bytes());
    ihdr[4..8].copy_from_slice(&h.to_be_bytes());
    ihdr[8] = 8; // 8-bit depth
    ihdr[9] = 2; // RGB truecolor
    png_chunk(&mut png, b"IHDR", &ihdr);
    png_chunk(&mut png, b"IDAT", &zlib);
    png_chunk(&mut png, b"IEND", &[]);
    png
}

/// Turn a task that sends into a channel into a stream.
///
/// A small helper rather than a dependency on `async-stream`: the whole need is "spawn a producer,
/// hand back the receiver as a stream", and a bounded channel gives the backpressure that keeps a
/// slow client from making the producer race ahead. The receiver also owns the producer's
/// lifetime: a disconnect must cancel a quiet HTTP read or retry, not wait for another token to
/// notice that `send` failed.
pub(crate) fn async_stream<F, Fut>(producer: F) -> BoxStream<'static, Result<StreamEvent>>
where
    F: FnOnce(tokio::sync::mpsc::Sender<Result<StreamEvent>>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    tokio::spawn(async move {
        let disconnect = tx.clone();
        tokio::select! {
            biased;
            _ = disconnect.closed() => {}
            _ = producer(tx) => {}
        }
    });
    Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::ChatMessage;
    use futures_util::StreamExt;
    use misaka_studio_core::provenance::SamplingCommitment;

    struct DropSignal(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for DropSignal {
        fn drop(&mut self) {
            let _ = self.0.take().unwrap().send(());
        }
    }

    #[tokio::test]
    async fn dropping_a_stream_cancels_a_producer_that_is_waiting_without_sending() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (dropped, ended) = tokio::sync::oneshot::channel();
        let stream = async_stream(move |_tx| async move {
            let _drop = DropSignal(Some(dropped));
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        drop(stream);
        tokio::time::timeout(Duration::from_secs(1), ended).await.expect("quiet producer is cancelled").unwrap();
    }

    #[tokio::test]
    async fn a_stream_dropped_before_its_task_runs_never_starts_producing() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let produced = calls.clone();
        let stream = async_stream(move |_tx| async move {
            produced.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        drop(stream);
        tokio::task::yield_now().await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_slow_consumer_keeps_backpressure_and_disconnecting_releases_a_full_queue() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let produced = calls.clone();
        let (filled, ready) = tokio::sync::oneshot::channel();
        let (dropped, ended) = tokio::sync::oneshot::channel();
        let stream = async_stream(move |tx| async move {
            let _drop = DropSignal(Some(dropped));
            let mut filled = Some(filled);
            for index in 0..1000 {
                if tx.send(Ok(StreamEvent::Delta(index.to_string()))).await.is_err() {
                    return;
                }
                produced.fetch_add(1, Ordering::SeqCst);
                if index == 31 {
                    filled.take().unwrap().send(()).unwrap();
                }
            }
        });
        ready.await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 32, "a consumer that never polls cannot buffer the whole response");
        drop(stream);
        tokio::time::timeout(Duration::from_secs(1), ended).await.expect("backpressured producer is cancelled").unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 32);
    }

    fn request(text: &str) -> GenerationRequest {
        GenerationRequest {
            prompt_tokens: None,
            disable_thinking: false,
            model: "mock".into(),
            messages: vec![ChatMessage::new("user", text)],
            prompt: None,
            params: SamplingCommitment::default(),
            stop: Vec::new(),
        }
    }

    async fn collect(backend: &MockBackend, req: GenerationRequest) -> (String, Usage) {
        let mut stream = backend.generate(req).await.expect("generates");
        let mut text = String::new();
        let mut usage = Usage::default();
        while let Some(event) = stream.next().await {
            match event.expect("no error") {
                StreamEvent::Delta(d) => text.push_str(&d),
                StreamEvent::Reasoning(_) => {}
                StreamEvent::Done { usage: u, .. } => usage = u,
            }
        }
        (text, usage)
    }

    /// `/think` in the question turns on a reasoning stream ahead of the reply; the reply itself
    /// is unchanged, and `disable_thinking` turns the reasoning back off.
    #[tokio::test]
    async fn think_asks_the_mock_to_reason_first() {
        let backend = MockBackend::new(Duration::ZERO);
        let events = |req: GenerationRequest| {
            let backend = &backend;
            async move { backend.generate(req).await.expect("generates").map(|e| e.expect("no error")).collect::<Vec<_>>().await }
        };
        let thinking = events(request("why? /think")).await;
        let reasoning: String =
            thinking.iter().filter_map(|e| if let StreamEvent::Reasoning(r) = e { Some(r.as_str()) } else { None }).collect();
        let answer: String =
            thinking.iter().filter_map(|e| if let StreamEvent::Delta(d) = e { Some(d.as_str()) } else { None }).collect();
        assert!(reasoning.contains("think first"), "{reasoning}");
        assert_eq!(answer, MockBackend::compose(&request("why? /think")));
        let first_delta = thinking.iter().position(|e| matches!(e, StreamEvent::Delta(_))).unwrap();
        assert!(thinking[..first_delta].iter().all(|e| matches!(e, StreamEvent::Reasoning(_))), "reasoning comes first");

        let mut off = request("why? /think");
        off.disable_thinking = true;
        assert!(!events(off).await.iter().any(|e| matches!(e, StreamEvent::Reasoning(_))));
        assert!(!events(request("why?")).await.iter().any(|e| matches!(e, StreamEvent::Reasoning(_))), "opt-in only");
        assert!(!events(request("why? /no_think")).await.iter().any(|e| matches!(e, StreamEvent::Reasoning(_))));
    }

    #[tokio::test]
    async fn the_deltas_reassemble_into_the_whole_answer() {
        let backend = MockBackend::new(Duration::ZERO);
        let (text, usage) = collect(&backend, request("hello there")).await;
        assert_eq!(text, MockBackend::compose(&request("hello there")));
        assert!(text.contains("hello there"), "the mock echoes the prompt");
        assert!(usage.completion_tokens > 0);
        assert_eq!(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
    }

    /// The property that makes this usable as a fixture: same input, same bytes. If it ever
    /// stops holding, every provenance test that hashes a mock run becomes flaky.
    #[tokio::test]
    async fn the_same_prompt_gives_the_same_bytes() {
        let backend = MockBackend::new(Duration::ZERO);
        let (a, _) = collect(&backend, request("determinism")).await;
        let (b, _) = collect(&backend, request("determinism")).await;
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn max_tokens_stops_it_and_says_why() {
        let backend = MockBackend::new(Duration::ZERO);
        let mut req = request("hello");
        req.params.max_tokens = 3;
        let mut stream = backend.generate(req).await.expect("generates");
        let mut deltas = 0;
        let mut reason = String::new();
        while let Some(event) = stream.next().await {
            match event.expect("no error") {
                StreamEvent::Delta(_) => deltas += 1,
                StreamEvent::Reasoning(_) => {}
                StreamEvent::Done { finish_reason, .. } => reason = finish_reason,
            }
        }
        assert_eq!(deltas, 3);
        assert_eq!(reason, "length");
    }

    #[tokio::test]
    async fn load_and_unload_are_visible() {
        let backend = MockBackend::new(Duration::ZERO);
        assert!(backend.loaded().await.is_none());
        backend
            .load(LoadRequest {
                model_id: "m".into(),
                model_path: "/tmp/m.gguf".into(),
                context_size: 4096,
                gpu_layers: None,
                threads: None,
                flash_attention: misaka_studio_core::settings::FlashAttention::Auto,
                use_mmap: true,
                use_mlock: false,
                needs_default_chat_template: false,
                extra_args: Vec::new(),
            })
            .await
            .expect("loads");
        assert_eq!(backend.loaded().await.expect("loaded").context_size, 4096);
        backend.unload().await.expect("unloads");
        assert!(backend.loaded().await.is_none());
    }
}
