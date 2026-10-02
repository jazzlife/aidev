//! The runner's only connection: an outbound WebSocket to `<gateway>/_runner/ws` (no inbound port on
//! this PC). JSON-RPC 2.0 text frames; binary frames `[streamId u32 BE][payload]` for streams (F-03+)
//! and, in both directions, for preview tunnels (F-06).
//! Heartbeat every 15 s; a silent link (45 s) or any error reconnects with jittered backoff (1 s → 60 s).
//! A 401/403 at the handshake means the token was revoked: the runner stops and asks for pairing.

use crate::{caps, config::Config, exec::ExecHub};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Error as WsError, Message};

const HEARTBEAT: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(45);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

pub enum Exit {
    /// Token rejected: pairing needed again.
    Unauthorized,
    /// Ctrl+C / service stop.
    Shutdown,
    /// Boot-time runner: a sign-in's runner asked to take over (config::handoff_path).
    Handoff,
    /// 정지 from the status icon (control::paused_path): disconnected until 시작.
    Paused,
}

fn ws_url(gateway: &str) -> String {
    if let Some(rest) = gateway.strip_prefix("https://") {
        format!("wss://{rest}/_runner/ws")
    } else if let Some(rest) = gateway.strip_prefix("http://") {
        format!("ws://{rest}/_runner/ws")
    } else {
        format!("{gateway}/_runner/ws")
    }
}

fn log(msg: &str) {
    eprintln!("[aidev-runner {}] {msg}", chrono_now());
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{:02}:{:02}:{:02}Z", (secs / 3600) % 24, (secs / 60) % 60, secs % 60)
}

/// Runs until shutdown or revocation, reconnecting as needed; `yields` (a boot-time runner) also ends when a
/// sign-in's runner asks for the connection.
pub async fn run(cfg: Config, yields: bool) -> Exit {
    let hub = ExecHub::default();
    // probe the interactive PATH once, off the connection path
    tokio::task::spawn_blocking(|| {
        let path = crate::exec::user_path();
        log(&format!("명령 PATH: {}", path.as_deref().map(|p| format!("사용자 셸에서 가져옴 ({}개 경로)", p.split(':').count())).unwrap_or_else(|| "기본값".into())));
    });
    let exit = tokio::select! {
        exit = run_with(&cfg, &hub) => exit,
        _ = handoff_asked(), if yields => Exit::Handoff,
        exit = stop_asked() => exit,
    };
    crate::control::set_state(crate::control::State::Connecting);
    // nothing keeps running unattended once the runner itself stops
    if hub.running() > 0 {
        hub.kill_all();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    exit
}

async fn run_with(cfg: &Config, hub: &ExecHub) -> Exit {
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        let outcome = tokio::select! {
            outcome = session(cfg, hub) => Some(outcome),
            _ = shutdown_signal() => None,
        };
        hub.detach();
        crate::control::set_state(crate::control::State::Connecting);
        match outcome {
            None => return Exit::Shutdown,
            Some(outcome) => match outcome {
                Ok(()) => log("연결이 끊어졌습니다"),
                Err(SessionError::Unauthorized) => return Exit::Unauthorized,
                Err(SessionError::Other(e)) => log(&format!("연결 오류: {e}")),
                Err(SessionError::Replaced) => {
                    log("같은 토큰을 쓰는 다른 러너가 접속해 이 연결을 대체했습니다 — 이 PC나 다른 PC에서 러너가 두 개 실행 중인지 확인하세요 (서비스 + 터미널 start 등). 30초 뒤 다시 시도합니다");
                    backoff = backoff.max(Duration::from_secs(30));
                }
            },
        }
        // a connection that lasted a while starts the backoff over
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        let jitter = rand::thread_rng().gen_range(0..=backoff.as_millis() as u64 / 2);
        let wait = backoff + Duration::from_millis(jitter);
        log(&format!("{:.1}초 뒤 다시 연결합니다", wait.as_secs_f32()));
        tokio::select! {
            _ = tokio::time::sleep(wait) => {},
            _ = shutdown_signal() => return Exit::Shutdown,
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// 정지 or 종료 from the status icon (or another runner's icon on this PC: the paused file is shared).
async fn stop_asked() -> Exit {
    loop {
        if crate::control::quit_requested() {
            return Exit::Shutdown;
        }
        if crate::control::is_paused() {
            return Exit::Paused;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn handoff_asked() {
    while !crate::config::handoff_path().exists() {
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

enum SessionError {
    Unauthorized,
    /// Another runner holding the same token took over (gateway close 4000).
    Replaced,
    Other(String),
}

async fn session(cfg: &Config, hub: &ExecHub) -> Result<(), SessionError> {
    let url = ws_url(&cfg.gateway);
    let mut request = url.as_str().into_client_request().map_err(|e| SessionError::Other(e.to_string()))?;
    let auth = HeaderValue::from_str(&format!("Bearer {}", cfg.token)).map_err(|e| SessionError::Other(e.to_string()))?;
    request.headers_mut().insert("authorization", auth);
    request.headers_mut().insert("x-aidev-runner", HeaderValue::from_static(env!("CARGO_PKG_VERSION")));
    let (ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(ok) => ok,
        Err(WsError::Http(resp)) if resp.status() == 401 || resp.status() == 403 => return Err(SessionError::Unauthorized),
        Err(e) => return Err(SessionError::Other(e.to_string())),
    };
    log(&format!("연결됨: {url} (대상 #{} {})", cfg.target_id, cfg.name));
    crate::control::set_state(crate::control::State::Connected);
    let (mut tx, mut rx) = ws.split();

    let hello = json!({ "jsonrpc": "2.0", "method": "runner.hello", "params": { "target_id": cfg.target_id, "capabilities": caps::collect(cfg).await } });
    tx.send(Message::Text(hello.to_string())).await.map_err(|e| SessionError::Other(e.to_string()))?;

    // Every outgoing frame (replies, stream output, notifications, pings) goes through one queue so
    // processes can write from their own tasks; the bounded queue pushes back on chatty commands.
    let (out, mut queue) = mpsc::channel::<Message>(256);
    let writer = tokio::spawn(async move {
        while let Some(msg) = queue.recv().await {
            if tx.send(msg).await.is_err() {
                break;
            }
        }
        let _ = tx.close().await;
    });
    hub.attach(out.clone());
    crate::tunnel::attach(out.clone());
    crate::screen::attach(out.clone());
    crate::input::attach(out.clone());
    crate::dap::attach(out.clone());
    // also when this future is dropped mid-way (정지, a hand-over): otherwise the writer task and the modules' copies
    // of `out` keep the socket open and the target stays online
    let _guard = SessionGuard { hub: hub.clone(), writer };
    let result = read_loop(cfg, hub, &out, &mut rx).await;
    drop(out);
    result
}

/// Detaches the modules from a session and stops its writer (closing the socket) however the session ends.
struct SessionGuard {
    hub: ExecHub,
    writer: tokio::task::JoinHandle<()>,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.hub.detach();
        crate::tunnel::detach();
        crate::screen::detach();
        crate::input::detach();
        crate::dap::detach();
        self.writer.abort();
    }
}

async fn read_loop<S>(cfg: &Config, hub: &ExecHub, out: &mpsc::Sender<Message>, rx: &mut S) -> Result<(), SessionError>
where
    S: futures_util::Stream<Item = Result<Message, WsError>> + Unpin,
{
    let send = |m: Message| async move { out.send(m).await.map_err(|_| SessionError::Other("송신 채널 닫힘".into())) };
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > SILENCE_LIMIT {
                    return Err(SessionError::Other("게이트웨이 응답 없음(45초)".into()));
                }
                send(Message::Ping(Vec::new())).await?;
            }
            frame = rx.next() => {
                let Some(frame) = frame else { return Ok(()) };
                let frame = frame.map_err(|e| SessionError::Other(e.to_string()))?;
                last_seen = Instant::now();
                match frame {
                    Message::Text(text) => {
                        if let Some(reply) = handle(cfg, hub, &text).await {
                            send(Message::Text(reply.to_string())).await?;
                        }
                    }
                    // tunnel bytes from the platform (F-06): [streamId u32 BE][bytes]
                    Message::Binary(b) if b.len() >= 4 => crate::tunnel::write(u32::from_be_bytes([b[0], b[1], b[2], b[3]]), &b[4..]),
                    Message::Ping(payload) => send(Message::Pong(payload)).await?,
                    Message::Close(frame) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code));
                        // 4401 = token revoked / target deleted by the user
                        if code == Some(4401) { return Err(SessionError::Unauthorized); }
                        // 4000 = another runner connected with this token and took the target over
                        if code == Some(4000) { return Err(SessionError::Replaced); }
                        log(&format!("게이트웨이가 연결을 닫았습니다 (code {}{})", code.map(|c| c.to_string()).unwrap_or_else(|| "-".into()), frame.as_ref().map(|f| format!(", {}", f.reason)).unwrap_or_default()));
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
    }
}

/// JSON-RPC requests from the gateway: liveness, capabilities, fs.resolve, fs.pull and the modules' methods.
pub async fn handle(cfg: &Config, hub: &ExecHub, text: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })),
    };
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str)?;
    // notifications (no id) are not answered; remote-control input arrives as notifications
    if id.is_none() {
        crate::input::notify(cfg, method, msg.get("params").unwrap_or(&Value::Null));
        return None;
    }
    let id = id?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let routed = match hub.rpc(cfg, method, &params).await {
        Some(r) => Some(r),
        None => match crate::tunnel::rpc(method, &params).await {
            Some(r) => Some(r),
            None => match crate::screen::rpc(cfg, method, &params).await {
                Some(r) => Some(r),
                None => match crate::sync::rpc(cfg, method, &params).await {
                    Some(r) => Some(r),
                    None => match crate::devserver::rpc(cfg, method, &params).await {
                        Some(r) => Some(r),
                        None => match crate::dap::rpc(cfg, method, &params).await {
                            Some(r) => Some(r),
                            None => crate::devices::rpc(cfg, method, &params).await,
                        },
                    },
                },
            },
        },
    };
    if let Some(result) = routed {
        return Some(match result {
            Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        });
    }
    let result = match method {
        "runner.ping" => Ok(json!({ "pong": true, "time": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) })),
        "runner.capabilities" => Ok(caps::collect(cfg).await),
        "fs.resolve" => {
            // lets the gateway check a path against allowed_roots (used by later file/sync methods)
            let path = msg.pointer("/params/path").and_then(Value::as_str).unwrap_or("");
            crate::roots::resolve(&cfg.allowed_roots, path).map(|p| json!({ "path": p.display().to_string() })).map_err(|e| (-32001, e))
        }
        "fs.pull" => {
            let (cfg, params) = (cfg.clone(), params.clone());
            tokio::task::spawn_blocking(move || crate::sync::pull(&cfg, &params)).await.unwrap_or_else(|e| Err((-32603, e.to_string())))
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(ws_url("https://dev.nado.work"), "wss://dev.nado.work/_runner/ws");
        assert_eq!(ws_url("http://127.0.0.1:18080"), "ws://127.0.0.1:18080/_runner/ws");
    }

    #[tokio::test]
    async fn rpc() {
        let cfg = Config { allowed_roots: vec![std::env::temp_dir()], ..Default::default() };
        let hub = ExecHub::default();
        let r = handle(&cfg, &hub, r#"{"jsonrpc":"2.0","id":1,"method":"runner.ping"}"#).await.unwrap();
        assert_eq!(r["result"]["pong"], true);
        let r = handle(&cfg, &hub, r#"{"jsonrpc":"2.0","id":2,"method":"nope"}"#).await.unwrap();
        assert_eq!(r["error"]["code"], -32601);
        let r = handle(&cfg, &hub, r#"{"jsonrpc":"2.0","id":3,"method":"fs.resolve","params":{"path":"/etc/passwd"}}"#).await.unwrap();
        assert_eq!(r["error"]["code"], -32001);
        assert!(handle(&cfg, &hub, r#"{"jsonrpc":"2.0","method":"runner.ping"}"#).await.is_none());
        assert_eq!(handle(&cfg, &hub, "{bad").await.unwrap()["error"]["code"], -32700);
    }
}
