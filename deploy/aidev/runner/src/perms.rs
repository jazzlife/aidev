//! The rights the runner works with, checked and obtained from a terminal (`aidev-runner perms [--fix] [--json]`, the
//! menu) — the headless counterpart of the desktop prompts (macOS asks for Screen Recording / Accessibility in its
//! session, Windows' `install` asks UAC once, the Android app shows each permission with a button):
//!   admin   — root, or sudo without a password (`install`'s default; agents run administrator commands)
//!   boot    — kept running from boot: a system service, or linger for the systemd user service
//!   group:* — device groups this system has and the user is not in: serial ports, USB, GPIO / I²C / SPI, camera …
//!             (an embedded board's tools need them; root needs none)

use crate::service;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Debug)]
pub struct Check {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
    /// `fix(id)` can obtain it here
    pub fixable: bool,
}

/// Device groups worth being in, as far as this system has them.
const GROUPS: &[(&str, &str)] = &[
    ("dialout", "시리얼 포트 (/dev/ttyUSB*, ttyACM*)"),
    ("uucp", "시리얼 포트"),
    ("tty", "터미널·시리얼 장치"),
    ("plugdev", "USB 장치"),
    ("gpio", "GPIO"),
    ("i2c", "I²C"),
    ("spi", "SPI"),
    ("video", "카메라·프레임버퍼"),
    ("render", "GPU"),
    ("input", "입력 장치"),
    ("audio", "오디오"),
];

fn user() -> String {
    service::user_name()
}

fn out(cmd: &str, args: &[&str]) -> Option<String> {
    Command::new(cmd).args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().ok()
        .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// The groups of /etc/group.
fn system_groups() -> Vec<String> {
    std::fs::read_to_string("/etc/group").unwrap_or_default().lines().filter_map(|l| l.split(':').next()).map(str::to_string).collect()
}

fn sudo_state() -> &'static str {
    if service::which("sudo").is_none() {
        return "none";
    }
    if Command::new("sudo").args(["-n", "true"]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success()) {
        "nopasswd"
    } else {
        "password"
    }
}

fn linger() -> bool {
    out("loginctl", &["show-user", &user(), "-p", "Linger", "--value"]).is_some_and(|v| v == "yes")
}

pub fn check() -> Vec<Check> {
    let mut list = Vec::new();
    if !cfg!(unix) || cfg!(target_os = "android") {
        return list;
    }
    let root = crate::proc_util::is_elevated();
    let (ok, detail, fixable) = if root {
        (true, "root로 실행".to_string(), false)
    } else {
        match sudo_state() {
            "nopasswd" => (true, format!("{}의 sudo를 비밀번호 없이", user()), false),
            "password" => (false, "sudo에 비밀번호가 필요합니다 — 얻기: 비밀번호 없는 sudo 설정(비밀번호 한 번)".to_string(), true),
            _ => (false, "sudo가 없습니다 — root로 설치하면 관리자 권한으로 실행됩니다 (su -c '~/.aidev/bin/aidev-runner install')".to_string(), false),
        }
    };
    list.push(Check { id: "admin".into(), label: "관리자 권한".into(), ok, detail, fixable });

    let installed = service::installed();
    let (ok, detail) = match installed.as_deref() {
        Some("systemd 사용자 서비스") if linger() => (true, "systemd 사용자 서비스 + linger (로그인하지 않아도)".to_string()),
        Some("systemd 사용자 서비스") => (false, "로그인한 동안만 — 얻기: linger 켜기".to_string()),
        Some(mode) if mode.starts_with("LaunchAgent") && !mode.contains("부팅") => (false, "로그인한 동안만 — 얻기: 부팅용 LaunchDaemon 등록".to_string()),
        Some(mode) => (true, mode.to_string()),
        None => (false, "서비스가 없습니다 — 얻기: 서비스 설치".to_string()),
    };
    list.push(Check { id: "boot".into(), label: "부팅 때 실행".into(), ok, detail, fixable: !ok });

    if cfg!(target_os = "linux") && !root {
        let me = user();
        let have = system_groups();
        // in the group database / in this process (a fresh membership reaches running processes only after a restart)
        let db: Vec<String> = out("id", &["-nG", &me]).unwrap_or_default().split_whitespace().map(str::to_string).collect();
        let live: Vec<String> = out("id", &["-nG"]).unwrap_or_default().split_whitespace().map(str::to_string).collect();
        for (group, what) in GROUPS {
            if !have.iter().any(|g| g == group) {
                continue;
            }
            let member = db.iter().any(|g| g == group);
            let detail = match (member, live.iter().any(|g| g == group)) {
                (true, true) => "속해 있음".to_string(),
                (true, false) => "추가됨 — 서비스를 다시 시작(사용자 서비스는 다시 로그인)하면 적용".to_string(),
                _ => format!("{me}이(가) {group} 그룹에 없습니다"),
            };
            list.push(Check { id: format!("group:{group}"), label: format!("장치: {what}"), ok: member, detail, fixable: !member });
        }
    }
    list
}

/// Obtains one right (`check`'s id); says what was done.
pub fn fix(id: &str) -> Result<String, String> {
    let me = user();
    match id {
        "admin" => service::grant_sudo(&me).map(|_| format!("관리자 권한: {me}의 sudo를 비밀번호 없이 쓰도록 설정했습니다")),
        "boot" => match service::installed().as_deref() {
            Some("systemd 사용자 서비스") => {
                if service::quiet("loginctl", &["enable-linger", &me]) || service::as_root(&["loginctl", "enable-linger", &me]).is_ok() {
                    Ok("linger를 켰습니다 — 로그인하지 않아도 부팅 때부터 실행됩니다".into())
                } else {
                    Err("linger를 켜지 못했습니다 — sudo loginctl enable-linger $USER".into())
                }
            }
            _ => service::install(false, false, false, None),
        },
        g if g.starts_with("group:") => {
            let group = &g[6..];
            if !GROUPS.iter().any(|(name, _)| *name == group) || !system_groups().iter().any(|x| x == group) {
                return Err(format!("{group}: 이 시스템에 없는 그룹입니다"));
            }
            // shadow-utils, Debian's adduser and BusyBox (adduser USER GROUP / Alpine's addgroup USER GROUP)
            let r = if service::which("usermod").is_some() {
                service::as_root(&["usermod", "-aG", group, &me])
            } else if service::which("adduser").is_some() {
                service::as_root(&["adduser", &me, group])
            } else {
                service::as_root(&["addgroup", &me, group])
            };
            r.map(|_| format!("{me}을(를) {group} 그룹에 넣었습니다 — 서비스를 다시 시작하면 적용됩니다 (사용자 서비스는 다시 로그인·재부팅)"))
        }
        other => Err(format!("{other}: 알 수 없는 항목")),
    }
}

/// Every missing right that can be obtained here; one line each.
pub fn fix_all() -> Vec<String> {
    check().into_iter().filter(|c| !c.ok && c.fixable).map(|c| match fix(&c.id) {
        Ok(done) => format!("✓ {}: {done}", c.label),
        Err(e) => format!("✗ {}: {e}", c.label),
    }).collect()
}

pub fn render(list: &[Check]) -> String {
    if list.is_empty() {
        return "이 OS에서는 확인할 권한이 없습니다 (Windows: `aidev-runner install`이 UAC로, Android: NadoVibe 러너 앱이 권한을 받습니다)\n".into();
    }
    let mut text = String::new();
    for c in list {
        text.push_str(&format!("  {} {:<28} {}\n", if c.ok { "✓" } else if c.fixable { "✗" } else { "!" }, c.label, c.detail));
    }
    text
}
