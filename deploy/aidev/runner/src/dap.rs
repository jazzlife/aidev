//! `dap.*` (IMPLEMENTATION-PLAN §3.12, F-09/F-09b): debug adapters on this PC for the platform's debugger.
//!   dap.start {adapter, cwd?, program?, debugger?, command?, commandArgs?, transport?} → {id, adapter, version, port, pid, cwd, program}
//!   dap.stop {id} → {ok}          dap.list {} → {sessions:[…]}      dap.adapters {} → {available:[…], all:[…]}
//!   fs.read {path, maxBytes?} → {path, text, size, truncated}   (source view; allowed folders only)
//!   notification dap.exited {id, code, tail} when an adapter ends by itself
//! Every session ends up as a DAP server on 127.0.0.1:<port> that the gateway reaches through a tunnel
//! (`tunnel.open`, F-06): TCP adapters listen there themselves (js-debug's child sessions connect to the
//! same port); stdio adapters (gdb, lldb-dap, netcoredbg, JVM, Dart/Flutter, Mono, .NET Framework, custom)
//! get a one-client TCP port from the runner, piped to their stdin/stdout. Which adapters exist and how
//! they are provisioned: dap_adapters.rs. `cwd` and `program` must lie in the allowed folders; the
//! resolved paths are what the gateway puts in the launch request. Adapters end when the connection to
//! the platform is lost.

use crate::proc_util::NoWindow;
use crate::config::Config;
use crate::exec::Out;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio_tungstenite::tungstenite::Message;

type RpcResult = Result<Value, (i64, String)>;
const MAX_SESSIONS: usize = 4;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const TAIL_BYTES: usize = 4096;
const MAX_READ: u64 = 2 * 1024 * 1024;

struct Session {
    adapter: String,
    port: u16,
    pid: Option<u32>,
    started: u64,
    /// true = stop the adapter and the program it started (stop, detach)
    kill: tokio::sync::watch::Sender<bool>,
    tail: std::sync::Arc<Mutex<Vec<u8>>>,
}

#[derive(Default)]
struct Inner {
    out: Option<Out>,
    sessions: HashMap<u32, Session>,
    next: u32,
}

fn hub() -> &'static Mutex<Inner> {
    static HUB: OnceLock<Mutex<Inner>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(Inner::default()))
}

pub fn attach(out: Out) {
    hub().lock().unwrap().out = Some(out);
}

/// Connection lost: every adapter (and the program it debugs) ends — nobody could drive it any more.
pub fn detach() {
    let mut g = hub().lock().unwrap();
    g.out = None;
    for (_, s) in g.sessions.drain() {
        let _ = s.kill.send(true);
    }
}

pub fn count() -> usize {
    hub().lock().unwrap().sessions.len()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Someone listens on 127.0.0.1:<port> (binding it fails).
fn port_taken(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn push_tail(tail: &Mutex<Vec<u8>>, bytes: &[u8]) {
    let mut t = tail.lock().unwrap();
    t.extend_from_slice(bytes);
    if t.len() > TAIL_BYTES {
        let cut = t.len() - TAIL_BYTES;
        t.drain(..cut);
    }
}

fn tail_text(tail: &Mutex<Vec<u8>>) -> String {
    String::from_utf8_lossy(&tail.lock().unwrap()).trim().to_string()
}

/// Resolves when the session is told to stop (or its sender is gone).
async fn until_stopped(mut rx: tokio::sync::watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
}

async fn start(cfg: &Config, params: &Value) -> RpcResult {
    let adapter = params.get("adapter").and_then(Value::as_str).unwrap_or("").to_string();
    let cwd_req = params.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty());
    let cwd = match cwd_req {
        Some(c) => crate::roots::resolve(&cfg.allowed_roots, c).map_err(|e| (-32001, e))?,
        None => cfg.allowed_roots.first().cloned().ok_or((-32001, "허용된 폴더(allowed_roots)가 없습니다".to_string()))?,
    };
    if !cwd.is_dir() {
        return Err((-32001, format!("작업 폴더가 없습니다: {}", cwd.display())));
    }
    let program = match params.get("program").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        // relative programs are relative to cwd, as in a launch.json
        Some(p) => {
            let joined = if Path::new(p).is_absolute() || p.starts_with('~') { p.to_string() } else { cwd.join(p).display().to_string() };
            Some(crate::roots::resolve(&cfg.allowed_roots, &joined).map_err(|e| (-32001, e))?)
        }
        None => None,
    };
    if let Some(p) = &program {
        if !p.exists() {
            return Err((-32001, format!("프로그램이 없습니다: {}", p.display())));
        }
    }
    if count() >= MAX_SESSIONS {
        return Err((-32005, format!("디버그 세션은 동시에 {MAX_SESSIONS}개까지입니다")));
    }
    // downloads / pip may take a while: off the async threads
    let mut opts = crate::dap_adapters::Options::from_params(params, Some(cfg.gateway.clone()).filter(|g| !g.is_empty()));
    opts.program = program.clone();
    let (port, launch) = {
        let adapter = adapter.clone();
        tokio::task::spawn_blocking(move || {
            let port = free_port()?;
            let launch = crate::dap_adapters::launch(&adapter, port, &opts)?;
            Ok::<_, String>((port, launch))
        })
        .await
        .map_err(|e| (-32000, e.to_string()))?
        .map_err(|e| (-32002, e))?
    };
    let version = launch.version.clone();
    // a stdio adapter gets its port from the runner: bound before the adapter starts, handed one client
    let listener = if launch.stdio {
        Some(tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| (-32002, format!("127.0.0.1:{port}: {e}")))?)
    } else {
        None
    };

    let mut cmd = tokio::process::Command::new(&launch.program);
    cmd.args(&launch.args).current_dir(&cwd).kill_on_drop(true);
    if let Some(path) = crate::exec::user_path() {
        cmd.env("PATH", path);
    }
    cmd.envs(launch.env.clone());
    cmd.stdin(if launch.stdio { std::process::Stdio::piped() } else { std::process::Stdio::null() });
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window pops up for the adapter
    let mut child = cmd.spawn().map_err(|e| (-32002, format!("{}: {e}", launch.program.display())))?;
    let pid = child.id();
    let tail = std::sync::Arc::new(Mutex::new(Vec::new()));
    let stderr = child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let stdout = child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let stdin = child.stdin.take();
    // stderr (and a TCP adapter's stdout) only feed the tail shown when something goes wrong
    let (logs, dap_out): (Vec<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, _) = if launch.stdio { (stderr.into_iter().collect(), stdout) } else { (stderr.into_iter().chain(stdout).collect(), None) };
    for pipe in logs {
        let tail = tail.clone();
        let mut pipe = pipe;
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                push_tail(&tail, &buf[..n]);
            }
        });
    }

    if let Some(listener) = listener {
        // the adapter must survive its first moments (a missing runtime, a bad flag ends it at once)
        tokio::time::sleep(Duration::from_millis(400)).await;
        if let Ok(Some(status)) = child.try_wait() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            return Err((-32002, format!("{adapter} 어댑터가 바로 끝났습니다 ({status}): {}", tail_text(&tail))));
        }
        let (mut child_in, mut child_out) = (stdin.ok_or((-32002, "stdin 없음".to_string()))?, dap_out.ok_or((-32002, "stdout 없음".to_string()))?);
        tokio::spawn(async move {
            // one client: the gateway's tunnel; if none comes within 2 minutes the session is useless
            let Ok(Ok((sock, _))) = tokio::time::timeout(Duration::from_secs(120), listener.accept()).await else { return };
            drop(listener);
            let _ = sock.set_nodelay(true);
            let (mut rd, mut wr) = sock.into_split();
            let up = tokio::spawn(async move { let _ = tokio::io::copy(&mut rd, &mut child_in).await; });
            let _ = tokio::io::copy(&mut child_out, &mut wr).await;
            up.abort();
        });
    } else {
        // ready when the port is taken: checked by trying to bind it, never by connecting — debugpy and
        // codelldb serve exactly one client, a probe connection would use it up
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                tokio::time::sleep(Duration::from_millis(100)).await;
                return Err((-32002, format!("{adapter} 어댑터가 바로 끝났습니다 ({status}): {}", tail_text(&tail))));
            }
            if port_taken(port) {
                break;
            }
            if Instant::now() > deadline {
                let _ = child.start_kill();
                return Err((-32002, format!("{adapter} 어댑터가 {}초 안에 준비되지 않았습니다: {}", START_TIMEOUT.as_secs(), tail_text(&tail))));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    let (kill_tx, kill_rx) = tokio::sync::watch::channel(false);
    let debuggee_rx = kill_tx.subscribe();
    let id = {
        let mut g = hub().lock().unwrap();
        g.next = g.next.wrapping_add(1).max(1);
        let id = g.next;
        g.sessions.insert(id, Session { adapter: adapter.clone(), port, pid, started: now_ms(), kill: kill_tx, tail: tail.clone() });
        id
    };
    tokio::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = until_stopped(kill_rx) => {
                #[cfg(unix)]
                if let Some(pid) = pid { kill_group(pid); }
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
                #[cfg(unix)]
                if let Some(pid) = pid { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } }
                return;   // stopped on request: the gateway knows
            }
        };
        let out = {
            let mut g = hub().lock().unwrap();
            if let Some(s) = g.sessions.remove(&id) { let _ = s.kill.send(true); }
            g.out.clone()
        };
        if let Some(out) = out {
            let note = json!({ "jsonrpc": "2.0", "method": "dap.exited", "params": { "id": id, "code": code, "tail": tail_text(&tail) } });
            let _ = out.send(Message::Text(note.to_string())).await;
        }
    });

    // The program an attach-type adapter connects to (JVM with JDWP, node --inspect, debugpy --listen,
    // mono --debugger-agent …): started here, tied to the session, its output sent as dap.output.
    let mut debug_port: Option<u16> = None;
    if let Some(spawn) = params.get("spawn").filter(|v| v.is_object()) {
        let argv: Vec<String> = spawn.get("argv").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let fail = |msg: String| { let _ = stop(&json!({ "id": id })); Err((-32002, msg)) };
        if argv.is_empty() {
            return fail("spawn.argv가 비어 있습니다".into());
        }
        let dport = match free_port() { Ok(p) => p, Err(e) => return fail(e) };
        let argv: Vec<String> = argv.into_iter().map(|a| a.replace("{debugPort}", &dport.to_string())).collect();
        let program = if Path::new(&argv[0]).is_absolute() { Some(std::path::PathBuf::from(&argv[0])) } else { crate::dap_adapters::which(&argv[0]) };
        let Some(program) = program else { return fail(format!("{}을(를) 찾지 못했습니다", argv[0])) };
        let mut cmd = tokio::process::Command::new(&program);
        cmd.no_window().args(&argv[1..]).current_dir(&cwd).kill_on_drop(true).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        if let Some(path) = crate::exec::user_path() { cmd.env("PATH", path); }
        if let Some(env) = spawn.get("env").and_then(Value::as_object) {
            for (k, v) in env { if let Some(v) = v.as_str() { cmd.env(k, v); } }
        }
        #[cfg(unix)]
        cmd.process_group(0);
        let mut prog = match cmd.spawn() { Ok(c) => c, Err(e) => return fail(format!("{}: {e}", program.display())) };
        let ppid = prog.id();
        #[cfg(not(unix))]
        let _ = ppid;
        for (pipe, category) in [(prog.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), "stdout"), (prog.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), "stderr")] {
            let Some(mut pipe) = pipe else { continue };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                while let Ok(n) = pipe.read(&mut buf).await {
                    if n == 0 { break; }
                    let out = hub().lock().unwrap().out.clone();
                    if let Some(out) = out {
                        let note = json!({ "jsonrpc": "2.0", "method": "dap.output", "params": { "id": id, "category": category, "text": String::from_utf8_lossy(&buf[..n]) } });
                        let _ = out.send(Message::Text(note.to_string())).await;
                    }
                }
            });
        }
        tokio::spawn(async move {
            tokio::select! {
                status = prog.wait() => {
                    let out = hub().lock().unwrap().out.clone();
                    if let Some(out) = out {
                        let note = json!({ "jsonrpc": "2.0", "method": "dap.output", "params": { "id": id, "category": "console", "text": format!("[프로그램 종료: {}]\n", status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string())) } });
                        let _ = out.send(Message::Text(note.to_string())).await;
                    }
                }
                _ = until_stopped(debuggee_rx) => {
                    #[cfg(unix)]
                    if let Some(p) = ppid { kill_group(p); }
                    let _ = prog.start_kill();
                    let _ = tokio::time::timeout(Duration::from_secs(3), prog.wait()).await;
                }
            }
        });
        if spawn.get("waitPort").and_then(Value::as_bool).unwrap_or(true) {
            let deadline = Instant::now() + Duration::from_secs(60);
            while !port_taken(dport) {
                if Instant::now() > deadline { return fail(format!("{}이(가) 60초 안에 디버그 포트 {dport}를 열지 않았습니다", argv[0])); }
                if !hub().lock().unwrap().sessions.contains_key(&id) { return Err((-32002, "어댑터가 끝났습니다".into())); }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        debug_port = Some(dport);
    }
    // a phone or simulator app made ready to attach to (devices.rs); undone when the session ends
    let mut device_pid: Option<u32> = None;
    let mut device_note: Option<String> = None;
    let device = if let Some(a) = params.get("android").filter(|v| v.is_object()).cloned() {
        Some(tokio::task::spawn_blocking(move || crate::devices::android(&a, free_port)).await)
    } else if let Some(i) = params.get("iosSim").filter(|v| v.is_object()).cloned() {
        Some(tokio::task::spawn_blocking(move || crate::devices::ios_sim(&i)).await)
    } else {
        None
    };
    if let Some(done) = device {
        let prepared = match done {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => { let _ = stop(&json!({ "id": id })); return Err((-32003, e)); }
            Err(e) => { let _ = stop(&json!({ "id": id })); return Err((-32003, e.to_string())); }
        };
        debug_port = prepared.debug_port.or(debug_port);
        device_pid = prepared.pid;
        device_note = Some(prepared.note);
        let stopped = hub().lock().unwrap().sessions.get(&id).map(|s| s.kill.subscribe());
        if let Some(rx) = stopped {
            let cleanup = prepared.cleanup;
            tokio::spawn(async move {
                until_stopped(rx).await;
                let _ = tokio::task::spawn_blocking(move || for c in &cleanup { let _ = crate::devices::run(c, Duration::from_secs(15)); }).await;
            });
        }
    }
    Ok(json!({
        "id": id, "adapter": adapter, "version": version, "port": port, "pid": pid, "transport": if launch.stdio { "stdio" } else { "tcp" },
        "cwd": cwd.display().to_string(), "program": program.map(|p| p.display().to_string()), "debugPort": debug_port,
        "devicePid": device_pid, "device": device_note,
    }))
}

fn stop(params: &Value) -> RpcResult {
    let id = params.get("id").and_then(Value::as_u64).ok_or((-32602, "id 필요".to_string()))? as u32;
    let s = hub().lock().unwrap().sessions.remove(&id);
    match s {
        Some(s) => {
            let _ = s.kill.send(true);
            Ok(json!({ "ok": true }))
        }
        None => Ok(json!({ "ok": false })),
    }
}

fn list() -> Value {
    let g = hub().lock().unwrap();
    let sessions: Vec<Value> = g.sessions.iter().map(|(id, s)| json!({ "id": id, "adapter": s.adapter, "port": s.port, "pid": s.pid, "started": s.started, "tail": tail_text(&s.tail) })).collect();
    json!({ "sessions": sessions })
}

/// A text file inside the allowed folders (the debugger's source view).
fn read(cfg: &Config, params: &Value) -> RpcResult {
    let path = params.get("path").and_then(Value::as_str).unwrap_or("");
    let max = params.get("maxBytes").and_then(Value::as_u64).unwrap_or(512 * 1024).min(MAX_READ);
    let real = crate::roots::resolve(&cfg.allowed_roots, path).map_err(|e| (-32001, e))?;
    let meta = std::fs::metadata(&real).map_err(|e| (-32001, format!("{}: {e}", real.display())))?;
    if !meta.is_file() {
        return Err((-32001, format!("파일이 아닙니다: {}", real.display())));
    }
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(std::fs::File::open(&real).map_err(|e| (-32001, e.to_string()))?, max), &mut buf).map_err(|e| (-32001, e.to_string()))?;
    if buf.iter().take(8000).any(|b| *b == 0) {
        return Err((-32001, format!("텍스트 파일이 아닙니다: {}", real.display())));
    }
    Ok(json!({ "path": real.display().to_string(), "text": String::from_utf8_lossy(&buf), "size": meta.len(), "truncated": meta.len() > max }))
}

pub async fn rpc(cfg: &Config, method: &str, params: &Value) -> Option<RpcResult> {
    Some(match method {
        "dap.start" => start(cfg, params).await,
        "dap.stop" => stop(params),
        "dap.list" => Ok(list()),
        "dap.adapters" => Ok(json!({ "available": tokio::task::spawn_blocking(crate::dap_adapters::available).await.unwrap_or_default(), "all": crate::dap_adapters::ADAPTERS })),
        "fs.read" => read(cfg, params),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::path::PathBuf;

    fn cfg(dir: &Path) -> Config {
        let mut c = Config::default();
        c.allowed_roots = vec![dir.to_path_buf()];
        c
    }

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aidev-dap-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// DAP over TCP: one request, the matching response (events before it are skipped).
    fn dap_roundtrip(port: u16, command: &str, args: Value) -> Value {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let body = json!({ "seq": 1, "type": "request", "command": command, "arguments": args }).to_string();
        s.write_all(format!("Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = s.read(&mut chunk).unwrap_or_else(|e| panic!("read: {e}; adapters: {}", list()));
            assert!(n > 0, "adapter closed the connection");
            buf.extend_from_slice(&chunk[..n]);
            while let Some(h) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..h]).to_string();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).unwrap().trim().parse().unwrap();
                if buf.len() < h + 4 + len {
                    break;
                }
                let msg: Value = serde_json::from_slice(&buf[h + 4..h + 4 + len]).unwrap();
                buf.drain(..h + 4 + len);
                if msg["type"] == "response" {
                    return msg;
                }
            }
        }
    }

    #[tokio::test]
    async fn read_stays_in_roots() {
        let d = tempdir("read");
        std::fs::write(d.join("a.js"), "let x = 1;\n").unwrap();
        let c = cfg(&d);
        let r = read(&c, &json!({ "path": d.join("a.js").display().to_string() })).unwrap();
        assert_eq!(r["text"], "let x = 1;\n");
        assert!(read(&c, &json!({ "path": "/etc/hosts" })).is_err());
        std::fs::write(d.join("b.bin"), [0u8, 1, 2]).unwrap();
        assert!(read(&c, &json!({ "path": d.join("b.bin").display().to_string() })).unwrap_err().1.contains("텍스트"));
    }

    #[tokio::test]
    async fn start_refuses_outside_roots_and_unknown_adapters() {
        let d = tempdir("refuse");
        let c = cfg(&d);
        assert!(start(&c, &json!({ "adapter": "js-debug", "cwd": "/etc" })).await.unwrap_err().1.contains("허용된 폴더 밖"));
        assert!(start(&c, &json!({ "adapter": "js-debug", "program": "/etc/hosts" })).await.unwrap_err().1.contains("허용된 폴더 밖"));
        assert!(start(&c, &json!({ "adapter": "js-debug", "program": "missing.js" })).await.unwrap_err().1.contains("없습니다"));
        assert!(start(&c, &json!({ "adapter": "gdb9000" })).await.unwrap_err().1.contains("지원하지 않는"));
    }

    /// Needs the adapter files in AIDEV_ADAPTER_MIRROR (test/smoke.sh provides them); skipped otherwise.
    #[tokio::test]
    async fn adapters_start_and_answer_initialize() {
        let Some(_) = std::env::var_os("AIDEV_ADAPTER_MIRROR") else { eprintln!("skip: AIDEV_ADAPTER_MIRROR not set"); return };
        let home = tempdir("home");
        std::env::set_var("AIDEV_RUNNER_HOME", &home);
        let d = tempdir("adapters");
        std::fs::write(d.join("app.js"), "console.log(1)\n").unwrap();
        let c = cfg(&d);
        // gdb (stdio, bridged by the runner) when this machine has GDB 14+
        let with_gdb = crate::dap_adapters::available().contains(&"gdb");
        // jvm: aidev-jdi from the runner binary (stdio) when this machine has a JDK 11+
        let with_jvm = crate::dap_adapters::available().contains(&"jvm");
        // probe-rs answers initialize without a probe attached (the launch would need hardware)
        for adapter in ["js-debug", "debugpy", "codelldb", "gdb", "jvm", "probe-rs"] {
            if adapter == "gdb" && !with_gdb { eprintln!("skip gdb: no GDB 14+"); continue; }
            if adapter == "jvm" && !with_jvm { eprintln!("skip jvm: no java"); continue; }
            let r = start(&c, &json!({ "adapter": adapter, "program": "app.js" })).await.unwrap_or_else(|e| panic!("{adapter}: {}", e.1));
            assert_eq!(r["transport"], if adapter == "gdb" || adapter == "jvm" { "stdio" } else { "tcp" });
            let port = r["port"].as_u64().unwrap() as u16;
            assert_eq!(r["program"], d.join("app.js").canonicalize().unwrap().display().to_string());
            let resp = tokio::task::spawn_blocking(move || dap_roundtrip(port, "initialize", json!({ "adapterID": "aidev", "clientID": "aidev", "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path" }))).await.unwrap();
            assert_eq!(resp["success"], true, "{adapter}: {resp}");
            assert_eq!(list()["sessions"].as_array().unwrap().len(), 1);
            assert_eq!(stop(&json!({ "id": r["id"] })).unwrap()["ok"], true);
            assert_eq!(count(), 0);
            // provisioned once: the second start does not fetch again
            assert!(home.join("adapters").read_dir().unwrap().any(|e| e.unwrap().path().join(".aidev-ok").is_file()));
        }
    }
}
