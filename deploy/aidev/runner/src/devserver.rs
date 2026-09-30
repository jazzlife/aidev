//! `dev.scan` (F-06b): what a preview can show on this PC — the TCP ports that are listening (with the
//! program behind each) and the dev projects inside the allowed folders, each with the command that starts
//! its dev server for a preview. Only what the OS already has is used: `lsof` on macOS, /proc on Linux,
//! `netstat` + `tasklist` on Windows. A preview whose port refuses the connection lists the open ports too.
//!   dev.scan {} → {ports:[{port, pid, process, address, loopback}], projects:[{dir, name, framework, pm, script, command, env}]}
//! `command` has `{port}` and `{base}` placeholders the workbench fills in (base = the preview path).

use crate::config::Config;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type RpcResult = Result<Value, (i64, String)>;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Listen {
    pub port: u16,
    pub pid: Option<u32>,
    pub process: Option<String>,
    pub address: String,
    /// reachable through 127.0.0.1 / ::1 (what a preview tunnel dials)
    pub loopback: bool,
}

fn loopback_or_any(addr: &str) -> bool {
    let a = addr.trim_matches(|c| c == '[' || c == ']');
    matches!(a, "*" | "0.0.0.0" | "::" | "127.0.0.1" | "::1" | "localhost") || a.starts_with("127.") || a == "::ffff:127.0.0.1"
}

/// Split "host:port" / "[v6]:port" / "*:port".
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]   // parsers of the other OSes (tested everywhere)
fn split_addr(s: &str) -> Option<(String, u16)> {
    let i = s.rfind(':')?;
    Some((s[..i].to_string(), s[i + 1..].parse().ok()?))
}

/// One entry per port (IPv4 and IPv6 sockets of one server merge), user ports only, sorted.
fn merge(list: Vec<Listen>) -> Vec<Listen> {
    let mut by: BTreeMap<u16, Listen> = BTreeMap::new();
    for l in list.into_iter().filter(|l| l.port >= 1024) {
        by.entry(l.port)
            .and_modify(|e| {
                e.loopback |= l.loopback;
                if e.process.is_none() { e.process = l.process.clone(); e.pid = l.pid; }
            })
            .or_insert(l);
    }
    by.into_values().collect()
}

/// macOS: `lsof -nP -iTCP -sTCP:LISTEN -F pcn` → p<pid> / c<command> / n<address:port> records.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]   // parsers of the other OSes (tested everywhere)
pub fn parse_lsof(out: &str) -> Vec<Listen> {
    let (mut pid, mut cmd) = (None, None);
    let mut v = Vec::new();
    for line in out.lines() {
        let (tag, rest) = line.split_at(line.len().min(1));
        match tag {
            "p" => { pid = rest.parse().ok(); cmd = None; }
            "c" => cmd = Some(rest.to_string()),
            "n" => {
                if let Some((addr, port)) = split_addr(rest) {
                    v.push(Listen { port, pid, process: cmd.clone(), loopback: loopback_or_any(&addr), address: addr });
                }
            }
            _ => {}
        }
    }
    v
}

/// Windows: `netstat -ano -p TCP` / TCPv6 rows "TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 1234" + tasklist CSV names.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]   // parsers of the other OSes (tested everywhere)
pub fn parse_netstat(out: &str, names: &BTreeMap<u32, String>) -> Vec<Listen> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 5 || !f[0].eq_ignore_ascii_case("TCP") || !f[3].eq_ignore_ascii_case("LISTENING") { return None; }
            let (addr, port) = split_addr(f[1])?;
            let pid: Option<u32> = f[4].parse().ok();
            Some(Listen { port, pid, process: pid.and_then(|p| names.get(&p).cloned()), loopback: loopback_or_any(&addr), address: addr })
        })
        .collect()
}

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]   // parsers of the other OSes (tested everywhere)
pub fn parse_tasklist(csv: &str) -> BTreeMap<u32, String> {
    csv.lines()
        .filter_map(|l| {
            let cols: Vec<&str> = l.split("\",\"").map(|c| c.trim_matches('"')).collect();
            Some((cols.get(1)?.parse().ok()?, cols.first()?.trim_end_matches(".exe").to_string()))
        })
        .collect()
}

/// Linux: /proc/net/tcp{,6} rows in LISTEN state (0A); the owning process from /proc/<pid>/fd socket links.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc_net(text: &str, v6: bool) -> Vec<(String, u16, u64)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" { return None; }
            let (hex_addr, hex_port) = f[1].split_once(':')?;
            let port = u16::from_str_radix(hex_port, 16).ok()?;
            let addr = if v6 {
                match hex_addr {
                    "00000000000000000000000000000000" => "::".to_string(),
                    "00000000000000000000000001000000" => "::1".to_string(),
                    "0000000000000000FFFF00000100007F" => "::ffff:127.0.0.1".to_string(),
                    other => other.to_lowercase(),
                }
            } else {
                let n = u32::from_str_radix(hex_addr, 16).ok()?.to_le_bytes();
                format!("{}.{}.{}.{}", n[0], n[1], n[2], n[3])
            };
            Some((addr, port, f[9].parse().ok()?))
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn listening_os() -> Vec<Listen> {
    let mut rows = Vec::new();
    for (file, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        if let Ok(t) = std::fs::read_to_string(file) { rows.extend(parse_proc_net(&t, v6)); }
    }
    // socket inode → (pid, comm), for this user's processes
    let mut owner: BTreeMap<u64, (u32, String)> = BTreeMap::new();
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let Ok(fds) = std::fs::read_dir(e.path().join("fd")) else { continue };
            let comm = std::fs::read_to_string(e.path().join("comm")).unwrap_or_default().trim().to_string();
            for fd in fds.flatten() {
                if let Ok(link) = std::fs::read_link(fd.path()) {
                    if let Some(ino) = link.to_str().and_then(|s| s.strip_prefix("socket:[")).and_then(|s| s.strip_suffix(']')).and_then(|s| s.parse().ok()) {
                        owner.insert(ino, (pid, comm.clone()));
                    }
                }
            }
        }
    }
    rows.into_iter()
        .map(|(address, port, ino)| {
            let o = owner.get(&ino);
            Listen { port, pid: o.map(|o| o.0), process: o.map(|o| o.1.clone()), loopback: loopback_or_any(&address), address }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn listening_os() -> Vec<Listen> {
    std::process::Command::new("/usr/sbin/lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).output()
        .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn listening_os() -> Vec<Listen> {
    let run = |cmd: &str, args: &[&str]| std::process::Command::new(cmd).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let names = parse_tasklist(&run("tasklist", &["/FO", "CSV", "/NH"]));
    let mut v = parse_netstat(&run("netstat", &["-ano", "-p", "TCP"]), &names);
    v.extend(parse_netstat(&run("netstat", &["-ano", "-p", "TCPv6"]), &names));
    v
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn listening_os() -> Vec<Listen> { Vec::new() }

/// Listening TCP ports (≥ 1024) on this PC, one per port.
pub fn listening() -> Vec<Listen> {
    merge(listening_os())
}

/// For a refused preview: "열려 있는 포트: 3000 (node), 8080 (java)" — or that nothing listens at all.
pub fn ports_hint() -> String {
    let open: Vec<String> = listening().into_iter().filter(|l| l.loopback)
        .map(|l| match l.process { Some(p) => format!("{} ({p})", l.port), None => l.port.to_string() })
        .take(12).collect();
    if open.is_empty() { "이 PC에는 지금 열려 있는 개발 서버 포트가 없습니다".into() } else { format!("지금 열려 있는 포트: {}", open.join(", ")) }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Project {
    pub dir: String,
    pub name: String,
    pub framework: String,
    pub pm: String,
    pub script: String,
    /// with `{port}` / `{base}` placeholders
    pub command: String,
    pub env: BTreeMap<String, String>,
    /// the dev server serves under `{base}` (full preview incl. HMR) — otherwise the preview rewrites root paths
    pub base: bool,
}

/// A package.json directory → how to start its dev server for a preview (None: no dev/start/serve script).
pub fn detect(dir: &Path) -> Option<Project> {
    let pkg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).ok()?).ok()?;
    let scripts = pkg.get("scripts")?.as_object()?;
    let script = ["dev", "start", "serve"].into_iter().find(|s| scripts.contains_key(*s))?.to_string();
    let body = scripts.get(&script).and_then(Value::as_str).unwrap_or("");
    let has = |d: &str| ["dependencies", "devDependencies"].iter().any(|k| pkg.get(k).and_then(|v| v.get(d)).is_some());
    let framework = if body.contains("next") || has("next") { "next" }
        else if has("nuxt") || body.contains("nuxt") { "nuxt" }
        else if has("@sveltejs/kit") { "sveltekit" }
        else if has("astro") || body.contains("astro") { "astro" }
        else if body.contains("vite") || has("vite") { "vite" }
        else if body.contains("react-scripts") || has("react-scripts") { "cra" }
        else if body.contains("ng serve") || has("@angular/cli") { "angular" }
        else { "other" };
    let pm = if dir.join("pnpm-lock.yaml").exists() { "pnpm" }
        else if dir.join("yarn.lock").exists() { "yarn" }
        else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() { "bun" }
        else { "npm" };
    // how extra arguments reach the script: npm needs `--`, the others pass them through
    let run = match pm { "npm" => format!("npm run {script} --"), "yarn" => format!("yarn {script}"), p => format!("{p} run {script}") };
    let mut env = BTreeMap::new();
    let (command, base) = match framework {
        "vite" => (format!("{run} --base {{base}} --port {{port}} --strictPort"), true),
        "sveltekit" | "astro" => (format!("{run} --port {{port}}"), false),
        "next" => (format!("{run} -p {{port}}"), false),
        "nuxt" => (format!("{run} --port {{port}}"), false),
        "angular" => (format!("{run} --port {{port}}"), false),   // a sub-path also needs --base-href: root preview
        "cra" => {
            env.insert("PORT".into(), "{port}".into());
            env.insert("BROWSER".into(), "none".into());
            (run.trim_end_matches(" --").to_string(), false)
        }
        _ => (run.trim_end_matches(" --").to_string(), false),
    };
    Some(Project {
        dir: dir.display().to_string(),
        name: pkg.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        framework: framework.into(),
        pm: pm.into(),
        script,
        command,
        env,
        base,
    })
}

/// Dev projects in the allowed folders (up to 3 levels down; dependencies and build output skipped).
pub fn projects(roots: &[PathBuf]) -> Vec<Project> {
    const SKIP: [&str; 8] = ["node_modules", ".git", "dist", "build", "target", ".next", ".nuxt", ".svelte-kit"];
    let mut found = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        if found.len() >= 50 { break; }
        if let Some(p) = detect(&dir) { found.push(p); continue; }   // a project's own subfolders are its business
        if depth >= 3 { continue; }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP.contains(&name.as_str()) { continue; }
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { stack.push((e.path(), depth + 1)); }
        }
    }
    found.sort_by(|a, b| a.dir.cmp(&b.dir));
    found
}

pub async fn rpc(cfg: &Config, method: &str, _params: &Value) -> Option<RpcResult> {
    if method != "dev.scan" { return None; }
    let roots = cfg.allowed_roots.clone();
    Some(
        tokio::task::spawn_blocking(move || json!({ "ports": listening(), "projects": projects(&roots) }))
            .await
            .map_err(|e| (-32000, e.to_string())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_output() {
        let out = "p812\ncnode\nn127.0.0.1:5173\nn[::1]:5173\np90\ncjava\nn*:8080\np7\ncrapportd\nn192.168.0.3:49152\n";
        let v = merge(parse_lsof(out));
        assert_eq!(v.len(), 3);
        assert_eq!((v[0].port, v[0].process.as_deref(), v[0].loopback), (5173, Some("node"), true));
        assert_eq!((v[1].port, v[1].loopback), (8080, true));
        assert_eq!((v[2].port, v[2].loopback), (49152, false), "bound to a LAN address only");
    }

    #[test]
    fn windows_output() {
        let names = parse_tasklist("\"node.exe\",\"1234\",\"Console\",\"1\",\"80,000 K\"\n\"svchost.exe\",\"900\",\"Services\",\"0\",\"1 K\"\n");
        let out = "Active Connections\n\n  Proto  Local Address  Foreign Address  State  PID\n  TCP    127.0.0.1:5173  0.0.0.0:0  LISTENING  1234\n  TCP    0.0.0.0:135  0.0.0.0:0  LISTENING  900\n  TCP    [::1]:5173  [::]:0  LISTENING  1234\n  TCP    10.0.0.2:5000  1.2.3.4:443  ESTABLISHED  1234\n";
        let v = merge(parse_netstat(out, &names));
        assert_eq!(v.len(), 1, "port 135 < 1024, the established row is not a listener");
        assert_eq!((v[0].port, v[0].process.as_deref(), v[0].pid), (5173, Some("node"), Some(1234)));
    }

    #[test]
    fn proc_net_rows() {
        let t = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n   1: 0100007F:1435 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4243 1\n";
        assert_eq!(parse_proc_net(t, false), vec![("127.0.0.1".to_string(), 5173, 4242)]);
    }

    #[test]
    fn live_listener_is_found() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let found = listening().into_iter().find(|x| x.port == port).expect("own listener listed");
        assert!(found.loopback);
        assert!(found.pid == Some(std::process::id()), "{found:?}");
    }

    #[test]
    fn projects_and_commands() {
        let root = std::env::temp_dir().join(format!("aidev-dev-{}", std::process::id()));
        let mk = |sub: &str, pkg: &str, lock: Option<&str>| {
            let d = root.join(sub);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("package.json"), pkg).unwrap();
            if let Some(l) = lock { std::fs::write(d.join(l), "").unwrap(); }
        };
        mk("web", r#"{"name":"web","scripts":{"dev":"vite"},"devDependencies":{"vite":"^6"}}"#, None);
        mk("apps/site", r#"{"name":"site","scripts":{"dev":"next dev"},"dependencies":{"next":"15"}}"#, Some("pnpm-lock.yaml"));
        mk("old", r#"{"name":"old","scripts":{"start":"react-scripts start"}}"#, Some("yarn.lock"));
        mk("lib", r#"{"name":"lib","scripts":{"build":"tsc"}}"#, None);
        mk("web/node_modules/x", r#"{"scripts":{"dev":"x"}}"#, None);
        let p = projects(std::slice::from_ref(&root));
        let names: Vec<&str> = p.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["site", "old", "web"]);
        let web = p.iter().find(|x| x.name == "web").unwrap();
        assert_eq!((web.command.as_str(), web.base), ("npm run dev -- --base {base} --port {port} --strictPort", true));
        let site = p.iter().find(|x| x.name == "site").unwrap();
        assert_eq!(site.command, "pnpm run dev -p {port}");
        let old = p.iter().find(|x| x.name == "old").unwrap();
        assert_eq!((old.command.as_str(), old.env.get("PORT").map(String::as_str)), ("yarn start", Some("{port}")));
        let _ = std::fs::remove_dir_all(root);
    }
}
