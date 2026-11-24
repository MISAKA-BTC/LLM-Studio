//! Stop must propagate through the HTTP response, state wrapper and backend while no token is
//! arriving. A silent stand-in engine exposes cancellation by dropping its response body; no
//! GPU, model download, timing benchmark or generated-output change is involved.

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use futures_util::{Stream, StreamExt};
use misaka_studio_core::settings::{BackendKind, BackendSettings, Settings};
use misaka_studio_runtime::AppState;
use misaka_studio_runtime::backend::{ChatMessage, StreamEvent};
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

const WAIT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Default)]
struct Counts {
    requests: usize,
    events: usize,
    dropped: usize,
}
type Probe = Arc<watch::Sender<Counts>>;

struct QuietBody {
    first: Option<Bytes>,
    probe: Probe,
}
impl Stream for QuietBody {
    type Item = std::result::Result<Bytes, Infallible>;
    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(bytes) = self.first.take() {
            self.probe.send_modify(|counts| counts.events += 1);
            Poll::Ready(Some(Ok(bytes)))
        } else {
            Poll::Pending
        }
    }
}
impl Drop for QuietBody {
    fn drop(&mut self) {
        self.probe.send_modify(|counts| counts.dropped += 1);
    }
}

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Fixture {
    state: Arc<AppState>,
    address: std::net::SocketAddr,
    probe: Probe,
    _servers: Vec<Server>,
    _data: tempfile::TempDir,
}

async fn fixture(first: bool) -> Fixture {
    let (events, _) = watch::channel(Counts::default());
    let probe = Arc::new(events);
    let engine = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", engine.local_addr().unwrap());
    let app = axum::Router::new()
        .route("/health", get(|| async { axum::Json(serde_json::json!({ "n_ctx": 4096, "can_submit": true })) }))
        .route(
            "/v1/chat/completions",
            post(move |State(probe): State<Probe>| async move {
                probe.send_modify(|counts| counts.requests += 1);
                let first =
                    first.then(|| Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"First output.\"}}]}\n\n"));
                ([("content-type", "text/event-stream")], Body::from_stream(QuietBody { first, probe })).into_response()
            }),
        )
        .with_state(probe.clone());
    let engine_task = Server(tokio::spawn(async move { axum::serve(engine, app).await.unwrap() }));

    let data = tempfile::tempdir().unwrap();
    let models = data.path().join("models");
    std::fs::create_dir_all(&models).unwrap();
    std::fs::write(models.join("qwen25-1.5b-a16.palwart"), b"PALW\0\0\0\x01").unwrap();
    let mut settings = Settings {
        models_dir: models,
        backend: BackendSettings { kind: BackendKind::Gateway, ..Default::default() },
        ..Default::default()
    };
    settings.node.palw_gateway_url = Some(url);
    settings.context.fetch_class_tokenizer = false;
    let state = AppState::new(settings, data.path().join("settings.json"), data.path().to_path_buf()).await;
    state.load("qwen25-1.5b-a16", None).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = misaka_studio_runtime::api::router(state.clone(), None, Vec::new());
    let studio_task = Server(tokio::spawn(async move { axum::serve(listener, router).await.unwrap() }));
    Fixture { state, address, probe, _servers: vec![engine_task, studio_task], _data: data }
}

async fn wait_for(probe: &Probe, predicate: impl Fn(Counts) -> bool, message: &str) {
    let mut events = probe.subscribe();
    tokio::time::timeout(WAIT, async {
        loop {
            if predicate(*events.borrow()) {
                break;
            }
            events.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{message}; observed {:?}", *events.borrow()));
}

fn request() -> serde_json::Value {
    serde_json::json!({ "messages": [{ "role": "user", "content": "Please answer." }], "stream": true, "max_tokens": 64 })
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_generation_before_the_first_token_cancels_upstream_and_releases_metrics() {
    let fixture = fixture(false).await;
    let state = fixture.state.clone();
    let generation = tokio::spawn(async move {
        state.generate(vec![ChatMessage::new("user", "Please answer.")], None, Default::default(), Vec::new()).await
    });
    wait_for(&fixture.probe, |counts| counts.requests == 1, "engine received the request").await;
    assert_eq!(fixture.state.metrics.stats().active, 1);
    generation.abort();
    assert!(matches!(generation.await, Err(error) if error.is_cancelled()));
    wait_for(&fixture.probe, |counts| counts.dropped == 1, "silent upstream response must be dropped").await;
    assert_eq!(fixture.probe.borrow().events, 0, "cancellation does not wait for an output event");
    assert_eq!(fixture.state.metrics.stats().active, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_returned_stream_cancels_an_engine_silent_between_tokens() {
    let fixture = fixture(true).await;
    let mut stream =
        fixture.state.generate(vec![ChatMessage::new("user", "Please answer.")], None, Default::default(), Vec::new()).await.unwrap();
    assert_eq!(stream.next().await.unwrap().unwrap(), StreamEvent::Delta("First output.".into()));
    drop(stream);
    wait_for(&fixture.probe, |counts| counts.dropped == 1, "state wrapper must release the silent backend stream").await;
    assert_eq!(fixture.probe.borrow().events, 1);
    assert_eq!(fixture.probe.borrow().requests, 1, "a cancellation must not retry generation");
    assert_eq!(fixture.state.metrics.stats().active, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_disconnect_before_response_headers_cancels_first_token_wait() {
    let fixture = fixture(false).await;
    let mut socket = tokio::net::TcpStream::connect(fixture.address).await.unwrap();
    let body = request().to_string();
    let http = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        fixture.address,
        body.len(),
        body
    );
    socket.write_all(http.as_bytes()).await.unwrap();
    wait_for(&fixture.probe, |counts| counts.requests == 1, "request reached the silent engine").await;
    drop(socket);
    wait_for(&fixture.probe, |counts| counts.dropped == 1, "HTTP disconnect must cancel pre-response work").await;
    assert_eq!(fixture.probe.borrow().events, 0);
    assert_eq!(fixture.probe.borrow().requests, 1);
    assert_eq!(fixture.state.metrics.stats().active, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_disconnect_after_one_event_reaches_the_quiet_engine() {
    let fixture = fixture(true).await;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = http.post(format!("http://{}/v1/chat/completions", fixture.address)).json(&request()).send().await.unwrap();
    assert!(response.status().is_success());
    let mut body = response.bytes_stream();
    let mut received = String::new();
    tokio::time::timeout(WAIT, async {
        while !received.contains("First output.") {
            received.push_str(&String::from_utf8_lossy(&body.next().await.unwrap().unwrap()));
        }
    })
    .await
    .unwrap();
    drop(body);
    wait_for(&fixture.probe, |counts| counts.dropped == 1, "SSE disconnect must reach the engine despite its silence").await;
    assert_eq!(fixture.probe.borrow().events, 1);
    assert_eq!(fixture.state.metrics.stats().active, 0);
}
