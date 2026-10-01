//! `exec.*` (IMPLEMENTATION-PLAN §3.12, F-03): run commands on this PC and stream their output.
//!   exec.start {cmd | program+args, shell?, cwd, env, pty, cols, rows, timeoutSec, stdin?, streamId?, tag?} → {streamId, pid}
//!     `stdin` (text, no pty): written to the command's input, which is then closed (a prompt for an agent CLI)
//!     `shell` (0.12): which shell runs `cmd` — default (login shell / cmd.exe), "powershell" (Windows PowerShell;
//!     pwsh elsewhere), "pwsh", "cmd" (Windows), "bash" (Git Bash on Windows), "sh". PowerShell gets the command as
//!     -EncodedCommand (no quoting layer at all) and exits with the last native exit code or 1 on an error.
//! Windows: output is UTF-8 (cmd runs `chcp 65001` first, Python gets PYTHONIOENCODING) and a stop ends the whole
//! process tree (`taskkill /T /F`) — killing cmd.exe alone would leave `npm run dev`'s node running.
//!   exec.write {streamId, data | b64}   exec.resize {streamId, cols, rows}   exec.signal {streamId, signal}
//!   exec.list → running + recently finished     exec.tail {streamId, bytes} → last output (base64)
//!   notification exec.exit {streamId, code, signal, durationMs}
//! Output travels as binary frames `[streamId u32 BE][bytes]`. The gateway allocates stream ids so it
//! knows a stream before its first byte arrives. Processes outlive a dropped connection (a dev server
//! keeps running); while offline the output only goes to the per-stream tail (64 KB), and the gateway
//! reconciles with `exec.list` after reconnecting. `cwd` must lie inside allowed_roots. The environment
//! is a small safe baseline (PATH, HOME, LANG, …) plus the variables the job sends, unless the owner
//! set `inherit_env = true`.

use crate::proc_util::NoWindow;
use crate::config::Config;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub const MAX_RUNNING: usize = 16;
const TAIL_BYTES: usize = 64 * 1024;
const CHUNK: usize = 16 * 1024;
const KEEP_FINISHED: usize = 32;
const MAX_CMD: usize = 16 * 1024;
const MAX_WRITE: usize = 64 * 1024;
const MAX_STDIN: usize = 256 * 1024;

pub type Out = mpsc::Sender<Message>;
type RpcResult = Result<Value, (i64, String)>;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Sig {
    Int,
    Term,
    Kill,
}

enum Ctl {
    Write(Vec<u8>),
    Resize(u16, u16),
    Signal(Sig),
}

struct Proc {
    /// Opaque label from the gateway (its remote_runs id) so a restarted gateway can adopt the stream.
    tag: Option<String>,
    pid: Option<u32>,
    cmd: String,
    cwd: String,
    pty: bool,
    started_ms: u64,
    started: Instant,
    exit: Option<(Option<i32>, Option<String>)>,
    duration_ms: Option<u64>,
    tail: VecDeque<u8>,
    bytes: u64,
    ctl: Option<mpsc::UnboundedSender<Ctl>>,
}

struct Inner {
    out: Option<Out>,
    procs: HashMap<u32, Proc>,
    finished: VecDeque<u32>,
    next: u32,
}

#[derive(Clone)]
pub struct ExecHub(Arc<Mutex<Inner>>);

impl Default for ExecHub {
    fn default() -> Self {
        use rand::Rng;
        // runner-chosen ids (when the gateway sends none) start high so they never meet gateway ids
        let next = rand::thread_rng().gen_range(0x4000_0000u32..0x7000_0000u32);
        ExecHub(Arc::new(Mutex::new(Inner { out: None, procs: HashMap::new(), finished: VecDeque::new(), next })))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn frame(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(4 + payload.len());
    f.extend_from_slice(&id.to_be_bytes());
    f.extend_from_slice(payload);
    f
}

fn sig_of(name: &str) -> Option<Sig> {
    match name.trim_start_matches("SIG").to_ascii_uppercase().as_str() {
        "INT" => Some(Sig::Int),
        "TERM" => Some(Sig::Term),
        "KILL" => Some(Sig::Kill),
        _ => None,
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, sig: Sig) {
    let s = match sig {
        Sig::Int => libc::SIGINT,
        Sig::Term => libc::SIGTERM,
        Sig::Kill => libc::SIGKILL,
    };
    // the child leads its own process group (pty: setsid; pipes: process_group(0)) → signal the group
    unsafe {
        if libc::kill(-(pid as i32), s) != 0 {
            libc::kill(pid as i32, s);
        }
    }
}

/// Variables every command gets even without `inherit_env` (no secrets from the runner's own env).
const BASE_ENV: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ",
    // Windows
    "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "TEMP", "TMP",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

fn valid_env_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 128 && k.chars().enumerate().all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

/// Environment for a job: baseline (or the whole runner env) + the job's own variables.
fn job_env(cfg: &Config, extra: &serde_json::Map<String, Value>, pty: bool) -> Result<Vec<(String, String)>, String> {
    let mut env: Vec<(String, String)> = if cfg.inherit_env {
        std::env::vars().collect()
    } else {
        std::env::vars().filter(|(k, _)| BASE_ENV.iter().any(|b| b.eq_ignore_ascii_case(k))).collect()
    };
    if !pty {
        if let Some(path) = user_path() {
            env.retain(|(k, _)| k != "PATH");
            env.push(("PATH".into(), path));
        }
    }
    let defaults: &[(&str, &str)] = if pty {
        &[("TERM", "xterm-256color"), ("COLORTERM", "truecolor")]
    } else {
        // nobody can answer a prompt on an output-only job: tools should not ask, page or wait
        &[("TERM", "dumb"), ("CI", "1"), ("PAGER", "cat"), ("GIT_PAGER", "cat"), ("GIT_TERMINAL_PROMPT", "0"), ("npm_config_yes", "true"), ("HOMEBREW_NO_AUTO_UPDATE", "1")]
    };
    for (k, v) in defaults {
        env.retain(|(ek, _)| ek != k);
        env.push((k.to_string(), v.to_string()));
    }
    if cfg!(windows) && !pty {
        // Python writes pipes in the ANSI code page (cp949 …) unless told otherwise; the gateway reads UTF-8
        env.push(("PYTHONIOENCODING".into(), "utf-8".into()));
    }
    add_to_path(&mut env, &crate::devices::sdk_bin_dirs());
    for (k, v) in extra {
        if !valid_env_key(k) {
            return Err(format!("잘못된 환경 변수 이름: {k}"));
        }
        let v = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => return Err(format!("환경 변수 {k}: 문자열만 허용")),
        };
        env.retain(|(ek, _)| ek != k);
        env.push((k.clone(), v));
    }
    Ok(env)
}

/// Appends `dirs` that are not on the job's PATH yet (adb found in the Android SDK folder: `adb logcat` must work
/// in a command too, not only in device.list).
fn add_to_path(env: &mut Vec<(String, String)>, dirs: &[std::path::PathBuf]) {
    if dirs.is_empty() {
        return;
    }
    let key = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(k, _)| k.clone()).unwrap_or_else(|| "PATH".into());
    let current = env.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone()).unwrap_or_default();
    let mut parts: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
    let before = parts.len();
    for d in dirs {
        if !parts.iter().any(|p| p == d) {
            parts.push(d.clone());
        }
    }
    if parts.len() == before {
        return;
    }
    if let Ok(joined) = std::env::join_paths(parts) {
        env.retain(|(k, _)| *k != key);
        env.push((key, joined.to_string_lossy().into_owned()));
    }
}

fn user_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| std::path::Path::new(s).exists()).unwrap_or_else(|| {
        ["/bin/zsh", "/bin/bash", "/bin/sh"].iter().find(|s| std::path::Path::new(s).exists()).unwrap_or(&"/bin/sh").to_string()
    })
}

/// PATH as the user's interactive shell sets it (~/.zshrc: nvm, pyenv, brew …), probed once with
/// stdin closed and a time limit. Jobs then run in a *non-interactive* login shell with this PATH,
/// so rc files that prompt or wait for a terminal can never hang a command.
static USER_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

pub fn user_path() -> Option<String> {
    USER_PATH.get_or_init(|| {
        if cfg!(windows) {
            return None;
        }
        use std::process::{Command, Stdio};
        let mut child = Command::new(user_shell())
            .args(["-ilc", "printf '__AIDEV_PATH__%s__END__' \"$PATH\""])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().ok()?;
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => { let _ = child.kill(); let _ = child.wait(); return None; }
            }
        }
        let mut out = String::new();
        std::io::Read::read_to_string(child.stdout.as_mut()?, &mut out).ok()?;
        let start = out.find("__AIDEV_PATH__")? + "__AIDEV_PATH__".len();
        let end = out[start..].find("__END__")? + start;
        let path = out[start..end].trim().to_string();
        (!path.is_empty()).then_some(path)
    }).clone()
}

/// `cmd` runs through the user's login shell. Output-only jobs (no pty) use a non-interactive shell
/// with the probed PATH; a pty job is interactive like a terminal the user opened (zsh -ilc).
fn shell_argv(cmd: &str, pty: bool) -> Vec<String> {
    if cfg!(windows) {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        // a pipe gets the console code page (cp949 …); a pty (ConPTY) is UTF-8 already
        let line = if pty { cmd.to_string() } else { format!("chcp 65001>nul & {cmd}") };
        return vec![comspec, "/d".into(), "/s".into(), "/c".into(), line];
    }
    let shell = user_shell();
    let flags = if pty && shell.ends_with("/zsh") { "-ilc" } else { "-lc" };
    vec![shell, flags.into(), cmd.into()]
}

/// PowerShell script around the job's command: UTF-8 output, no progress bars, and a shell-like exit code — the
/// last statement decides (0 when it succeeded; a failed native program's own code; 1 for a failed cmdlet).
/// The command runs at the top level, not in a `& { }` block: a cmdlet error inside a block leaves `$?` true.
fn powershell_script(cmd: &str) -> String {
    format!(
        "$ProgressPreference='SilentlyContinue'\n\
         try {{ [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false }} catch {{}}\n\
         $OutputEncoding = New-Object System.Text.UTF8Encoding $false\n\
         $global:LASTEXITCODE = 0\n\
         {cmd}\n\
         if (-not $?) {{ if ($global:LASTEXITCODE) {{ exit $global:LASTEXITCODE }} else {{ exit 1 }} }}\n\
         exit 0\n"
    )
}

/// -EncodedCommand: base64 of the UTF-16LE script — nothing on the way can re-quote it.
pub fn powershell_encoded(cmd: &str) -> String {
    let utf16: Vec<u8> = powershell_script(cmd).encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Windows: Git for Windows' bash (not System32\bash.exe, which is WSL).
fn git_bash() -> Option<std::path::PathBuf> {
    let pf = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from).unwrap_or_else(|| r"C:\Program Files".into());
    [pf.join(r"Git\bin\bash.exe")].into_iter().find(|p| p.is_file())
        .or_else(|| crate::dap_adapters::which("bash").filter(|p| !p.to_string_lossy().to_ascii_lowercase().contains("system32")))
}

/// argv for `cmd` in the shell the job named (None = the default login shell / cmd.exe).
fn named_shell_argv(shell: &str, cmd: &str, pty: bool) -> Result<Vec<String>, String> {
    let ps = |exe: String| {
        let mut v = vec![exe, "-NoLogo".into(), "-NoProfile".into()];
        if !pty {
            v.push("-NonInteractive".into());
        }
        v.extend(["-ExecutionPolicy".into(), "Bypass".into(), "-EncodedCommand".into(), powershell_encoded(cmd)]);
        v
    };
    let found = |bin: &str| crate::dap_adapters::which(bin).map(|p| p.display().to_string());
    match shell {
        "powershell" if cfg!(windows) => {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            let exe = std::path::Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
            Ok(ps(if exe.is_file() { exe.display().to_string() } else { "powershell.exe".into() }))
        }
        "powershell" | "pwsh" => found("pwsh").map(ps).ok_or_else(|| "PowerShell 7(pwsh)이 이 PC에 없습니다".into()),
        "cmd" if cfg!(windows) => Ok(shell_argv(cmd, pty)),
        "cmd" => Err("cmd는 Windows에서만 씁니다".into()),
        "bash" if cfg!(windows) => git_bash().map(|b| vec![b.display().to_string(), "-lc".into(), cmd.into()]).ok_or_else(|| "bash(Git for Windows)가 이 PC에 없습니다".into()),
        "bash" => Ok(vec![found("bash").unwrap_or_else(|| "/bin/bash".into()), "-lc".into(), cmd.into()]),
        "sh" if !cfg!(windows) => Ok(vec!["/bin/sh".into(), "-c".into(), cmd.into()]),
        other => Err(format!("지원하지 않는 shell: {other} (powershell|pwsh|cmd|bash|sh)")),
    }
}

/// The `shell` values that work on this PC (reported in capabilities).
pub fn available_shells() -> Vec<&'static str> {
    let has = |bin: &str| crate::dap_adapters::which(bin).is_some();
    let mut v = Vec::new();
    if cfg!(windows) {
        v.extend(["cmd", "powershell"]);
        if has("pwsh") { v.push("pwsh"); }
        if git_bash().is_some() { v.push("bash"); }
    } else {
        v.push("sh");
        if has("bash") || std::path::Path::new("/bin/bash").exists() { v.push("bash"); }
        if has("pwsh") { v.extend(["powershell", "pwsh"]); }
    }
    v
}

/// Windows: end the process and everything it started (cmd.exe → npm → node …).
#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .no_window().status();
}

impl ExecHub {
    /// A live connection: output and exit notifications go to `out` from now on.
    pub fn attach(&self, out: Out) {
        self.0.lock().unwrap().out = Some(out);
    }

    pub fn detach(&self) {
        self.0.lock().unwrap().out = None;
    }

    pub fn running(&self) -> usize {
        self.0.lock().unwrap().procs.values().filter(|p| p.exit.is_none()).count()
    }

    async fn emit(&self, id: u32, chunk: &[u8]) {
        let out = {
            let mut g = self.0.lock().unwrap();
            let Some(p) = g.procs.get_mut(&id) else { return };
            p.bytes += chunk.len() as u64;
            p.tail.extend(chunk.iter().copied());
            let excess = p.tail.len().saturating_sub(TAIL_BYTES);
            p.tail.drain(..excess);
            g.out.clone()
        };
        if let Some(out) = out {
            let _ = out.send(Message::Binary(frame(id, chunk))).await;
        }
    }

    async fn finish(&self, id: u32, code: Option<i32>, signal: Option<String>) {
        let (out, duration) = {
            let mut g = self.0.lock().unwrap();
            let Some(p) = g.procs.get_mut(&id) else { return };
            let duration = p.started.elapsed().as_millis() as u64;
            p.exit = Some((code, signal.clone()));
            p.duration_ms = Some(duration);
            p.ctl = None;
            g.finished.push_back(id);
            while g.finished.len() > KEEP_FINISHED {
                if let Some(old) = g.finished.pop_front() {
                    g.procs.remove(&old);
                }
            }
            (g.out.clone(), duration)
        };
        if let Some(out) = out {
            let note = json!({ "jsonrpc": "2.0", "method": "exec.exit", "params": { "streamId": id, "code": code, "signal": signal, "durationMs": duration } });
            let _ = out.send(Message::Text(note.to_string())).await;
        }
    }

    fn control(&self, id: u32, ctl: Ctl) -> RpcResult {
        let g = self.0.lock().unwrap();
        let p = g.procs.get(&id).ok_or((-32004, format!("stream {id} 없음")))?;
        let tx = p.ctl.as_ref().ok_or((-32005, format!("stream {id}는 이미 종료됨")))?;
        tx.send(ctl).map_err(|_| (-32005, format!("stream {id}는 이미 종료됨")))?;
        Ok(json!({ "ok": true }))
    }

    /// Ctrl+C / service stop: nothing keeps running unattended after the runner itself is gone.
    pub fn kill_all(&self) {
        let g = self.0.lock().unwrap();
        for p in g.procs.values() {
            if let Some(tx) = &p.ctl {
                let _ = tx.send(Ctl::Signal(Sig::Kill));
            }
        }
    }

    pub fn list(&self) -> Value {
        let g = self.0.lock().unwrap();
        let mut items: Vec<(&u32, &Proc)> = g.procs.iter().collect();
        items.sort_by_key(|(_, p)| p.started_ms);
        Value::Array(items.into_iter().map(|(id, p)| json!({
            "streamId": id, "tag": p.tag, "pid": p.pid, "cmd": p.cmd, "cwd": p.cwd, "pty": p.pty, "startedAt": p.started_ms,
            "running": p.exit.is_none(), "code": p.exit.as_ref().and_then(|e| e.0), "signal": p.exit.as_ref().and_then(|e| e.1.clone()),
            "durationMs": p.duration_ms, "bytes": p.bytes,
        })).collect())
    }

    fn tail(&self, id: u32, max: usize) -> RpcResult {
        let g = self.0.lock().unwrap();
        let p = g.procs.get(&id).ok_or((-32004, format!("stream {id} 없음")))?;
        let skip = p.tail.len().saturating_sub(max);
        let bytes: Vec<u8> = p.tail.iter().skip(skip).copied().collect();
        Ok(json!({ "streamId": id, "b64": base64::engine::general_purpose::STANDARD.encode(bytes), "bytes": p.bytes,
            "running": p.exit.is_none(), "code": p.exit.as_ref().and_then(|e| e.0) }))
    }

    /// JSON-RPC entry point for `exec.*`; None when the method is not an exec method.
    pub async fn rpc(&self, cfg: &Config, method: &str, params: &Value) -> Option<RpcResult> {
        let stream = || params.get("streamId").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "streamId 필요".to_string()));
        Some(match method {
            "exec.start" => self.start(cfg, params).await,
            "exec.list" => Ok(json!({ "streams": self.list() })),
            "exec.tail" => stream().and_then(|id| self.tail(id, params.get("bytes").and_then(Value::as_u64).unwrap_or(TAIL_BYTES as u64).min(TAIL_BYTES as u64) as usize)),
            "exec.write" => stream().and_then(|id| {
                let data = if let Some(s) = params.get("data").and_then(Value::as_str) {
                    s.as_bytes().to_vec()
                } else if let Some(b) = params.get("b64").and_then(Value::as_str) {
                    base64::engine::general_purpose::STANDARD.decode(b).map_err(|_| (-32602, "b64 형식 오류".to_string()))?
                } else {
                    return Err((-32602, "data 또는 b64 필요".into()));
                };
                if data.len() > MAX_WRITE {
                    return Err((-32602, "입력이 너무 큽니다(64KB)".into()));
                }
                self.control(id, Ctl::Write(data))
            }),
            "exec.resize" => stream().and_then(|id| {
                let cols = params.get("cols").and_then(Value::as_u64).unwrap_or(80).clamp(10, 500) as u16;
                let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(24).clamp(4, 300) as u16;
                self.control(id, Ctl::Resize(cols, rows))
            }),
            "exec.signal" => stream().and_then(|id| {
                let name = params.get("signal").and_then(Value::as_str).unwrap_or("INT");
                let sig = sig_of(name).ok_or((-32602, format!("지원하지 않는 신호: {name} (INT|TERM|KILL)")))?;
                self.control(id, Ctl::Signal(sig))
            }),
            _ => return None,
        })
    }

    async fn start(&self, cfg: &Config, params: &Value) -> RpcResult {
        let pty = params.get("pty").and_then(Value::as_bool).unwrap_or(false);
        let argv: Vec<String> = match (params.get("program").and_then(Value::as_str), params.get("cmd").and_then(Value::as_str)) {
            (Some(program), _) => {
                let mut v = vec![program.to_string()];
                if let Some(args) = params.get("args").and_then(Value::as_array) {
                    v.extend(args.iter().map(|a| a.as_str().map(String::from).unwrap_or_else(|| a.to_string())));
                }
                v
            }
            (None, Some(cmd)) if !cmd.trim().is_empty() => match params.get("shell").and_then(Value::as_str).filter(|s| !s.is_empty() && *s != "default") {
                Some(shell) => named_shell_argv(shell, cmd, pty).map_err(|e| (-32602, e))?,
                None => shell_argv(cmd, pty),
            },
            _ => return Err((-32602, "cmd 또는 program 필요".into())),
        };
        let display = params.get("cmd").and_then(Value::as_str).map(String::from).unwrap_or_else(|| argv.join(" "));
        if display.len() > MAX_CMD || argv.iter().any(|a| a.contains('\0')) {
            return Err((-32602, "명령이 너무 길거나 잘못되었습니다".into()));
        }
        let cwd = match params.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(c) => crate::roots::resolve(&cfg.allowed_roots, c).map_err(|e| (-32001, e))?,
            None => {
                let first = cfg.allowed_roots.first().ok_or((-32001, "허용된 폴더(allowed_roots)가 없습니다 — `aidev-runner roots add <폴더>`".to_string()))?;
                crate::roots::resolve(&cfg.allowed_roots, &first.display().to_string()).map_err(|e| (-32001, e))?
            }
        };
        if !cwd.is_dir() {
            let roots = cfg.allowed_roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(", ");
            return Err((-32001, format!("폴더가 없습니다: {} — 허용 폴더: {roots}", cwd.display())));
        }
        let empty = serde_json::Map::new();
        let env = job_env(cfg, params.get("env").and_then(Value::as_object).unwrap_or(&empty), pty).map_err(|e| (-32602, e))?;
        let cols = params.get("cols").and_then(Value::as_u64).unwrap_or(120).clamp(10, 500) as u16;
        let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(32).clamp(4, 300) as u16;
        let timeout = params.get("timeoutSec").and_then(Value::as_u64).filter(|t| *t > 0).map(Duration::from_secs);
        let input = params.get("stdin").and_then(Value::as_str).map(|s| s.as_bytes().to_vec());
        if input.as_ref().is_some_and(|i| i.len() > MAX_STDIN) {
            return Err((-32602, format!("stdin은 {} KB까지입니다", MAX_STDIN / 1024)));
        }
        if input.is_some() && pty {
            return Err((-32602, "stdin은 pty 없이 실행할 때만 씁니다".into()));
        }

        let id = {
            let mut g = self.0.lock().unwrap();
            if g.procs.values().filter(|p| p.exit.is_none()).count() >= MAX_RUNNING {
                return Err((-32006, format!("동시에 실행할 수 있는 명령은 {MAX_RUNNING}개까지입니다")));
            }
            let id = match params.get("streamId").and_then(Value::as_u64) {
                Some(v) if v > 0 && v <= u32::MAX as u64 => v as u32,
                Some(_) => return Err((-32602, "streamId 범위 오류".into())),
                None => {
                    g.next = g.next.wrapping_add(1).max(1);
                    g.next
                }
            };
            if g.procs.contains_key(&id) {
                return Err((-32602, format!("stream {id}가 이미 있습니다")));
            }
            id
        };

        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>(64);
        let (exit_tx, exit_rx) = oneshot::channel::<(Option<i32>, Option<String>)>();
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel::<Ctl>();
        let pid = if pty {
            spawn_pty(&argv, &cwd, &env, cols, rows, chunk_tx, exit_tx, ctl_rx).map_err(|e| (-32007, e))?
        } else {
            spawn_piped(&argv, &cwd, &env, input, chunk_tx, exit_tx, ctl_rx).map_err(|e| (-32007, e))?
        };
        let tag = params.get("tag").and_then(Value::as_str).map(|t| t.chars().take(64).collect());
        self.0.lock().unwrap().procs.insert(id, Proc {
            tag, pid, cmd: display, cwd: cwd.display().to_string(), pty, started_ms: now_ms(), started: Instant::now(),
            exit: None, duration_ms: None, tail: VecDeque::new(), bytes: 0, ctl: Some(ctl_tx.clone()),
        });
        let hub = self.clone();
        tokio::spawn(async move { hub.pump(id, chunk_rx, exit_rx, ctl_tx, timeout).await });
        Ok(json!({ "streamId": id, "pid": pid, "cwd": cwd.display().to_string() }))
    }

    /// Forwards output until the process has exited and its output is drained (≤1 s after exit:
    /// a background grandchild may keep the pipe open forever).
    async fn pump(&self, id: u32, mut chunks: mpsc::Receiver<Vec<u8>>, mut exit_rx: oneshot::Receiver<(Option<i32>, Option<String>)>, ctl: mpsc::UnboundedSender<Ctl>, timeout: Option<Duration>) {
        let deadline = timeout.map(|t| tokio::time::Instant::now() + t);
        let mut exit: Option<(Option<i32>, Option<String>)> = None;
        let mut open = true;
        let mut timed_out = false;
        loop {
            if exit.is_some() {
                // drain what is left, briefly
                let until = tokio::time::Instant::now() + Duration::from_secs(1);
                while open {
                    match tokio::time::timeout_at(until, chunks.recv()).await {
                        Ok(Some(c)) => self.emit(id, &c).await,
                        _ => open = false,
                    }
                }
                break;
            }
            tokio::select! {
                c = chunks.recv(), if open => match c {
                    Some(c) => self.emit(id, &c).await,
                    None => open = false,
                },
                e = &mut exit_rx => { exit = Some(e.unwrap_or((None, Some("lost".into())))); }
                _ = async { match deadline { Some(d) => tokio::time::sleep_until(d).await, None => std::future::pending().await } }, if !timed_out => {
                    timed_out = true;
                    let msg = format!("\r\n[aidev-runner] 제한 시간 {}초 초과 — 종료합니다\r\n", timeout.map(|t| t.as_secs()).unwrap_or(0));
                    self.emit(id, msg.as_bytes()).await;
                    let _ = ctl.send(Ctl::Signal(Sig::Kill));
                }
            }
        }
        let (code, signal) = exit.unwrap_or((None, None));
        self.finish(id, code, if timed_out { Some("timeout".into()) } else { signal }).await;
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_pty(
    argv: &[String], cwd: &std::path::Path, env: &[(String, String)], cols: u16, rows: u16,
    chunk_tx: mpsc::Sender<Vec<u8>>, exit_tx: oneshot::Sender<(Option<i32>, Option<String>)>, mut ctl_rx: mpsc::UnboundedReceiver<Ctl>,
) -> Result<Option<u32>, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("pty: {e}"))?;
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.cwd(cwd);
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("{}: {e}", argv[0]))?;
    drop(pair.slave); // EOF on the master once the child (and its children) close the terminal
    let pid = child.process_id();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;
    let mut killer = child.clone_killer();

    std::thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if chunk_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = exit_tx.send(match status {
            Ok(s) => (if s.signal().is_some() { None } else { Some(s.exit_code() as i32) }, s.signal().map(signal_name)),
            Err(e) => (None, Some(e.to_string())),
        });
    });
    std::thread::spawn(move || {
        while let Some(ctl) = ctl_rx.blocking_recv() {
            match ctl {
                Ctl::Write(data) => {
                    let _ = std::io::Write::write_all(&mut writer, &data);
                    let _ = std::io::Write::flush(&mut writer);
                }
                Ctl::Resize(cols, rows) => {
                    let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
                Ctl::Signal(sig) => {
                    #[cfg(unix)]
                    if let Some(pid) = pid {
                        signal_group(pid, sig);
                        continue;
                    }
                    if sig == Sig::Int {
                        let _ = std::io::Write::write_all(&mut writer, b"\x03");
                        let _ = std::io::Write::flush(&mut writer);
                    } else {
                        #[cfg(windows)]
                        if let Some(pid) = pid { kill_tree(pid); }
                        let _ = killer.kill();
                    }
                }
            }
        }
    });
    Ok(pid)
}

fn spawn_piped(
    argv: &[String], cwd: &std::path::Path, env: &[(String, String)], input: Option<Vec<u8>>,
    chunk_tx: mpsc::Sender<Vec<u8>>, exit_tx: oneshot::Sender<(Option<i32>, Option<String>)>, mut ctl_rx: mpsc::UnboundedReceiver<Ctl>,
) -> Result<Option<u32>, String> {
    use std::process::Stdio;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.no_window();
    #[cfg(windows)]
    {
        // cmd.exe /s /c "<line>": hand the line over untouched (Rust's quoting would mangle it)
        if argv.len() == 5 && argv[3] == "/c" {
            cmd.args(&argv[1..4]);
            cmd.raw_arg(format!("\"{}\"", argv[4]));
        } else {
            cmd.args(&argv[1..]);
        }
    }
    #[cfg(not(windows))]
    cmd.args(&argv[1..]);
    cmd.current_dir(cwd).env_clear().envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    // stdin is closed (after `input`, when given): a command that asks for input gets EOF instead of waiting forever
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", argv[0]))?;
    let pid = child.id();
    let mut stdin: Option<tokio::process::ChildStdin> = None;
    if let (Some(data), Some(mut w)) = (input, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = w.write_all(&data).await;
            let _ = w.shutdown().await;
        });
    }
    for pipe in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
        let tx = chunk_tx.clone();
        let mut pipe = pipe;
        tokio::spawn(async move {
            let mut buf = vec![0u8; CHUNK];
            loop {
                match pipe.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    drop(chunk_tx);
    tokio::spawn(async move {
        let status = loop {
            tokio::select! {
                s = child.wait() => break s,
                ctl = ctl_rx.recv() => match ctl {
                    Some(Ctl::Write(data)) => {
                        if let Some(w) = stdin.as_mut() {
                            if w.write_all(&data).await.is_err() || w.flush().await.is_err() { stdin = None; }
                        }
                    }
                    Some(Ctl::Resize(..)) => {}
                    Some(Ctl::Signal(sig)) => {
                        #[cfg(unix)]
                        if let Some(pid) = pid { signal_group(pid, sig); continue; }
                        let _ = sig;
                        #[cfg(windows)]
                        if let Some(pid) = pid { kill_tree(pid); }
                        let _ = child.start_kill();
                    }
                    None => { let s = child.wait().await; break s; }
                },
            }
        };
        let _ = exit_tx.send(match status {
            Ok(s) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    (s.code(), s.signal().map(|n| format!("SIG{}", signame(n))))
                }
                #[cfg(not(unix))]
                {
                    (s.code(), None)
                }
            }
            Err(e) => (None, Some(e.to_string())),
        });
    });
    Ok(pid)
}

/// portable-pty reports strsignal() text ("Interrupt"; macOS adds the number: "Terminated: 15"); pipes report
/// numbers — all become SIGINT etc.
fn signal_name(text: &str) -> String {
    match text.split(':').next().unwrap_or(text).trim().to_ascii_lowercase().as_str() {
        "interrupt" => "SIGINT".into(),
        "terminated" => "SIGTERM".into(),
        "killed" => "SIGKILL".into(),
        "hangup" => "SIGHUP".into(),
        "segmentation fault" => "SIGSEGV".into(),
        "aborted" => "SIGABRT".into(),
        "broken pipe" => "SIGPIPE".into(),
        other => other.chars().take(40).collect(),
    }
}

#[cfg(unix)]
fn signame(n: i32) -> String {
    match n {
        libc::SIGINT => "INT".into(),
        libc::SIGTERM => "TERM".into(),
        libc::SIGKILL => "KILL".into(),
        libc::SIGHUP => "HUP".into(),
        libc::SIGSEGV => "SEGV".into(),
        libc::SIGABRT => "ABRT".into(),
        libc::SIGPIPE => "PIPE".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(dir: &std::path::Path) -> Config {
        Config { allowed_roots: vec![dir.to_path_buf()], ..Default::default() }
    }

    async fn collect(rx: &mut mpsc::Receiver<Message>, id: u32) -> (String, Value) {
        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("timeout").expect("closed") {
                Message::Binary(b) => {
                    assert_eq!(u32::from_be_bytes([b[0], b[1], b[2], b[3]]), id);
                    out.extend_from_slice(&b[4..]);
                }
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["method"] == "exec.exit" && v["params"]["streamId"] == id {
                        return (String::from_utf8_lossy(&out).into_owned(), v["params"].clone());
                    }
                }
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn piped_output_exit_code_and_env() {
        let dir = tempdir();
        let hub = ExecHub::default();
        let (tx, mut rx) = mpsc::channel(256);
        hub.attach(tx);
        std::env::set_var("AIDEV_SECRET_TEST", "leak");
        let r = hub.rpc(&cfg(&dir), "exec.start", &json!({ "cmd": "echo hi-$FOO; echo err 1>&2; pwd; echo \"[$AIDEV_SECRET_TEST]\"; exit 7", "env": { "FOO": "bar" }, "streamId": 5, "tag": "rr:42" })).await.unwrap().unwrap();
        assert_eq!(r["streamId"], 5);
        let (out, exit) = collect(&mut rx, 5).await;
        assert!(out.contains("hi-bar"), "{out}");
        assert!(out.contains("err"));
        assert!(out.contains(&std::fs::canonicalize(&dir).unwrap().display().to_string()));
        assert!(out.contains("[]"), "runner env must not leak: {out}");
        assert_eq!(exit["code"], 7);
        let list = hub.list();
        assert_eq!(list[0]["running"], false);
        assert_eq!(list[0]["tag"], "rr:42");
        let tail = hub.rpc(&cfg(&dir), "exec.tail", &json!({ "streamId": 5 })).await.unwrap().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(tail["b64"].as_str().unwrap()).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("hi-bar"));
    }

    #[tokio::test]
    async fn stdin_text_then_eof() {
        let dir = tempdir();
        let hub = ExecHub::default();
        let (tx, mut rx) = mpsc::channel(256);
        hub.attach(tx);
        let c = cfg(&dir);
        // a prompt with quotes, $vars and newlines arrives untouched, and the command sees EOF after it
        let prompt = "fix 'it' \"now\" $HOME `x`\nline 2\n";
        hub.rpc(&c, "exec.start", &json!({ "cmd": "cat; echo '[eof]'", "stdin": prompt, "streamId": 11 })).await.unwrap().unwrap();
        let (out, exit) = collect(&mut rx, 11).await;
        assert!(out.contains(prompt), "{out}");
        assert!(out.contains("[eof]"), "{out}");
        assert_eq!(exit["code"], 0);
        let e = hub.rpc(&c, "exec.start", &json!({ "cmd": "cat", "stdin": "x", "pty": true, "streamId": 12 })).await.unwrap().unwrap_err();
        assert_eq!(e.0, -32602);
    }

    #[tokio::test]
    async fn pty_input_resize_and_signal() {
        let dir = tempdir();
        let hub = ExecHub::default();
        let (tx, mut rx) = mpsc::channel(256);
        hub.attach(tx);
        let c = cfg(&dir);
        hub.rpc(&c, "exec.start", &json!({ "program": "/bin/sh", "args": ["-c", "read line; echo got:$line; stty size; test -t 1 && echo tty; sleep 30"], "pty": true, "cols": 100, "rows": 30, "streamId": 9 })).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        hub.rpc(&c, "exec.write", &json!({ "streamId": 9, "data": "hello\n" })).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        hub.rpc(&c, "exec.signal", &json!({ "streamId": 9, "signal": "TERM" })).await.unwrap().unwrap();
        let (out, exit) = collect(&mut rx, 9).await;
        assert!(out.contains("got:hello"), "{out}");
        assert!(out.contains("30 100"), "{out}");
        assert!(out.contains("tty"), "{out}");
        assert!(exit["code"].is_null() || exit["code"] != 0, "{exit}");
        assert!(exit["signal"].is_null() || exit["signal"] == "SIGTERM", "{exit}");
        assert_eq!(hub.running(), 0);
    }

    #[tokio::test]
    async fn refuses_outside_roots_duplicates_and_timeouts() {
        let dir = tempdir();
        let hub = ExecHub::default();
        let (tx, mut rx) = mpsc::channel(256);
        hub.attach(tx);
        let c = cfg(&dir);
        let e = hub.rpc(&c, "exec.start", &json!({ "cmd": "ls", "cwd": "/etc" })).await.unwrap().unwrap_err();
        assert_eq!(e.0, -32001);
        let e = hub.rpc(&c, "exec.start", &json!({ "cmd": "ls", "env": { "BAD-NAME": "x" } })).await.unwrap().unwrap_err();
        assert_eq!(e.0, -32602);
        hub.rpc(&c, "exec.start", &json!({ "cmd": "sleep 5", "streamId": 11, "timeoutSec": 1 })).await.unwrap().unwrap();
        let e = hub.rpc(&c, "exec.start", &json!({ "cmd": "true", "streamId": 11 })).await.unwrap().unwrap_err();
        assert_eq!(e.0, -32602);
        let started = Instant::now();
        let (out, exit) = collect(&mut rx, 11).await;
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(out.contains("제한 시간"));
        assert_eq!(exit["signal"], "timeout");
        let e = hub.rpc(&c, "exec.write", &json!({ "streamId": 11, "data": "x" })).await.unwrap().unwrap_err();
        assert_eq!(e.0, -32005);
        assert!(hub.rpc(&c, "fs.list", &json!({})).await.is_none());
    }

    #[tokio::test]
    async fn keeps_running_while_detached() {
        let dir = tempdir();
        let hub = ExecHub::default();
        let c = cfg(&dir);
        hub.rpc(&c, "exec.start", &json!({ "cmd": "echo offline-output", "streamId": 3 })).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        let list = hub.list();
        assert_eq!(list[0]["running"], false);
        assert_eq!(list[0]["code"], 0);
        let tail = hub.rpc(&c, "exec.tail", &json!({ "streamId": 3 })).await.unwrap().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(tail["b64"].as_str().unwrap()).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("offline-output"));
    }

    fn tempdir() -> std::path::PathBuf {
        use rand::Rng;
        let d = std::env::temp_dir().join(format!("aidev-exec-{}", rand::thread_rng().gen::<u64>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    async fn run(hub: &ExecHub, rx: &mut mpsc::Receiver<Message>, c: &Config, id: u32, p: Value) -> (String, Value) {
        let mut p = p;
        p["streamId"] = json!(id);
        hub.rpc(c, "exec.start", &p).await.unwrap().unwrap();
        collect(rx, id).await
    }

    #[test]
    fn powershell_command_travels_encoded() {
        let b = base64::engine::general_purpose::STANDARD.decode(powershell_encoded("Write-Output \"a'b\" | % { $_ }")).unwrap();
        let units: Vec<u16> = b.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let script = String::from_utf16(&units).unwrap();
        assert!(script.contains("\nWrite-Output \"a'b\" | % { $_ }\nif (-not $?)"), "{script}");
    }

    #[test]
    fn sdk_dirs_join_the_path_once() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let mut env = vec![("PATH".to_string(), format!("/usr/bin{sep}/bin"))];
        let sdk = std::path::PathBuf::from("/opt/sdk/platform-tools");
        add_to_path(&mut env, &[sdk.clone(), std::path::PathBuf::from("/bin")]);
        add_to_path(&mut env, &[sdk]);
        assert_eq!(env, vec![("PATH".to_string(), format!("/usr/bin{sep}/bin{sep}/opt/sdk/platform-tools"))]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn named_shells() {
        let dir = tempdir();
        let hub = ExecHub::default();
        let (tx, mut rx) = mpsc::channel(256);
        hub.attach(tx);
        let c = cfg(&dir);
        let (out, exit) = run(&hub, &mut rx, &c, 31, json!({ "cmd": "echo $((2+3)); exit 4", "shell": "bash" })).await;
        assert!(out.contains('5'), "{out}");
        assert_eq!(exit["code"], 4);
        let (out, _) = run(&hub, &mut rx, &c, 32, json!({ "cmd": "echo sh-ok", "shell": "sh" })).await;
        assert!(out.contains("sh-ok"));
        assert_eq!(hub.rpc(&c, "exec.start", &json!({ "cmd": "dir", "shell": "cmd" })).await.unwrap().unwrap_err().0, -32602);
        assert_eq!(hub.rpc(&c, "exec.start", &json!({ "cmd": "x", "shell": "fish" })).await.unwrap().unwrap_err().0, -32602);
        if crate::dap_adapters::which("pwsh").is_none() {
            eprintln!("SKIP pwsh: not installed");
            return;
        }
        // UTF-8, quotes and pipes untouched; native exit code; a failing cmdlet → 1; success → 0
        let (out, exit) = run(&hub, &mut rx, &c, 33, json!({ "cmd": "$x = 'a\"b' ; Write-Output \"한글 $x\" | ForEach-Object { $_ }; sh -c 'exit 3'", "shell": "powershell" })).await;
        assert!(out.contains("한글 a\"b"), "{out}");
        assert_eq!(exit["code"], 3);
        let (_, exit) = run(&hub, &mut rx, &c, 34, json!({ "cmd": "Get-Item /no/such/file", "shell": "pwsh" })).await;
        assert_eq!(exit["code"], 1);
        let (out, exit) = run(&hub, &mut rx, &c, 35, json!({ "cmd": "sh -c 'exit 2'; Write-Output fine", "shell": "pwsh" })).await;
        assert!(out.contains("fine"));
        assert_eq!(exit["code"], 0, "like a shell: the last statement succeeded");
        let (_, exit) = run(&hub, &mut rx, &c, 36, json!({ "cmd": "throw 'boom'", "shell": "pwsh" })).await;
        assert_eq!(exit["code"], 1);
    }
}

/// Windows-only checks (CI: `cargo test win_` on windows-2022).
#[cfg(all(test, windows))]
mod win_tests {
    use super::*;

    fn setup() -> (std::path::PathBuf, ExecHub, mpsc::Receiver<Message>, Config) {
        use rand::Rng;
        let d = std::env::temp_dir().join(format!("aidev-exec-win-{}", rand::thread_rng().gen::<u64>()));
        std::fs::create_dir_all(&d).unwrap();
        let hub = ExecHub::default();
        let (tx, rx) = mpsc::channel(256);
        hub.attach(tx);
        let c = Config { allowed_roots: vec![d.clone()], ..Default::default() };
        (d, hub, rx, c)
    }

    async fn run(hub: &ExecHub, rx: &mut mpsc::Receiver<Message>, c: &Config, id: u32, mut p: Value) -> (String, Value) {
        p["streamId"] = json!(id);
        hub.rpc(c, "exec.start", &p).await.unwrap().unwrap();
        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(60), rx.recv()).await.expect("timeout").expect("closed") {
                Message::Binary(b) if u32::from_be_bytes([b[0], b[1], b[2], b[3]]) == id => out.extend_from_slice(&b[4..]),
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["method"] == "exec.exit" && v["params"]["streamId"] == id {
                        return (String::from_utf8_lossy(&out).into_owned(), v["params"].clone());
                    }
                }
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn win_cmd_output_is_utf8() {
        let (_d, hub, mut rx, c) = setup();
        let (out, exit) = run(&hub, &mut rx, &c, 1, json!({ "cmd": "echo 한글 ok& exit /b 6" })).await;
        assert!(out.contains("한글 ok"), "{out:?}");
        assert_eq!(exit["code"], 6);
        let (out, _) = run(&hub, &mut rx, &c, 2, json!({ "cmd": "dir /b", "shell": "cmd" })).await;
        assert!(!out.contains('\u{fffd}'), "{out:?}");
    }

    #[tokio::test]
    async fn win_powershell_exit_codes_and_utf8() {
        let (_d, hub, mut rx, c) = setup();
        let (out, exit) = run(&hub, &mut rx, &c, 3, json!({ "cmd": "$x = 'a\"b'; Write-Output \"한글 $x\" | ForEach-Object { $_ }; cmd /c exit 4", "shell": "powershell" })).await;
        assert!(out.contains("한글 a\"b"), "{out:?}");
        assert_eq!(exit["code"], 4);
        let (_, exit) = run(&hub, &mut rx, &c, 4, json!({ "cmd": "Get-Item C:\\no\\such\\file", "shell": "powershell" })).await;
        assert_eq!(exit["code"], 1);
        let (out, exit) = run(&hub, &mut rx, &c, 5, json!({ "cmd": "(Get-CimInstance Win32_OperatingSystem).Caption; Get-Service | Select-Object -First 1 | Out-Null; 'cim-ok'", "shell": "powershell" })).await;
        assert!(out.contains("cim-ok") && out.contains("Windows"), "{out:?}");
        assert_eq!(exit["code"], 0);
    }

    #[tokio::test]
    async fn win_stop_ends_the_process_tree() {
        let (d, hub, mut rx, c) = setup();
        // cmd.exe → powershell (grandchild) that records its pid and sleeps
        let p = json!({ "cmd": "powershell -NoProfile -Command \"$PID | Out-File -Encoding ascii child.pid; Start-Sleep 120\"", "streamId": 7 });
        hub.rpc(&c, "exec.start", &p).await.unwrap().unwrap();
        let pidfile = d.join("child.pid");
        for _ in 0..200 {
            if std::fs::read_to_string(&pidfile).map(|s| !s.trim().is_empty()).unwrap_or(false) { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let child: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        hub.rpc(&c, "exec.signal", &json!({ "streamId": 7, "signal": "TERM" })).await.unwrap().unwrap();
        loop {
            if let Message::Text(t) = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await.unwrap().unwrap() {
                if t.contains("exec.exit") { break; }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let list = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {child}"), "/NH"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&list.stdout).contains(&child.to_string()), "grandchild {child} still running");
    }

    #[tokio::test]
    async fn win_git_bash() {
        if git_bash().is_none() {
            eprintln!("SKIP: no Git Bash");
            return;
        }
        let (_d, hub, mut rx, c) = setup();
        let (out, exit) = run(&hub, &mut rx, &c, 8, json!({ "cmd": "echo $((2+3)); exit 3", "shell": "bash" })).await;
        assert!(out.contains('5'), "{out:?}");
        assert_eq!(exit["code"], 3);
        assert!(available_shells().contains(&"bash"));
    }
}
