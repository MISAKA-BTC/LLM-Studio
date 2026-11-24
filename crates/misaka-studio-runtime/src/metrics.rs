//! The performance monitor: hardware counters and generation throughput, in one stream.
//!
//! Two numbers decide whether a local model is usable — how fast it generates, and how close the
//! machine is to its memory limit — and they are only meaningful together. 12 tokens/sec at 40 %
//! of VRAM means try a bigger model; 12 tokens/sec at 99 % means the KV cache is spilling and
//! the fix is a shorter context. So one sampler produces both and one stream carries them.
//!
//! # Nobody watching, nobody sampling
//!
//! The sampler wakes only while something is subscribed. A desktop app that polls `nvidia-smi`
//! twice a second forever is a measurable battery cost for a window nobody is looking at.

use crate::{Error, Result};
use misaka_studio_core::hardware::{HardwareMonitor, HardwareSample, HardwareSnapshot};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify, broadcast};

/// How often the monitor samples while someone is watching.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(1000);
/// Merge HTTP bursts with the stream's sample. Shorter than the stream interval so each tick
/// refreshes hardware even when the previous vendor probe finished slightly after its deadline.
const SNAPSHOT_TTL: Duration = Duration::from_millis(500);

struct SampleSource {
    sample: Box<dyn FnMut() -> HardwareSample + Send>,
    latest: Option<(Instant, HardwareSample)>,
}

/// Throughput, as last measured.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct GenerationStats {
    /// Generations in flight.
    pub active: u64,
    /// Tokens per second of the most recent completed generation.
    pub last_tokens_per_second: f64,
    /// Time to first token of the most recent generation, in milliseconds.
    pub last_time_to_first_token_ms: u64,
    /// Completion tokens produced since the process started.
    pub total_tokens: u64,
    /// Completed generations since the process started.
    pub total_generations: u64,
}

/// One tick of the monitor.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeSample {
    pub hardware: HardwareSample,
    pub generation: GenerationStats,
}

/// Collects and publishes samples.
pub struct MetricsHub {
    source: Arc<Mutex<SampleSource>>,
    events: broadcast::Sender<RuntimeSample>,
    watching: Notify,

    // Counters, atomic because generation tasks touch them from anywhere.
    active: AtomicU64,
    total_tokens: AtomicU64,
    total_generations: AtomicU64,
    // f64 has no atomic; the bits do, which is the standard trick and avoids a lock on a value
    // written once per generation and read once per second.
    last_tps_bits: AtomicU64,
    last_ttft_ms: AtomicU64,
}

impl MetricsHub {
    pub fn new(snapshot: &HardwareSnapshot) -> Arc<Self> {
        let mut monitor = HardwareMonitor::new(snapshot);
        Self::with_source(move || monitor.sample())
    }

    fn with_source(sample: impl FnMut() -> HardwareSample + Send + 'static) -> Arc<Self> {
        let (events, _) = broadcast::channel(64);
        Arc::new(MetricsHub {
            source: Arc::new(Mutex::new(SampleSource { sample: Box::new(sample), latest: None })),
            events,
            watching: Notify::new(),
            active: AtomicU64::new(0),
            total_tokens: AtomicU64::new(0),
            total_generations: AtomicU64::new(0),
            last_tps_bits: AtomicU64::new(0),
            last_ttft_ms: AtomicU64::new(0),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeSample> {
        let receiver = self.events.subscribe();
        self.watching.notify_one();
        receiver
    }

    pub fn stats(&self) -> GenerationStats {
        GenerationStats {
            active: self.active.load(Ordering::Relaxed),
            last_tokens_per_second: f64::from_bits(self.last_tps_bits.load(Ordering::Relaxed)),
            last_time_to_first_token_ms: self.last_ttft_ms.load(Ordering::Relaxed),
            total_tokens: self.total_tokens.load(Ordering::Relaxed),
            total_generations: self.total_generations.load(Ordering::Relaxed),
        }
    }

    /// A recent hardware snapshot, with generation counters read at the time of this request.
    /// CPU/process probing and vendor subprocesses never execute on an async worker. The owned
    /// guard stays with a cancelled request's blocking job, so another caller cannot start an
    /// overlapping hardware probe while that job is still running.
    pub async fn sample(&self) -> Result<RuntimeSample> {
        let mut source = self.source.clone().lock_owned().await;
        let hardware = match source.latest.as_ref().filter(|(at, _)| at.elapsed() < SNAPSHOT_TTL) {
            Some((_, hardware)) => hardware.clone(),
            None => tokio::task::spawn_blocking(move || {
                let hardware = (source.sample)();
                source.latest = Some((Instant::now(), hardware.clone()));
                hardware
            })
            .await
            .map_err(|e| Error::io("hardware sample", std::io::Error::other(e)))?,
        };
        Ok(RuntimeSample { hardware, generation: self.stats() })
    }

    pub fn generation_started(&self) {
        self.active.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a finished generation. Called even when it failed part-way, so `active` cannot
    /// leak — a counter that only decrements on success reads "3 active" forever after three
    /// cancelled requests.
    pub fn generation_finished(&self, tokens: u64, tokens_per_second: f64, time_to_first_token_ms: u64) {
        // Saturate rather than subtract unconditionally: underflow would report 18 quintillion
        // active generations. A CAS loop keeps this compatible with the project's Rust MSRV.
        let mut active = self.active.load(Ordering::Relaxed);
        loop {
            match self.active.compare_exchange_weak(active, active.saturating_sub(1), Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => break,
                Err(current) => active = current,
            }
        }
        if tokens > 0 {
            self.total_tokens.fetch_add(tokens, Ordering::Relaxed);
            self.total_generations.fetch_add(1, Ordering::Relaxed);
            self.last_tps_bits.store(tokens_per_second.to_bits(), Ordering::Relaxed);
            self.last_ttft_ms.store(time_to_first_token_ms, Ordering::Relaxed);
        }
    }

    /// Run the sampling loop until the process ends.
    pub async fn run(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            // No periodic wakeups when nobody observes metrics. A new subscription wakes the
            // one sampler; HTTP snapshot requests use the same source without starting a poll.
            while self.events.receiver_count() == 0 {
                self.watching.notified().await;
            }
            ticker.tick().await;
            if self.events.receiver_count() == 0 {
                continue;
            }
            match self.sample().await {
                Ok(sample) => {
                    let _ = self.events.send(sample);
                }
                Err(error) => tracing::warn!("hardware sampling failed: {error}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_sample() -> HardwareSample {
        HardwareSample {
            cpu_percent: 12.0,
            process_cpu_percent: 3.0,
            memory_used: 1024,
            memory_total: 4096,
            process_memory: 128,
            accelerators: Vec::new(),
        }
    }

    #[tokio::test]
    async fn concurrent_snapshot_requests_share_one_hardware_probe_but_read_live_generation_stats() {
        let calls = Arc::new(AtomicU64::new(0));
        let probe_calls = calls.clone();
        let hub = MetricsHub::with_source(move || {
            probe_calls.fetch_add(1, Ordering::Relaxed);
            fixture_sample()
        });
        let mut requests = Vec::new();
        for _ in 0..100 {
            let hub = hub.clone();
            requests.push(tokio::spawn(async move { hub.sample().await.expect("snapshot") }));
        }
        for request in requests {
            assert_eq!(request.await.unwrap().hardware.memory_total, 4096);
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1, "one hardware read serves the HTTP burst");
        hub.generation_started();
        assert_eq!(hub.sample().await.unwrap().generation.active, 1, "counter updates do not wait for hardware TTL");
        hub.source.lock().await.latest.as_mut().unwrap().0 = Instant::now() - SNAPSHOT_TTL;
        hub.sample().await.expect("refresh expired hardware");
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn a_slow_hardware_probe_does_not_block_the_async_executor() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut started = Some(started_tx);
        let hub = MetricsHub::with_source(move || {
            if let Some(started) = started.take() {
                let _ = started.send(());
            }
            // A bounded wait also makes a regression fail instead of hanging the test runner.
            release_rx.recv_timeout(Duration::from_secs(2)).expect("async task runs while probing");
            fixture_sample()
        });
        let request = tokio::spawn(async move { hub.sample().await });
        started_rx.await.expect("probe starts");
        tokio::time::sleep(Duration::from_millis(1)).await;
        release_tx.send(()).expect("release probe");
        request.await.unwrap().expect("sample completes");
    }

    #[tokio::test]
    async fn a_cancelled_caller_does_not_start_a_second_probe_over_the_first() {
        let calls = Arc::new(AtomicU64::new(0));
        let probe_calls = calls.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut started = Some(started_tx);
        let hub = MetricsHub::with_source(move || {
            probe_calls.fetch_add(1, Ordering::Relaxed);
            if let Some(started) = started.take() {
                let _ = started.send(());
            }
            release_rx.recv_timeout(Duration::from_secs(2)).expect("released");
            fixture_sample()
        });
        let first_hub = hub.clone();
        let first = tokio::spawn(async move { first_hub.sample().await });
        started_rx.await.unwrap();
        first.abort();
        let second = tokio::spawn(async move { hub.sample().await });
        tokio::task::yield_now().await;
        release_tx.send(()).unwrap();
        second.await.unwrap().expect("reuse completed probe");
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn idle_sampler_waits_for_a_subscription() {
        let calls = Arc::new(AtomicU64::new(0));
        let probe_calls = calls.clone();
        let hub = MetricsHub::with_source(move || {
            probe_calls.fetch_add(1, Ordering::Relaxed);
            fixture_sample()
        });
        let sampler = tokio::spawn(hub.clone().run());
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let mut receiver = hub.subscribe();
        tokio::time::timeout(Duration::from_secs(2), receiver.recv()).await.unwrap().unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        drop(receiver);
        sampler.abort();
    }

    #[tokio::test]
    async fn counters_survive_more_finishes_than_starts() {
        let hub = MetricsHub::new(&HardwareSnapshot::probe());
        hub.generation_started();
        hub.generation_finished(10, 12.5, 100);
        // A double-finish (a cancelled request whose cleanup ran twice) must not underflow.
        hub.generation_finished(0, 0.0, 0);
        let stats = hub.stats();
        assert_eq!(stats.active, 0);
        assert_eq!(stats.total_tokens, 10);
        assert_eq!(stats.total_generations, 1, "a zero-token generation is not counted");
        assert_eq!(stats.last_tokens_per_second, 12.5);
    }

    #[tokio::test]
    async fn a_sample_carries_both_halves() {
        let hub = MetricsHub::new(&HardwareSnapshot::probe());
        hub.generation_started();
        let sample = hub.sample().await.expect("samples");
        assert!(sample.hardware.memory_total > 0);
        assert_eq!(sample.generation.active, 1);
    }

    #[tokio::test]
    async fn subscribers_receive_ticks() {
        let hub = MetricsHub::new(&HardwareSnapshot::probe());
        let mut rx = hub.subscribe();
        tokio::spawn(hub.clone().run());
        let sample = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("a tick arrives").expect("no lag");
        assert!(sample.hardware.memory_total > 0);
    }
}
