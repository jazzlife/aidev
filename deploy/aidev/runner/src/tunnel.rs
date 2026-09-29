//! `tunnel.*` (IMPLEMENTATION-PLAN §3.12, F-06): a TCP pipe from the platform to a server listening on
//! this PC's loopback interface — the dev-server preview (`/p/<cap>/…` on the gateway) and its HMR socket.
//!   tunnel.open {streamId, port} → {streamId, addr}     tunnel.close {streamId} → {ok}
//!   notification tunnel.closed {streamId, error?} when the local side ends
//! Bytes travel as binary frames `[streamId u32 BE][bytes]` in both directions (the gateway allocates
//! the id, the same id space as exec streams). Only 127.0.0.1 / ::1 are ever dialled — the runner is
//! not a proxy into the user's network — and only ports ≥ 1024. Tunnels close with the connection.

use crate::exec::{frame, Out};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

type RpcResult = Result<Value, (i64, String)>;
const MAX_TUNNELS: usize = 64;
const READ_CHUNK: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

struct Tunnel {
    to_local: mpsc::UnboundedSender<Vec<u8>>,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
}

#[derive(Default)]
struct Inner {
    out: Option<Out>,
    tunnels: HashMap<u32, Tunnel>,
}

fn hub() -> &'static Mutex<Inner> {
    static HUB: OnceLock<Mutex<Inner>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(Inner::default()))
}

/// A live connection: tunnel bytes go to `out` from now on.
pub fn attach(out: Out) {
    hub().lock().unwrap().out = Some(out);
}

/// Connection lost: every tunnel ends (the gateway side is gone with it).
pub fn detach() {
    let mut g = hub().lock().unwrap();
    g.out = None;
    for (_, t) in g.tunnels.drain() {
        t.reader.abort();
        t.writer.abort();
    }
}

pub fn count() -> usize {
    hub().lock().unwrap().tunnels.len()
}

/// A binary frame from the gateway: bytes for the local server of that tunnel (unknown ids are dropped).
pub fn write(id: u32, bytes: &[u8]) {
    if let Some(t) = hub().lock().unwrap().tunnels.get(&id) {
        let _ = t.to_local.send(bytes.to_vec());
    }
}

fn close(id: u32) -> bool {
    match hub().lock().unwrap().tunnels.remove(&id) {
        Some(t) => {
            t.reader.abort();
            t.writer.abort();
            true
        }
        None => false,
    }
}

async fn notify_closed(id: u32, error: Option<String>) {
    let out = {
        let mut g = hub().lock().unwrap();
        if g.tunnels.remove(&id).is_none() {
            return; // closed by the gateway already
        }
        g.out.clone()
    };
    if let Some(out) = out {
        let note = json!({ "jsonrpc": "2.0", "method": "tunnel.closed", "params": { "streamId": id, "error": error } });
        let _ = out.send(Message::Text(note.to_string())).await;
    }
}

/// localhost servers bind to 127.0.0.1, ::1 or both (Vite on macOS often only to ::1): try both.
async fn dial(port: u16) -> Result<(TcpStream, String), String> {
    let mut last = String::new();
    for host in ["127.0.0.1", "::1"] {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port))).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok((stream, format!("{host}:{port}")));
            }
            Ok(Err(e)) => last = e.to_string(),
            Err(_) => last = "시간 초과".into(),
        }
    }
    Err(format!("이 PC의 포트 {port}에서 실행 중인 서버가 없습니다 ({last})"))
}

async fn open(params: &Value) -> RpcResult {
    let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "streamId 필요".to_string()))?;
    let port = params.get("port").and_then(Value::as_u64).ok_or((-32602, "port 필요".to_string()))?;
    if !(1024..=65535).contains(&port) {
        return Err((-32602, format!("포트 {port}는 허용되지 않습니다 (1024~65535)")));
    }
    {
        let g = hub().lock().unwrap();
        if g.tunnels.contains_key(&id) {
            return Err((-32602, format!("stream {id} 이미 사용 중")));
        }
        if g.tunnels.len() >= MAX_TUNNELS {
            return Err((-32006, format!("동시 터널은 최대 {MAX_TUNNELS}개입니다")));
        }
    }
    let (stream, addr) = dial(port as u16).await.map_err(|e| (-32020, e))?;
    let (mut rd, mut wr) = stream.into_split();
    let (to_local, mut from_gateway) = mpsc::unbounded_channel::<Vec<u8>>();

    let writer = tokio::spawn(async move {
        while let Some(bytes) = from_gateway.recv().await {
            if wr.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });
    let reader = tokio::spawn(async move {
        let mut buf = vec![0u8; READ_CHUNK];
        let error = loop {
            match rd.read(&mut buf).await {
                Ok(0) => break None,
                Ok(n) => {
                    let out = hub().lock().unwrap().out.clone();
                    let Some(out) = out else { break Some("연결 끊김".to_string()) };
                    // bounded queue: a slow platform side slows this read down instead of buffering
                    if out.send(Message::Binary(frame(id, &buf[..n]))).await.is_err() {
                        break Some("연결 끊김".to_string());
                    }
                }
                Err(e) => break Some(e.to_string()),
            }
        };
        notify_closed(id, error).await;
    });
    hub().lock().unwrap().tunnels.insert(id, Tunnel { to_local, reader, writer });
    Ok(json!({ "streamId": id, "addr": addr }))
}

/// JSON-RPC entry point for `tunnel.*`; None when the method is not a tunnel method.
pub async fn rpc(method: &str, params: &Value) -> Option<RpcResult> {
    Some(match method {
        "tunnel.open" => open(params).await,
        "tunnel.close" => {
            let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32);
            match id {
                Some(id) => Ok(json!({ "ok": close(id) })),
                None => Err((-32602, "streamId 필요".to_string())),
            }
        }
        "tunnel.list" => Ok(json!({ "count": count() })),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn pipe_both_ways_and_close() {
        let (tx, mut rx) = mpsc::channel::<Message>(16);
        attach(tx);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&[b"echo:".as_slice(), &buf].concat()).await.unwrap();
        });
        let r = rpc("tunnel.open", &json!({ "streamId": 7, "port": port })).await.unwrap().unwrap();
        assert_eq!(r["streamId"], 7);
        write(7, b"hello");
        let Some(Message::Binary(b)) = rx.recv().await else { panic!("no data") };
        assert_eq!(&b[..4], &7u32.to_be_bytes());
        assert_eq!(&b[4..], b"echo:hello");
        // the local server closed its side → tunnel.closed
        let Some(Message::Text(t)) = rx.recv().await else { panic!("no close note") };
        assert!(t.contains("tunnel.closed") && t.contains("\"streamId\":7"));
        assert_eq!(count(), 0);

        // refused ports, privileged ports, nothing listening
        assert_eq!(rpc("tunnel.open", &json!({ "streamId": 8, "port": 80 })).await.unwrap().unwrap_err().0, -32602);
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let e = rpc("tunnel.open", &json!({ "streamId": 9, "port": free })).await.unwrap().unwrap_err();
        assert_eq!(e.0, -32020);
        assert!(rpc("exec.start", &json!({})).await.is_none());
        detach();
    }
}
