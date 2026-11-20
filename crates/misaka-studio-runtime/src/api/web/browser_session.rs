//! A visible Chrome session with a disposable profile and a private DevTools pipe.
//! Browser networking uses only the Studio's SOCKS relay. The relay never changes routes.
use super::{Source, WebResult, ensure_tor, permitted, public_ip, validate_url};
use crate::{Error, Result, state::AppState};
use axum::{Json, extract::State};
use misaka_studio_core::settings::{WebMode, WebSettings};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream, UnixStream},
    process::{Child, Command},
    sync::Mutex,
    task::{JoinHandle, JoinSet},
    time::{sleep, timeout},
};

#[derive(Default)]
pub(crate) struct Browser(Mutex<Option<Session>>);

impl Browser {
    pub(crate) async fn reset_route(&self, web: &WebSettings) {
        let mut slot = self.0.lock().await;
        if slot.as_ref().is_some_and(|s| s.route != web.mode || s.proxy != web.tor_proxy) {
            *slot = None;
        }
    }
}

#[derive(Deserialize)]
pub(super) struct Request {
    thread: String,
    #[serde(default = "super::mining_default")]
    mining: bool,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Operation {
    Open { url: String },
    Read,
    Preview { control: String },
    Click { control: String },
    Close,
}

pub(super) async fn action(State(state): State<Arc<AppState>>, Json(body): Json<Request>) -> Result<Json<Value>> {
    if body.thread.is_empty() || body.thread.len() > 80 {
        return Err(Error::bad_request("Invalid browser conversation."));
    }
    if matches!(body.operation, Operation::Close) {
        let mut session = state.web_browser.0.lock().await;
        if session.as_ref().is_some_and(|s| s.thread == body.thread) {
            *session = None;
        }
        return Ok(Json(json!({})));
    }
    let mut slot = state.web_browser.0.lock().await;
    let web = permitted(&state, body.mining).await?;
    ensure_tor(&web).await?;
    let mut session = slot.take().filter(|s| s.route == web.mode && s.proxy == web.tor_proxy);
    let result = timeout(Duration::from_secs(35), perform(&mut session, &body.thread, &web, body.operation)).await;
    match result {
        Ok(result) => {
            *slot = session;
            result.map(Json)
        }
        Err(_) => Err(Error::bad_request("The browser timed out and its session was closed.")),
    }
}

async fn perform(session: &mut Option<Session>, thread: &str, web: &WebSettings, operation: Operation) -> Result<Value> {
    if let Operation::Open { url } = &operation {
        let url = Url::parse(url).map_err(|_| Error::bad_request("Enter an absolute HTTP or HTTPS URL."))?;
        validate_url(&url, web.mode)?;
        if session.as_mut().is_none_or(|s| s.thread != thread || s.child.try_wait().ok().flatten().is_some()) {
            *session = None;
            *session = Some(Session::start(thread.to_owned(), web).await?);
        }
        let browser = session.as_mut().unwrap();
        browser.controls = None;
        let navigation = browser.page("Page.navigate", json!({ "url": url.as_str() })).await?;
        if let Some(error) = navigation["errorText"].as_str() {
            return Err(Error::bad_request(format!("The browser could not open this page ({error}).")));
        }
        // A cross-document navigation can return before Chromium commits its new frame.
        if let Some(loader) = navigation["loaderId"].as_str() {
            loop {
                let tree = browser.page("Page.getFrameTree", json!({})).await?;
                if tree["frameTree"]["frame"]["loaderId"] == loader {
                    break;
                }
                sleep(Duration::from_millis(200)).await;
            }
        }
        // Give a JavaScript application a chance to mount and load its initial data.
        sleep(Duration::from_millis(1300)).await;
        return browser.read().await;
    }
    let browser = session
        .as_mut()
        .filter(|s| s.thread == thread)
        .ok_or_else(|| Error::bad_request("No browser tab is open for this conversation. Use browser_open first."))?;
    match operation {
        Operation::Read => browser.read().await,
        Operation::Preview { control } => {
            let (page, item) = browser.control(&control)?;
            Ok(json!({ "url": page.url, "label": item.label, "destination": item.destination }))
        }
        Operation::Click { control } => browser.click(&control).await,
        Operation::Open { .. } | Operation::Close => unreachable!(),
    }
}

struct Session {
    thread: String,
    route: WebMode,
    proxy: String,
    child: Child,
    relay: JoinHandle<()>,
    _profile: tempfile::TempDir,
    pipe: BufReader<UnixStream>,
    serial: u64,
    page_session: String,
    controls: Option<Snapshot>,
}

#[derive(Deserialize)]
struct Snapshot {
    url: String,
    title: String,
    text: String,
    controls: Vec<Control>,
    #[serde(skip)]
    revision: String,
    #[serde(skip)]
    context: i64,
}

#[derive(Deserialize)]
struct Control {
    label: String,
    destination: Option<String>,
    handoff: bool,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        self.relay.abort();
    }
}

pub(super) fn executable() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file());
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .flat_map(|dir| ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map(|name| dir.join(name)))
        .find(|path| path.is_file())
}

impl Session {
    async fn start(thread: String, web: &WebSettings) -> Result<Self> {
        let chrome =
            executable().ok_or_else(|| Error::bad_request("Install Google Chrome or Chromium to use the managed browser."))?;
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(browser_io)?;
        let address = listener.local_addr().map_err(browser_io)?;
        let upstream = if web.mode == WebMode::Tor {
            Some(web.tor_proxy.parse::<SocketAddr>().map_err(|_| Error::bad_request("Invalid Tor SOCKS address."))?)
        } else {
            None
        };
        let profile = tempfile::Builder::new().prefix("misaka-browser-").tempdir().map_err(browser_io)?;
        let preferences = profile.path().join("Default");
        std::fs::create_dir(&preferences).map_err(browser_io)?;
        std::fs::write(
            preferences.join("Preferences"),
            r#"{"credentials_enable_service":false,"profile":{"password_manager_enabled":false},"autofill":{"profile_enabled":false,"credit_card_enabled":false}}"#,
        ).map_err(browser_io)?;
        let (pipe, child_pipe) = std::os::unix::net::UnixStream::pair().map_err(browser_io)?;
        pipe.set_nonblocking(true).map_err(browser_io)?;
        let pipe = UnixStream::from_std(pipe).map_err(browser_io)?;
        // Chromium reads fd 3 and writes fd 4. Duplicate away from those numbers first.
        let fd = unsafe { libc::fcntl(child_pipe.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 5) };
        if fd < 0 {
            return Err(browser_io(std::io::Error::last_os_error()));
        }
        let child_fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut command = Command::new(chrome);
        command
            .kill_on_drop(true)
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .arg(format!("--proxy-server=socks5://{address}"))
            .args([
                "--remote-debugging-pipe",
                "--no-first-run",
                "--no-default-browser-check",
                "--proxy-bypass-list=<-loopback>",
                "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--disable-quic",
                "--disable-background-networking",
                "--disable-sync",
                "--disable-extensions",
                "about:blank",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        unsafe {
            command.pre_exec(move || {
                for to in [3, 4] {
                    if libc::dup2(child_fd.as_raw_fd(), to) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let child = command.spawn().map_err(browser_io)?;
        drop(command);
        drop(child_pipe);
        let mut browser = Self {
            thread,
            route: web.mode,
            proxy: web.tor_proxy.clone(),
            child,
            _profile: profile,
            relay: tokio::spawn(serve_relay(listener, web.mode, upstream)),
            pipe: BufReader::new(pipe),
            serial: 0,
            page_session: String::new(),
            controls: None,
        };
        browser.call("Browser.setDownloadBehavior", json!({ "behavior": "deny" }), None).await?;
        let targets = browser.call("Target.getTargets", json!({}), None).await?;
        let target = targets["targetInfos"].as_array().and_then(|items| items.iter().find(|item| item["type"] == "page"));
        let target_id = match target {
            Some(target) => field(target, "targetId")?.to_owned(),
            None => {
                let created = browser.call("Target.createTarget", json!({ "url": "about:blank" }), None).await?;
                field(&created, "targetId")?.to_owned()
            }
        };
        let attached = browser.call("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None).await?;
        browser.page_session = field(&attached, "sessionId")?.into();
        Ok(browser)
    }

    async fn call(&mut self, method: &str, params: Value, session: Option<String>) -> Result<Value> {
        self.serial += 1;
        let mut message = json!({ "id": self.serial, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        let mut frame = message.to_string().into_bytes();
        frame.push(0);
        self.pipe.get_mut().write_all(&frame).await.map_err(browser_io)?;
        loop {
            let mut response = Vec::new();
            if self.pipe.read_until(0, &mut response).await.map_err(browser_io)? == 0 {
                return Err(Error::bad_request("The managed browser was closed. Open the page again."));
            }
            response.pop();
            let response: Value = serde_json::from_slice(&response).map_err(|_| Error::bad_request("Invalid browser response."))?;
            if response["id"].as_u64() != Some(self.serial) {
                continue;
            }
            if let Some(error) = response["error"]["message"].as_str() {
                return Err(Error::bad_request(format!("Browser command failed: {error}")));
            }
            return Ok(response["result"].clone());
        }
    }

    async fn page(&mut self, method: &str, params: Value) -> Result<Value> {
        self.call(method, params, Some(self.page_session.clone())).await
    }

    async fn evaluate(&mut self, context: i64, expression: String) -> Result<Value> {
        let response =
            self.page("Runtime.evaluate", json!({ "contextId": context, "expression": expression, "returnByValue": true })).await?;
        if response.get("exceptionDetails").is_some() {
            return Err(Error::bad_request("The page changed. Read its current browser state and try again."));
        }
        Ok(response["result"]["value"].clone())
    }

    async fn read(&mut self) -> Result<Value> {
        self.controls = None;
        let tree = self.page("Page.getFrameTree", json!({})).await?;
        let frame = &tree["frameTree"]["frame"];
        let url = Url::parse(field(frame, "url")?).map_err(|_| Error::bad_request("The browser is not on a public web page."))?;
        validate_url(&url, self.route)?;
        if frame.get("unreachableUrl").is_some() {
            return Err(Error::bad_request("The browser could not load the page."));
        }
        let world = self
            .page("Page.createIsolatedWorld", json!({ "frameId": field(frame, "id")?, "worldName": "MISAKA Studio observation" }))
            .await?;
        let context = world["executionContextId"].as_i64().ok_or_else(|| Error::bad_request("The page is still loading."))?;
        let value = self.evaluate(context, include_str!("snapshot.js").to_owned()).await?;
        let mut snapshot: Snapshot =
            serde_json::from_value(value).map_err(|_| Error::bad_request("The browser could not read this page."))?;
        let visible_url = Url::parse(&snapshot.url).map_err(|_| Error::bad_request("The page URL changed."))?;
        validate_url(&visible_url, self.route)?;
        snapshot.context = context;
        snapshot.revision = uuid::Uuid::new_v4().simple().to_string();
        let mut text =
            String::from("Visible controls (use the exact control ID; handoff means operate it in the browser yourself):\n");
        for (index, item) in snapshot.controls.iter().enumerate() {
            let suffix = if item.handoff { " [handoff]" } else { "" };
            text.push_str(&format!("{}:{index} {}{suffix}\n", snapshot.revision, item.label));
        }
        text.push_str("\nRendered page text:\n");
        text.push_str(&snapshot.text);
        let result = serde_json::to_value(WebResult {
            route: self.route,
            sources: vec![Source { url: snapshot.url.clone(), title: snapshot.title.clone(), text }],
        })
        .map_err(|_| Error::bad_request("Could not format browser evidence."))?;
        self.controls = Some(snapshot);
        Ok(result)
    }

    fn control(&self, id: &str) -> Result<(&Snapshot, &Control)> {
        let invalid = || Error::bad_request("That control is stale or invalid. Read the current page and use a fresh control ID.");
        let (revision, index) = id.split_once(':').ok_or_else(invalid)?;
        let snapshot = self.controls.as_ref().filter(|s| s.revision == revision).ok_or_else(invalid)?;
        let control = index.parse::<usize>().ok().and_then(|i| snapshot.controls.get(i)).ok_or_else(invalid)?;
        if control.handoff {
            return Err(Error::bad_request("Use the visible browser to complete this form or protected action."));
        }
        Ok((snapshot, control))
    }

    async fn click(&mut self, id: &str) -> Result<Value> {
        let (snapshot, control) = self.control(id)?;
        let index: usize = id.rsplit_once(':').unwrap().1.parse().unwrap();
        let args = json!([index, snapshot.url, control.label, control.destination]);
        let context = snapshot.context;
        self.controls = None;
        let clicked = self.evaluate(context, format!("globalThis.misakaClick(...{args})")).await?;
        if clicked != Value::Bool(true) {
            return Err(Error::bad_request("The control or page changed before the click. Read the page again."));
        }
        sleep(Duration::from_millis(850)).await;
        self.read().await
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| Error::bad_request("The browser did not return an active page."))
}

fn browser_io(error: std::io::Error) -> Error {
    Error::bad_request(format!("Managed browser connection failed: {error}"))
}

// SOCKS5 CONNECT only. Direct connections pin a public DNS answer. In Tor mode the domain
// is passed to Tor verbatim after validation, and this process never resolves it locally.
async fn serve_relay(listener: TcpListener, mode: WebMode, upstream: Option<SocketAddr>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            Ok((socket, _)) = listener.accept(), if connections.len() < 64 => {
                connections.spawn(async move { let _ = relay(socket, mode, upstream).await; });
            }
        }
    }
}

async fn relay(mut browser: TcpStream, mode: WebMode, upstream: Option<SocketAddr>) -> std::io::Result<()> {
    let mut peer = timeout(Duration::from_secs(18), connect(&mut browser, mode, upstream)).await??;
    tokio::io::copy_bidirectional(&mut browser, &mut peer).await?;
    Ok(())
}

async fn connect(browser: &mut TcpStream, mode: WebMode, upstream: Option<SocketAddr>) -> std::io::Result<TcpStream> {
    let denied = || std::io::Error::other("SOCKS destination refused");
    let mut greeting = [0; 2];
    browser.read_exact(&mut greeting).await?;
    let mut methods = vec![0; greeting[1].into()];
    browser.read_exact(&mut methods).await?;
    if greeting[0] != 5 || !methods.contains(&0) {
        return Err(denied());
    }
    browser.write_all(&[5, 0]).await?;
    let mut header = [0; 4];
    browser.read_exact(&mut header).await?;
    if header[..3] != [5, 1, 0] {
        return Err(denied());
    }
    let mut request = header.to_vec();
    let length = match header[3] {
        1 => 4,
        4 => 16,
        3 => {
            let length = browser.read_u8().await?;
            request.push(length);
            usize::from(length)
        }
        _ => return Err(denied()),
    };
    let mut address = vec![0; length];
    browser.read_exact(&mut address).await?;
    let host = match header[3] {
        1 => IpAddr::from(<[u8; 4]>::try_from(address.as_slice()).unwrap()).to_string(),
        4 => format!("[{}]", IpAddr::from(<[u8; 16]>::try_from(address.as_slice()).unwrap())),
        _ => std::str::from_utf8(&address).map_err(|_| denied())?.to_owned(),
    };
    if host.is_empty() || host.chars().any(|c| !(c.is_ascii_alphanumeric() || ".-:[]".contains(c))) {
        return Err(denied());
    }
    let port = browser.read_u16().await?;
    let url = Url::parse(&format!("http://{host}:{port}/")).map_err(|_| denied())?;
    validate_url(&url, mode).map_err(|_| denied())?;
    if mode == WebMode::Tor {
        let mut peer = TcpStream::connect(upstream.ok_or_else(denied)?).await?;
        peer.write_all(&[5, 1, 0]).await?;
        let mut response = [0; 2];
        peer.read_exact(&mut response).await?;
        if response != [5, 0] {
            return Err(denied());
        }
        request.extend(address);
        request.extend(port.to_be_bytes());
        peer.write_all(&request).await?;
        // The Tor server's CONNECT response is forwarded unchanged.
        return Ok(peer);
    }
    let host = url.host_str().ok_or_else(denied)?.trim_matches(['[', ']']);
    let addresses: Vec<_> = tokio::net::lookup_host((host, port)).await?.collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        return Err(denied());
    }
    let peer = TcpStream::connect(addresses.as_slice()).await?;
    browser.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    Ok(peer)
}
