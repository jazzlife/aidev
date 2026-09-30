//! The debug adapters the runner can start (F-09 / F-09b) and how each one gets onto this PC.
//! Every adapter speaks DAP; `Launch::stdio` says whether it serves a TCP port itself or talks over
//! stdin/stdout (then dap.rs puts a one-client TCP port in front of it). Provisioning, in order of
//! preference: already on the user's PATH / toolchain → fetched once at a pinned version with a pinned
//! SHA-256 into <runner home>/adapters/ → installed privately with the language's own package tool.
//! Nothing is installed system-wide. AIDEV_ADAPTER_MIRROR=<dir> takes every download from a folder.
//!
//!   js-debug    Node.js / TypeScript / browsers          download (GitHub)      needs node
//!   debugpy     Python                                   pip --target           needs python3
//!   codelldb    C, C++, Rust, Swift, Zig, ObjC (LLDB)    download (GitHub)
//!   gdb         C, C++, Rust, Go, Fortran, Ada; MCUs via arm-none-eabi-gdb / gdb-multiarch + a GDB server
//!                                                        toolchain (GDB ≥ 14 has DAP built in)
//!   lldb-dap    Apple toolchain LLDB (iOS simulator/device, macOS apps) or LLVM's
//!                                                        toolchain (Xcode 16: xcrun lldb-dap)
//!   netcoredbg  .NET 6+ (C#, F#, VB): console, ASP.NET, WPF/WinForms on .NET, Avalonia, MAUI desktop
//!                                                        download (Samsung)
//!   delve       Go                                       PATH, or `go install` into the adapters folder
//!   jvm         Java, Kotlin, Scala, Groovy … on the JVM; Android apps over JDWP (adb forward)
//!                                                        built in (aidev-jdi, assets/aidev-jdi), needs a JDK ≥ 11
//!   dart        Dart / Flutter (all Flutter targets)     toolchain (dart|flutter debug_adapter)
//!   probe-rs    microcontrollers (ARM Cortex-M/A, RISC-V, Xtensa) through a debug probe
//!                                                        download (probe-rs)
//!   mono        Mono runtimes (Unity editor/players, Xamarin, Mono apps) — soft debugger
//!                                                        download (vscode-mono-debug), needs mono
//!   clrdbg      .NET Framework 1.x–4.8 on Windows (WPF, WinForms, services) — platform build
//!                                                        download from the platform gateway
//!   custom      any other DAP server: `command` + `args` (`{port}` for a TCP one)

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_DOWNLOAD: u64 = 160 * 1024 * 1024;

pub const JS_DEBUG_VERSION: &str = "1.112.0";
const JS_DEBUG_SHA256: &str = "31eb1bd9792f62c32f7c22b66ce612e2e54a7664201a2d80bdb49cc4bf4ca925";
pub const DEBUGPY_VERSION: &str = "1.8.22";
pub const CODELLDB_VERSION: &str = "1.12.3";
const CODELLDB_ASSETS: &[(&str, &str)] = &[
    ("darwin-arm64", "2f114a990e1b368dd1dbd33c80c0e719767af2d228391ec0df0571c957f9ac91"),
    ("darwin-x64", "e25cc716b94c62c07fec268ff2785d2b797245b160502baef8b9c970a0c4d8e8"),
    ("linux-x64", "1cd7f386598022b51a5b93b9ffa23e812b23f519cfe1833384ec4bef4bfd1be1"),
    ("linux-arm64", "0887f67d440554617894266f80706b700907c36b95e6e49d23b95a0e05318101"),
    ("win32-x64", "a916e509308dac817732f63ca604a8b93ed29cd16f38a2fa9f0b64ed58e8f51a"),
];
pub const NETCOREDBG_VERSION: &str = "3.1.3-1062";
/// netcoredbg release asset per platform (no macOS arm64 build upstream: see netcoredbg_osx_arm64 below).
const NETCOREDBG_ASSETS: &[(&str, &str, &str)] = &[
    ("linux-x64", "netcoredbg-linux-amd64.tar.gz", "3814341c028c81ff7eea03ac316ad92e9ad7d705d2a00e3e3df269cdc241c763"),
    ("linux-arm64", "netcoredbg-linux-arm64.tar.gz", "fc9efb691a53932a7fac4b9f67af68ad0c2a4cbe59cb2c1a3c44c64959df2ba4"),
    ("darwin-x64", "netcoredbg-osx-amd64.tar.gz", "49459b066836b6a452f418501d7ecab57bcd7e60d8464faac21ff70b496b8634"),
    ("win32-x64", "netcoredbg-win64.zip", "c67ae052e0bcb9ce37000f261e2d397a0d5b6615cafe30c868239a78598dfb37"),
];
/// The JVM adapter ships inside the runner (JDI only, no downloads): assets/aidev-jdi/build.sh.
pub const AIDEV_JDI_VERSION: &str = "1.0.0";
const AIDEV_JDI_JAR: &[u8] = include_bytes!("../assets/aidev-jdi/aidev-jdi.jar");
pub const PROBE_RS_VERSION: &str = "0.32.0";
const PROBE_RS_ASSETS: &[(&str, &str, &str)] = &[
    ("linux-x64", "probe-rs-tools-x86_64-unknown-linux-gnu.tar.xz", "c2ccc46049e52a5d403ef212078cd637ecda55b662708327960558f83e851ff5"),
    ("linux-arm64", "probe-rs-tools-aarch64-unknown-linux-gnu.tar.xz", "7c818cfd77808e806bf8f4d108c9137910b4fb28e0fe5c464d39782dbbc8af31"),
    ("darwin-x64", "probe-rs-tools-x86_64-apple-darwin.tar.xz", "e23d117a29909a389c92234ac3ebafcc5ec24d8969d1ec5d70eece622827f778"),
    ("darwin-arm64", "probe-rs-tools-aarch64-apple-darwin.tar.xz", "c39631679b83d0c94dc442d05cc4ca974a87c02907a6ddbfce46746ed503152c"),
    ("win32-x64", "probe-rs-tools-x86_64-pc-windows-msvc.zip", "56fc0564cc23d604b27dc2d57606194159c49f951999f3e47bd2cbffcba64103"),
];
pub const MONO_DEBUG_VERSION: &str = "0.16.3";
const MONO_DEBUG_SHA256: &str = "a9a6b460583f81f96077bdec636671058ca89fd4b4b07fec3c77a2bcf60deace";

pub const ADAPTERS: &[&str] = &["js-debug", "debugpy", "codelldb", "gdb", "lldb-dap", "netcoredbg", "delve", "jvm", "dart", "flutter", "probe-rs", "mono", "clrdbg", "custom"];

/// How to start an adapter: program + arguments (`{port}` already filled in), extra environment,
/// the version to report, and whether it talks DAP over stdio (true) or serves the port itself.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub version: String,
    pub stdio: bool,
}

/// What the gateway may pass besides the adapter name (all optional).
#[derive(Debug, Default, Clone)]
pub struct Options {
    /// gdb: which gdb (gdb, gdb-multiarch, arm-none-eabi-gdb …, or an absolute path)
    pub debugger: Option<String>,
    /// custom: the DAP server command and its arguments; `transport` "tcp" (with `{port}`) or "stdio"
    pub command: Option<String>,
    pub command_args: Vec<String>,
    pub transport: Option<String>,
    /// base URL of the platform gateway (clrdbg and other platform-built adapters are fetched from it)
    pub gateway: Option<String>,
}

impl Options {
    pub fn from_params(p: &Value, gateway: Option<String>) -> Self {
        let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_string).filter(|v| !v.is_empty());
        Options {
            debugger: s("debugger"),
            command: s("command"),
            command_args: p.get("commandArgs").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            transport: s("transport"),
            gateway,
        }
    }
}

pub fn adapters_dir() -> PathBuf {
    crate::config::dir().join("adapters")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `bin` on the user's PATH (the login shell's, as jobs see it).
pub fn which(bin: &str) -> Option<PathBuf> {
    let path = crate::exec::user_path().or_else(|| std::env::var("PATH").ok())?;
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
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

/// This PC as release assets name it.
pub fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        _ => None,
    }
}

fn unsupported(what: &str) -> String {
    format!("{what}는 이 플랫폼({}-{})용 배포본이 없습니다", std::env::consts::OS, std::env::consts::ARCH)
}

/// Fetches `url` (or `<AIDEV_ADAPTER_MIRROR>/<name>`) to `dest` and checks its SHA-256.
pub fn fetch(url: &str, name: &str, sha256: &str, dest: &Path) -> Result<(), String> {
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
pub fn provision(dir: &Path, build: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
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

#[cfg(unix)]
fn set_mode(path: &Path, exec: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 })).map_err(|e| e.to_string())
}

/// Unpacks a .tar.gz / .tar.xz / .zip into `dest` (entries that would leave `dest` are refused);
/// `keep` filters zip entries by path prefix.
pub fn unpack(archive: &Path, dest: &Path, keep: Option<&str>) -> Result<(), String> {
    let name = archive.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    if name.ends_with(".zip") || name.ends_with(".vsix") {
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{name}: {e}"))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = f.enclosed_name() else { continue };
            if f.is_dir() || keep.is_some_and(|k| !rel.starts_with(k)) {
                continue;
            }
            let out = dest.join(&rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut w = std::fs::File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
            std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            set_mode(&out, f.unix_mode().map(|m| m & 0o111 != 0).unwrap_or(false))?;
        }
        return Ok(());
    }
    let reader: Box<dyn std::io::Read> = if name.ends_with(".tar.xz") {
        let mut out = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::BufReader::new(file), &mut out).map_err(|e| format!("{name}: {e}"))?;
        Box::new(std::io::Cursor::new(out))
    } else {
        Box::new(flate2::read::GzDecoder::new(file))
    };
    let mut tar = tar::Archive::new(reader);
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        entry.unpack_in(dest).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(())
}

/// Download + verify + unpack into <adapters>/<id> once; returns that folder.
fn download_unpacked(id: &str, url: &str, file: &str, sha: &str, keep: Option<&str>) -> Result<PathBuf, String> {
    let dir = adapters_dir().join(id);
    provision(&dir, |tmp| {
        let archive = tmp.join(file);
        fetch(url, file, sha, &archive)?;
        unpack(&archive, tmp, keep)?;
        std::fs::remove_file(&archive).map_err(|e| e.to_string())
    })?;
    Ok(dir)
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

fn existing(p: PathBuf) -> Result<PathBuf, String> {
    if p.is_file() { Ok(p) } else { Err(format!("{}이(가) 없습니다", p.display())) }
}

/// A `java` that can run aidev-jdi: JDK 11+ with the jdk.jdi module ($JAVA_HOME first, then PATH).
fn java_for_jdi() -> Result<PathBuf, String> {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    let java = std::env::var_os("JAVA_HOME").map(|h| Path::new(&h).join("bin").join(exe)).filter(|p| p.is_file()).or_else(|| which("java"))
        .ok_or("JVM 디버깅에는 이 PC에 JDK 11 이상(java)이 있어야 합니다")?;
    let out = std::process::Command::new(&java).arg("--list-modules").stdin(std::process::Stdio::null()).output().map_err(|e| format!("{}: {e}", java.display()))?;
    let modules = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        return Err(format!("{}는 JDK 11 이상이 아닙니다 (JDK 8 프로그램도 JDK 11+로 디버깅할 수 있으니 JDK 11+를 설치하거나 JAVA_HOME을 지정하세요)", java.display()));
    }
    if !modules.lines().any(|l| l.starts_with("jdk.jdi")) {
        return Err(format!("{}는 JRE입니다 — 디버거 모듈(jdk.jdi)이 있는 JDK가 필요합니다", java.display()));
    }
    Ok(java)
}

/// aidev-jdi.jar written from the runner binary into the adapters folder (once per version and content).
fn ensure_jdi() -> Result<PathBuf, String> {
    let sha = crate::sync::sha256_bytes(AIDEV_JDI_JAR);
    let dir = adapters_dir().join(format!("aidev-jdi-{AIDEV_JDI_VERSION}-{}", &sha[..12]));
    provision(&dir, |tmp| std::fs::write(tmp.join("aidev-jdi.jar"), AIDEV_JDI_JAR).map_err(|e| e.to_string()))?;
    existing(dir.join("aidev-jdi.jar"))
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

/// `<tool> --version` output's first line (for the version checks and the report).
fn version_line(program: &Path, arg: &str) -> Option<String> {
    let out = std::process::Command::new(program).arg(arg).stdin(std::process::Stdio::null()).output().ok()?;
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    String::from_utf8_lossy(&text).lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(120).collect())
}

/// GDB's own DAP needs GDB 14+ built with Python.
pub fn gdb_major(line: &str) -> Option<u32> {
    // "GNU gdb (Ubuntu 15.1-1ubuntu1~24.04.1) 15.1" / "GNU gdb (Arm GNU Toolchain 13.3.Rel1 …) 14.2.90.20240526-git"
    line.rsplit(' ').next()?.split('.').next()?.parse().ok()
}

fn resolve_gdb(requested: Option<&str>) -> Result<PathBuf, String> {
    let name = requested.unwrap_or("gdb");
    let path = if Path::new(name).is_absolute() {
        PathBuf::from(name)
    } else {
        // only gdb binaries by name (gdb, gdb-multiarch, arm-none-eabi-gdb, riscv64-unknown-elf-gdb …)
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.+".contains(c)) || !name.contains("gdb") {
            return Err(format!("gdb 이름이 올바르지 않습니다: {name}"));
        }
        which(name).ok_or_else(|| format!("{name}을(를) 찾지 못했습니다 — 이 PC에 GDB 14 이상을 설치하세요 (Linux: apt install gdb, MCU: Arm GNU Toolchain의 arm-none-eabi-gdb)"))?
    };
    let line = version_line(&path, "--version").unwrap_or_default();
    match gdb_major(&line) {
        Some(v) if v >= 14 => Ok(path),
        _ => Err(format!("{}: GDB 14 이상이 필요합니다(DAP 내장) — 지금 버전: {}", path.display(), if line.is_empty() { "?" } else { &line })),
    }
}

/// Xcode's lldb-dap (Xcode 16+), else LLVM's lldb-dap / lldb-vscode on PATH.
fn resolve_lldb_dap() -> Result<PathBuf, String> {
    if cfg!(target_os = "macos") {
        if let Ok(out) = std::process::Command::new("xcrun").args(["-f", "lldb-dap"]).output() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && Path::new(&p).is_file() {
                return Ok(PathBuf::from(p));
            }
        }
    }
    which("lldb-dap").or_else(|| which("lldb-vscode")).ok_or_else(|| "lldb-dap을 찾지 못했습니다 — macOS는 Xcode 16 이상, 그 밖에는 LLVM 18 이상(lldb-dap)을 설치하세요".to_string())
}

fn ensure_netcoredbg(gateway: Option<&str>) -> Result<PathBuf, String> {
    let platform = platform().ok_or_else(|| unsupported("netcoredbg"))?;
    if platform == "darwin-arm64" {
        // upstream publishes no Apple Silicon build: the platform builds one (ops/runner/build-netcoredbg.sh)
        return ensure_from_gateway("netcoredbg", gateway).map(|d| d.join("netcoredbg").join("netcoredbg"));
    }
    let (_, file, sha) = NETCOREDBG_ASSETS.iter().find(|(p, _, _)| *p == platform).ok_or_else(|| unsupported("netcoredbg"))?;
    let dir = download_unpacked(&format!("netcoredbg-{NETCOREDBG_VERSION}"), &format!("https://github.com/Samsung/netcoredbg/releases/download/{NETCOREDBG_VERSION}/{file}"), file, sha, None)?;
    existing(dir.join("netcoredbg").join(exe("netcoredbg")))
}

/// Adapters the platform builds itself (clrdbg; netcoredbg for Apple Silicon): the gateway lists them in
/// /_runner/adapters/manifest.json {name: {file, sha256, version, platform}} over the same TLS connection
/// the runner already trusts, and serves the files next to it.
fn ensure_from_gateway(name: &str, gateway: Option<&str>) -> Result<PathBuf, String> {
    let platform = platform().ok_or_else(|| unsupported(name))?;
    let base = gateway.ok_or_else(|| format!("{name}: 게이트웨이 주소를 모릅니다"))?.trim_end_matches('/').to_string();
    let manifest: Value = if let Some(mirror) = std::env::var_os("AIDEV_ADAPTER_MIRROR") {
        serde_json::from_slice(&std::fs::read(Path::new(&mirror).join("manifest.json")).map_err(|e| format!("manifest.json: {e}"))?).map_err(|e| e.to_string())?
    } else {
        ureq::get(&format!("{base}/_runner/adapters/manifest.json")).timeout(Duration::from_secs(20)).call().map_err(|e| format!("{name}: 목록을 받지 못했습니다: {e}"))?.into_json().map_err(|e| e.to_string())?
    };
    let entry = manifest.get(format!("{name}-{platform}")).ok_or_else(|| format!("{name}: 플랫폼에 이 PC({platform})용 빌드가 아직 없습니다"))?;
    let (file, sha, version) = (entry["file"].as_str().unwrap_or(""), entry["sha256"].as_str().unwrap_or(""), entry["version"].as_str().unwrap_or("0"));
    if file.is_empty() || file.contains('/') || file.contains("..") || sha.len() != 64 {
        return Err(format!("{name}: 목록 항목이 올바르지 않습니다"));
    }
    download_unpacked(&format!("{name}-{version}-{platform}"), &format!("{base}/_runner/adapters/{file}"), file, sha, None)
}

fn ensure_delve() -> Result<PathBuf, String> {
    if let Some(p) = which("dlv") {
        return Ok(p);
    }
    let go = which("go").ok_or("Go 디버깅에는 이 PC에 go가 있어야 합니다")?;
    let dir = adapters_dir().join("delve");
    provision(&dir, |tmp| {
        let mut cmd = std::process::Command::new(&go);
        cmd.args(["install", "github.com/go-delve/delve/cmd/dlv@latest"]).env("GOBIN", tmp).stdin(std::process::Stdio::null());
        if let Some(path) = crate::exec::user_path() {
            cmd.env("PATH", path);
        }
        let out = cmd.output().map_err(|e| format!("go install 실패: {e}"))?;
        if !out.status.success() {
            return Err(format!("delve 설치 실패: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
        }
        Ok(())
    })?;
    existing(dir.join(exe("dlv")))
}

/// The adapter's command line for `port` (a TCP adapter listens there; a stdio one ignores it).
pub fn launch(adapter: &str, port: u16, opts: &Options) -> Result<Launch, String> {
    let tcp = |program: PathBuf, args: Vec<String>, version: &str| Launch { program, args, env: vec![], version: version.into(), stdio: false };
    let stdio = |program: PathBuf, args: Vec<String>, version: String| Launch { program, args, env: vec![], version, stdio: true };
    let p = port.to_string();
    match adapter {
        "js-debug" => {
            let node = which("node").ok_or("Node 디버깅에는 이 PC에 node가 있어야 합니다")?;
            let dir = download_unpacked(&format!("js-debug-{JS_DEBUG_VERSION}"), &format!("https://github.com/microsoft/vscode-js-debug/releases/download/v{JS_DEBUG_VERSION}/js-debug-dap-v{JS_DEBUG_VERSION}.tar.gz"), &format!("js-debug-dap-v{JS_DEBUG_VERSION}.tar.gz"), JS_DEBUG_SHA256, None)?;
            let server = existing(dir.join("js-debug").join("src").join("dapDebugServer.js"))?;
            Ok(tcp(node, vec![server.display().to_string(), p, "127.0.0.1".into()], JS_DEBUG_VERSION))
        }
        "debugpy" => {
            let py = python()?;
            let dir = ensure_debugpy(&py)?;
            let mut l = tcp(py, vec!["-m".into(), "debugpy.adapter".into(), "--host".into(), "127.0.0.1".into(), "--port".into(), p], DEBUGPY_VERSION);
            l.env.push(("PYTHONPATH".into(), dir.display().to_string()));
            Ok(l)
        }
        "codelldb" => {
            let platform = platform().ok_or_else(|| unsupported("codelldb"))?;
            let sha = CODELLDB_ASSETS.iter().find(|(pl, _)| *pl == platform).map(|(_, s)| *s).ok_or_else(|| unsupported("codelldb"))?;
            let file = format!("codelldb-{platform}.vsix");
            let dir = download_unpacked(&format!("codelldb-{CODELLDB_VERSION}"), &format!("https://github.com/vadimcn/codelldb/releases/download/v{CODELLDB_VERSION}/{file}"), &file, sha, Some("extension"))?;
            #[cfg(unix)]
            for sub in ["extension/adapter/codelldb", "extension/lldb/bin/lldb", "extension/lldb/bin/lldb-server", "extension/lldb/bin/lldb-argdumper", "extension/lldb/bin/debugserver"] {
                if dir.join(sub).is_file() { let _ = set_mode(&dir.join(sub), true); }
            }
            let bin = existing(dir.join("extension").join("adapter").join(exe("codelldb")))?;
            Ok(tcp(bin, vec!["--port".into(), p], CODELLDB_VERSION))
        }
        "gdb" => {
            let gdb = resolve_gdb(opts.debugger.as_deref())?;
            let version = version_line(&gdb, "--version").unwrap_or_default();
            Ok(stdio(gdb, vec!["-i=dap".into(), "-q".into()], version))
        }
        "lldb-dap" => {
            let bin = resolve_lldb_dap()?;
            let version = version_line(&bin, "--version").unwrap_or_else(|| "lldb-dap".into());
            Ok(stdio(bin, vec![], version))
        }
        "netcoredbg" => {
            let bin = ensure_netcoredbg(opts.gateway.as_deref())?;
            Ok(stdio(bin, vec!["--interpreter=vscode".into()], NETCOREDBG_VERSION.into()))
        }
        "delve" => {
            let dlv = ensure_delve()?;
            let version = version_line(&dlv, "version").unwrap_or_else(|| "delve".into());
            Ok(Launch { program: dlv, args: vec!["dap".into(), "--listen".into(), format!("127.0.0.1:{port}")], env: vec![], version, stdio: false })
        }
        "jvm" => {
            let java = java_for_jdi()?;
            Ok(stdio(java, vec!["-jar".into(), ensure_jdi()?.display().to_string()], format!("aidev-jdi {AIDEV_JDI_VERSION}")))
        }
        "dart" | "flutter" => {
            let bin = which(adapter).ok_or_else(|| format!("{adapter} SDK를 찾지 못했습니다 — 이 PC의 PATH에 {adapter}가 있어야 합니다"))?;
            let version = version_line(&bin, "--version").unwrap_or_else(|| adapter.into());
            Ok(stdio(bin, vec!["debug_adapter".into()], version))
        }
        "probe-rs" => {
            let platform = platform().ok_or_else(|| unsupported("probe-rs"))?;
            let (_, file, sha) = PROBE_RS_ASSETS.iter().find(|(pl, _, _)| *pl == platform).ok_or_else(|| unsupported("probe-rs"))?;
            let dir = download_unpacked(&format!("probe-rs-{PROBE_RS_VERSION}"), &format!("https://github.com/probe-rs/probe-rs/releases/download/v{PROBE_RS_VERSION}/{file}"), file, sha, None)?;
            let folder = file.trim_end_matches(".tar.xz").trim_end_matches(".zip");
            let bin = [dir.join(folder).join(exe("probe-rs")), dir.join(exe("probe-rs"))].into_iter().find(|p| p.is_file()).ok_or("probe-rs 실행 파일이 없습니다")?;
            #[cfg(unix)]
            let _ = set_mode(&bin, true);
            Ok(tcp(bin, vec!["dap-server".into(), "--port".into(), p], PROBE_RS_VERSION))
        }
        "mono" => {
            let mono = which("mono").ok_or("Mono 디버깅에는 이 PC에 mono가 있어야 합니다 (Unity는 에디터/플레이어의 디버그 포트에 attach)")?;
            let file = format!("mono-debug-{MONO_DEBUG_VERSION}.vsix");
            let dir = download_unpacked(&format!("mono-debug-{MONO_DEBUG_VERSION}"), &format!("https://github.com/microsoft/vscode-mono-debug/releases/download/v{MONO_DEBUG_VERSION}/{file}"), &file, MONO_DEBUG_SHA256, Some("extension/bin"))?;
            let exe_path = existing(dir.join("extension").join("bin").join("Release").join("mono-debug.exe"))?;
            Ok(stdio(mono, vec![exe_path.display().to_string()], MONO_DEBUG_VERSION.into()))
        }
        "clrdbg" => {
            if !cfg!(windows) {
                return Err(".NET Framework 디버깅은 Windows PC에서만 됩니다 (.NET 6 이상은 netcoredbg)".into());
            }
            let dir = ensure_from_gateway("clrdbg", opts.gateway.as_deref())?;
            Ok(stdio(existing(dir.join("aidev-clrdbg.exe"))?, vec![], "clrdbg".into()))
        }
        "custom" => {
            let cmd = opts.command.as_deref().ok_or("custom: command가 필요합니다")?;
            let program = if Path::new(cmd).is_absolute() { PathBuf::from(cmd) } else { which(cmd).ok_or_else(|| format!("{cmd}을(를) 찾지 못했습니다"))? };
            let tcp_mode = opts.transport.as_deref() == Some("tcp");
            if tcp_mode && !opts.command_args.iter().any(|a| a.contains("{port}")) {
                return Err("custom tcp: 인자에 {port}가 있어야 합니다".into());
            }
            let args = opts.command_args.iter().map(|a| a.replace("{port}", &p)).collect();
            Ok(Launch { program, args, env: vec![], version: "custom".into(), stdio: !tcp_mode })
        }
        other => Err(format!("지원하지 않는 디버그 어댑터: {other} ({})", ADAPTERS.join(" | "))),
    }
}

/// Which adapters this PC can use right now without downloading anything (reported in capabilities).
pub fn available() -> Vec<&'static str> {
    let mut out = vec![];
    let have = |b: &str| which(b).is_some();
    if have("node") { out.push("js-debug"); }
    if have("python3") || have("python") { out.push("debugpy"); }
    if platform().is_some() { out.push("codelldb"); out.push("probe-rs"); }
    if which("gdb").and_then(|g| version_line(&g, "--version")).and_then(|l| gdb_major(&l)).is_some_and(|v| v >= 14) { out.push("gdb"); }
    if have("lldb-dap") || have("lldb-vscode") || cfg!(target_os = "macos") { out.push("lldb-dap"); }
    if have("dotnet") { out.push("netcoredbg"); }
    if have("dlv") || have("go") { out.push("delve"); }
    if have("java") { out.push("jvm"); }
    if have("dart") { out.push("dart"); }
    if have("flutter") { out.push("flutter"); }
    if have("mono") { out.push("mono"); }
    if cfg!(windows) { out.push("clrdbg"); }
    out.push("custom");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gdb_versions() {
        assert_eq!(gdb_major("GNU gdb (Ubuntu 15.1-1ubuntu1~24.04.1) 15.1"), Some(15));
        assert_eq!(gdb_major("GNU gdb (Arm GNU Toolchain 13.3.Rel1 (Build arm-13.24)) 14.2.90.20240526-git"), Some(14));
        assert_eq!(gdb_major("GNU gdb (GDB) 12.1"), Some(12));
        assert!(resolve_gdb(Some("rm; gdb")).is_err());
        assert!(resolve_gdb(Some("bash")).is_err());
    }

    #[test]
    fn custom_needs_a_port_placeholder_for_tcp() {
        let o = Options { command: Some("sh".into()), command_args: vec!["-c".into(), "x".into()], transport: Some("tcp".into()), ..Default::default() };
        assert!(launch("custom", 5000, &o).unwrap_err().contains("{port}"));
        let o = Options { command: Some("sh".into()), command_args: vec!["--port={port}".into()], transport: Some("tcp".into()), ..Default::default() };
        let l = launch("custom", 5000, &o).unwrap();
        assert_eq!((l.args[0].as_str(), l.stdio), ("--port=5000", false));
        let o = Options { command: Some("sh".into()), ..Default::default() };
        assert!(launch("custom", 1, &o).unwrap().stdio);
        assert!(launch("nope", 1, &Options::default()).unwrap_err().contains("지원하지 않는"));
    }
}
