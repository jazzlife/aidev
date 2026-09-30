//! `dap.*` (IMPLEMENTATION-PLAN §3.12, F-09): debug adapters on this PC for the platform's debugger.
//!   dap.start {adapter, cwd?, program?} → {id, adapter, version, port, pid, cwd, program}
//!   dap.stop {id} → {ok}          dap.list {} → {sessions:[…]}
//!   fs.read {path, maxBytes?} → {path, text, size, truncated}   (source view; allowed folders only)
//!   notification dap.exited {id, code, tail} when an adapter ends by itself
//! An adapter is a DAP *server* on 127.0.0.1:<port>; the gateway speaks DAP to it through a tunnel
//! (`tunnel.open`, F-06), js-debug's child sessions included (they connect to the same port).
//!   js-debug  (Node/Chrome) — Microsoft's standalone DAP server, needs `node` on this PC
//!   debugpy   (Python)      — `python3 -m debugpy.adapter`, needs `python3` (debugpy is installed privately)
//!   codelldb  (C/C++/Rust/Swift) — LLDB-based, self-contained
//! Nothing has to be installed by the user: an adapter is fetched once into <runner home>/adapters/ at a
//! pinned version and checked against its SHA-256 (AIDEV_ADAPTER_MIRROR=<dir> takes the same files from a
//! local folder instead). `cwd` and `program` must lie in the allowed folders; the resolved paths are what
//! the gateway puts in the launch request. Adapters end when the connection to the platform is lost.

use crate::config::Config;
use crate::exec::Out;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

type RpcResult = Result<Value, (i64, String)>;
const MAX_SESSIONS: usize = 4;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const TAIL_BYTES: usize = 4096;
const MAX_DOWNLOAD: u64 = 120 * 1024 * 1024;
const MAX_READ: u64 = 2 * 1024 * 1024;

pub const JS_DEBUG_VERSION: &str = "1.112.0";
const JS_DEBUG_SHA256: &str = "31eb1bd9792f62c32f7c22b66ce612e2e54a7664201a2d80bdb49cc4bf4ca925";
pub const DEBUGPY_VERSION: &str = "1.8.22";
pub const CODELLDB_VERSION: &str = "1.12.3";
/// codelldb release asset per platform and its SHA-256.
const CODELLDB_ASSETS: &[(&str, &str)] = &[
    ("darwin-arm64", "2f114a990e1b368dd1dbd33c80c0e719767af2d228391ec0df0571c957f9ac91"),
    ("darwin-x64", "e25cc716b94c62c07fec268ff2785d2b797245b160502baef8b9c970a0c4d8e8"),
    ("linux-x64", "1cd7f386598022b51a5b93b9ffa23e812b23f519cfe1833384ec4bef4bfd1be1"),
    ("linux-arm64", "0887f67d440554617894266f80706b700907c36b95e6e49d23b95a0e05318101"),
    ("win32-x64", "a916e509308dac817732f63ca604a8b93ed29cd16f38a2fa9f0b64ed58e8f51a"),
];

struct Session {
    adapter: String,
    port: u16,
    pid: Option<u32>,
    started: u64,
    kill: Option<oneshot::Sender<()>>,
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
    for (_, mut s) in g.sessions.drain() {
        if let Some(k) = s.kill.take() {
            let _ = k.send(());
        }
    }
}

pub fn count() -> usize {
    hub().lock().unwrap().sessions.len()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn adapters_dir() -> PathBuf {
    crate::config::dir().join("adapters")
}

/// `bin` on the user's PATH (the login shell's, as jobs see it).
pub fn which(bin: &str) -> Option<PathBuf> {
    let path = crate::exec::user_path().or_else(|| std::env::var("PATH").ok())?;
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ""] } else { &[""] };
    for dir in path.split(sep).filter(|d| !d.is_empty()) {
        for ext in exts {
            let p = Path::new(dir).join(format!("{bin}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn codelldb_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

/// Fetches `url` (or `<AIDEV_ADAPTER_MIRROR>/<name>`) to `dest` and checks its SHA-256.
fn fetch(url: &str, name: &str, sha256: &str, dest: &Path) -> Result<(), String> {
    if let Some(mirror) = std::env::var_os("AIDEV_ADAPTER_MIRROR") {
        std::fs::copy(Path::new(&mirror).join(name), dest).map_err(|e| format!("{name} (AIDEV_ADAPTER_MIRROR): {e}"))?;
    } else {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(60)).build();
        let resp = agent.get(url).call().map_err(|e| format!("{name} 내려받기 실패: {e}"))?;
        let mut reader = std::io::Read::take(resp.into_reader(), MAX_DOWNLOAD + 1);
        let mut file = std::fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        let n = std::io::copy(&mut reader, &mut file).map_err(|e| format!("{name} 내려받기 실패: {e}"))?;
        if n > MAX_DOWNLOAD {
            return Err(format!("{name}: 파일이 너무 큽니다"));
        }
    }
    let got = crate::sync::sha256_file(dest).map_err(|e| e.to_string())?;
    if !got.eq_ignore_ascii_case(sha256) {
        let _ = std::fs::remove_file(dest);
        return Err(format!("{name}: SHA-256이 다릅니다 (받음 {got}) — 내려받은 파일을 쓰지 않습니다"));
    }
    Ok(())
}

/// `dir` exists and is complete (marker written last), or `build` fills a temp dir that is then moved in.
fn provision(dir: &Path, build: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    if dir.join(".aidev-ok").is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(adapters_dir()).map_err(|e| e.to_string())?;
    let tmp = dir.with_extension(format!("tmp{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    if let Err(e) = build(&tmp) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    std::fs::write(tmp.join(".aidev-ok"), now_ms().to_string()).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(dir);
    std::fs::rename(&tmp, dir).map_err(|e| format!("{}: {e}", dir.display()))
}

fn ensure_js_debug() -> Result<PathBuf, String> {
    let dir = adapters_dir().join(format!("js-debug-{JS_DEBUG_VERSION}"));
    provision(&dir, |tmp| {
        let name = format!("js-debug-dap-v{JS_DEBUG_VERSION}.tar.gz");
        let archive = tmp.join(&name);
        fetch(&format!("https://github.com/microsoft/vscode-js-debug/releases/download/v{JS_DEBUG_VERSION}/{name}"), &name, JS_DEBUG_SHA256, &archive)?;
        let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
        // unpack_in refuses entries that would land outside `tmp` (absolute paths, ..)
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            entry.unpack_in(tmp).map_err(|e| format!("{name}: {e}"))?;
        }
        std::fs::remove_file(&archive).map_err(|e| e.to_string())
    })?;
    let entry = dir.join("js-debug").join("src").join("dapDebugServer.js");
    if entry.is_file() { Ok(entry) } else { Err(format!("{}이(가) 없습니다", entry.display())) }
}

fn ensure_codelldb() -> Result<PathBuf, String> {
    let platform = codelldb_platform().ok_or_else(|| format!("codelldb는 이 플랫폼({}-{})을 지원하지 않습니다", std::env::consts::OS, std::env::consts::ARCH))?;
    let sha = CODELLDB_ASSETS.iter().find(|(p, _)| *p == platform).map(|(_, s)| *s).unwrap_or_default();
    let dir = adapters_dir().join(format!("codelldb-{CODELLDB_VERSION}"));
    provision(&dir, |tmp| {
        let name = format!("codelldb-{platform}.vsix");
        let archive = tmp.join(&name);
        fetch(&format!("https://github.com/vadimcn/codelldb/releases/download/v{CODELLDB_VERSION}/{name}"), &name, sha, &archive)?;
        let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{name}: {e}"))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            // only the extension payload, and never a path that leaves the folder
            let Some(rel) = f.enclosed_name() else { continue };
            if !rel.starts_with("extension") || f.is_dir() {
                continue;
            }
            let out = tmp.join(&rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut w = std::fs::File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
            std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let exec = f.unix_mode().map(|m| m & 0o111 != 0).unwrap_or(false) || rel.starts_with("extension/adapter/codelldb") || rel.starts_with("extension/lldb/bin");
                std::fs::set_permissions(&out, std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 })).map_err(|e| e.to_string())?;
            }
        }
        std::fs::remove_file(&archive).map_err(|e| e.to_string())
    })?;
    let bin = dir.join("extension").join("adapter").join(if cfg!(windows) { "codelldb.exe" } else { "codelldb" });
    if bin.is_file() { Ok(bin) } else { Err(format!("{}이(가) 없습니다", bin.display())) }
}

fn python() -> Result<PathBuf, String> {
    let names: &[&str] = if cfg!(windows) { &["python", "py"] } else { &["python3", "python"] };
    names.iter().find_map(|n| which(n)).ok_or_else(|| "Python 디버깅에는 이 PC에 python3가 있어야 합니다".to_string())
}

/// debugpy, installed privately (pip --target) so the user's Python stays untouched.
fn ensure_debugpy(python: &Path) -> Result<PathBuf, String> {
    let dir = adapters_dir().join(format!("debugpy-{DEBUGPY_VERSION}"));
    provision(&dir, |tmp| {
        let mut cmd = std::process::Command::new(python);
        cmd.args(["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--quiet", "--target"]).arg(tmp).arg(format!("debugpy=={DEBUGPY_VERSION}"));
        if let Some(mirror) = std::env::var_os("AIDEV_ADAPTER_MIRROR") {
            cmd.args(["--no-index", "--find-links"]).arg(mirror);
        }
        if let Some(path) = crate::exec::user_path() {
            cmd.env("PATH", path);
        }
        let out = cmd.stdin(std::process::Stdio::null()).output().map_err(|e| format!("pip 실행 실패: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("debugpy 설치 실패 (pip): {}", err.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" / ")));
        }
        if !tmp.join("debugpy").join("__init__.py").is_file() {
            return Err("debugpy 설치 결과가 없습니다".into());
        }
        Ok(())
    })?;
    Ok(dir)
}

/// Someone listens on 127.0.0.1:<port> (binding it fails).
fn port_taken(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

/// The adapter's command line (argv, extra env, version) for a port.
fn adapter_command(adapter: &str, port: u16) -> Result<(Vec<PathBuf>, Vec<String>, Vec<(String, String)>, &'static str), String> {
    match adapter {
        "js-debug" => {
            let node = which("node").ok_or("Node 디버깅에는 이 PC에 node가 있어야 합니다")?;
            let server = ensure_js_debug()?;
            Ok((vec![node, server], vec![port.to_string(), "127.0.0.1".into()], vec![], JS_DEBUG_VERSION))
        }
        "debugpy" => {
            let py = python()?;
            let dir = ensure_debugpy(&py)?;
            Ok((vec![py], vec!["-m".into(), "debugpy.adapter".into(), "--host".into(), "127.0.0.1".into(), "--port".into(), port.to_string()], vec![("PYTHONPATH".into(), dir.display().to_string())], DEBUGPY_VERSION))
        }
        "codelldb" => {
            let bin = ensure_codelldb()?;
            Ok((vec![bin], vec!["--port".into(), port.to_string()], vec![], CODELLDB_VERSION))
        }
        other => Err(format!("지원하지 않는 디버그 어댑터: {other} (js-debug | debugpy | codelldb)")),
    }
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
    let (port, argv, args, env, version) = {
        let adapter = adapter.clone();
        tokio::task::spawn_blocking(move || {
            let port = free_port()?;
            let (argv, args, env, version) = adapter_command(&adapter, port)?;
            Ok::<_, String>((port, argv, args, env, version))
        })
        .await
        .map_err(|e| (-32000, e.to_string()))?
        .map_err(|e| (-32002, e))?
    };

    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(argv[1..].iter()).args(&args).current_dir(&cwd).kill_on_drop(true);
    if let Some(path) = crate::exec::user_path() {
        cmd.env("PATH", path);
    }
    cmd.envs(env);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| (-32002, format!("{}: {e}", argv[0].display())))?;
    let pid = child.id();
    let tail = std::sync::Arc::new(Mutex::new(Vec::new()));
    for pipe in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
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

    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let id = {
        let mut g = hub().lock().unwrap();
        g.next = g.next.wrapping_add(1).max(1);
        let id = g.next;
        g.sessions.insert(id, Session { adapter: adapter.clone(), port, pid, started: now_ms(), kill: Some(kill_tx), tail: tail.clone() });
        id
    };
    tokio::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = kill_rx => {
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
            g.sessions.remove(&id);
            g.out.clone()
        };
        if let Some(out) = out {
            let note = json!({ "jsonrpc": "2.0", "method": "dap.exited", "params": { "id": id, "code": code, "tail": tail_text(&tail) } });
            let _ = out.send(Message::Text(note.to_string())).await;
        }
    });
    Ok(json!({
        "id": id, "adapter": adapter, "version": version, "port": port, "pid": pid,
        "cwd": cwd.display().to_string(), "program": program.map(|p| p.display().to_string()),
    }))
}

fn stop(params: &Value) -> RpcResult {
    let id = params.get("id").and_then(Value::as_u64).ok_or((-32602, "id 필요".to_string()))? as u32;
    let s = hub().lock().unwrap().sessions.remove(&id);
    match s {
        Some(mut s) => {
            if let Some(k) = s.kill.take() {
                let _ = k.send(());
            }
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
        "fs.read" => read(cfg, params),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

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
        assert!(start(&c, &json!({ "adapter": "gdb" })).await.unwrap_err().1.contains("지원하지 않는"));
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
        for adapter in ["js-debug", "debugpy", "codelldb"] {
            let r = start(&c, &json!({ "adapter": adapter, "program": "app.js" })).await.unwrap_or_else(|e| panic!("{adapter}: {}", e.1));
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
