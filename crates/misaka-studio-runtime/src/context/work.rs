//! CPU work for a request lives outside the HTTP executor and has a bounded lifetime/queue.
//!
//! Dropping the awaiting request cancels a task that has not started. A tokenizer call already
//! running cannot be interrupted safely; its permit stays with that call until it returns, so
//! repeated cancelled requests cannot create an unbounded number of CPU workers.

use crate::{Error, Result};
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

static WORKERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

pub(crate) async fn run<T: Send + 'static>(task: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    run_limited(WORKERS.clone(), task).await
}

async fn run_limited<T: Send + 'static>(workers: Arc<Semaphore>, task: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    let permit = workers.acquire_owned().await.map_err(|_| Error::Cancelled)?;
    let handle = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        task()
    });
    let _abort_on_drop = AbortOnDrop(handle.abort_handle());
    handle.await.map_err(|error| {
        if error.is_cancelled() { Error::Cancelled } else { Error::engine("context", format!("context preparation failed: {error}")) }
    })
}

struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn context_work_does_not_block_the_single_thread_http_executor() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = tokio::spawn(run_limited(Arc::new(Semaphore::new(1)), move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            42
        }));
        ready.await.unwrap();
        // This future runs on the only async worker while the CPU task is still occupied.
        tokio::task::yield_now().await;
        assert!(!worker.is_finished());
        release.send(()).unwrap();
        assert_eq!(worker.await.unwrap().unwrap(), 42);
    }

    #[tokio::test]
    async fn cancelling_a_queued_request_never_runs_its_context_work() {
        let workers = Arc::new(Semaphore::new(1));
        let permit = workers.clone().acquire_owned().await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let queued_calls = calls.clone();
        let queued = tokio::spawn(run_limited(workers.clone(), move || {
            queued_calls.fetch_add(1, Ordering::SeqCst);
        }));
        tokio::task::yield_now().await;
        queued.abort();
        assert!(queued.await.unwrap_err().is_cancelled());
        drop(permit);
        run_limited(workers, || ()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_abandoned_running_job_keeps_its_slot_until_the_cpu_work_finishes() {
        let workers = Arc::new(Semaphore::new(1));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let first = tokio::spawn(run_limited(workers.clone(), move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        }));
        ready.await.unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        assert_eq!(workers.available_permits(), 0);
        let calls = Arc::new(AtomicUsize::new(0));
        let next_calls = calls.clone();
        let next = tokio::spawn(run_limited(workers, move || {
            next_calls.fetch_add(1, Ordering::SeqCst);
        }));
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        release.send(()).unwrap();
        next.await.unwrap().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_a_request_also_aborts_a_job_still_queued_in_tokios_blocking_pool() {
        let runtime = tokio::runtime::Builder::new_current_thread().max_blocking_threads(1).enable_all().build().unwrap();
        runtime.block_on(async {
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let occupied = tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
            });
            ready.await.unwrap();
            let workers = Arc::new(Semaphore::new(1));
            let calls = Arc::new(AtomicUsize::new(0));
            let queued_calls = calls.clone();
            let queued = tokio::spawn(run_limited(workers.clone(), move || {
                queued_calls.fetch_add(1, Ordering::SeqCst);
            }));
            tokio::task::yield_now().await;
            assert_eq!(workers.available_permits(), 0, "the job was submitted to the occupied blocking pool");
            queued.abort();
            assert!(queued.await.unwrap_err().is_cancelled());
            release.send(()).unwrap();
            occupied.await.unwrap();
            run_limited(workers, || ()).await.unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        });
    }
}
