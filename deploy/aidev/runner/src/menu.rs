//! `aidev-runner menu` — the runner's management in a terminal, for machines without a desktop (an embedded board's
//! serial console, SSH into a server or a Mac): the state the status icon shows, the rights it needs and how to get
//! them (`perms`), pairing, the service (install, 시작 · 정지 · 다시 시작, remove), the log, allowed folders, screen
//! consent and updates. Numbered lines on stdin/stdout — any terminal, BusyBox's included (no curses).
//! A bare `aidev-runner` on a terminal opens it when a service already runs the runner (main.rs).

use crate::{config, pair, perms, service};
use std::io::{IsTerminal, Write};

pub fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// A line from the terminal (None: end of input).
fn ask(prompt: &str) -> Option<String> {
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line.trim().to_string()),
    }
}

fn yes(prompt: &str, default: bool) -> bool {
    match ask(&format!("{prompt} [{}] ", if default { "Y/n" } else { "y/N" })).as_deref() {
        Some("") => default,
        Some(a) => matches!(a, "y" | "Y" | "yes" | "예" | "ㅛ"),
        None => false,
    }
}

fn pause() {
    let _ = ask("\nEnter를 누르면 메뉴로 돌아갑니다 ");
}

fn show(result: Result<String, String>) {
    match result {
        Ok(text) if !text.is_empty() => println!("{text}"),
        Ok(_) => {}
        Err(e) => println!("오류: {e}"),
    }
}

fn home_short(p: &std::path::Path) -> String {
    let home = config::home();
    match p.strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => p.display().to_string(),
    }
}

fn header() {
    println!("\n━━ NadoVibe 러너 {} · 관리 메뉴 ({} {}, {}) ━━", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH, crate::caps::hostname());
    let cfg = config::load().ok();
    match &cfg {
        Some(c) => println!("  페어링     #{} {} → {}", c.target_id, c.name, c.gateway),
        None => println!("  페어링     안 됨 — 1번으로 작업대 \"원격 대상\"의 코드를 넣으세요"),
    }
    let pid = service::runner_pid().map(|p| format!(" (pid {p})")).unwrap_or_default();
    println!("  서비스     {} · {}{pid}", service::installed().unwrap_or_else(|| "설치 안 됨".into()), service::connection());
    let checks = perms::check();
    if !checks.is_empty() {
        let missing: Vec<&str> = checks.iter().filter(|c| !c.ok).map(|c| c.label.as_str()).collect();
        println!("  권한       {}", if missing.is_empty() { "모두 있음".to_string() } else { format!("빠짐 {}개 — {}", missing.len(), missing.join(", ")) });
    }
    if let Some(c) = &cfg {
        println!("  화면/제어  {} / {}", if c.screen_consent { "허용" } else { "꺼짐" }, if c.control_consent { "허용" } else { "꺼짐" });
        println!("  허용 폴더  {}", if c.allowed_roots.is_empty() { "(없음)".into() } else { c.allowed_roots.iter().map(|r| home_short(r)).collect::<Vec<_>>().join(", ") });
    }
}

const ITEMS: &str = "
  1) 페어링 (코드 입력)          2) 서비스 설치·다시 설치
  3) 시작                        4) 정지 (연결 끊기)
  5) 다시 시작                   6) 권한 확인·얻기
  7) 로그 보기                   8) 허용 폴더
  9) 화면 보기·원격 제어        10) 업데이트
 11) 서비스 제거                12) 페어링 해제
  0) 끝내기";

pub fn run() {
    if cfg!(target_os = "android") {
        println!("Android에서는 NadoVibe 러너 앱에서 관리합니다");
        return;
    }
    loop {
        header();
        println!("{ITEMS}");
        let Some(choice) = ask("\n번호: ") else { println!(); return };
        println!();
        match choice.as_str() {
            "1" => pair_flow(),
            "2" => install_flow(),
            "3" => show(service::control("start")),
            "4" => show(service::control("stop")),
            "5" => show(service::control("restart")),
            "6" => { perms_flow(); continue; }
            "7" => logs(),
            "8" => { roots_flow(); continue; }
            "9" => consent_flow(),
            "10" => show(crate::update_console(None, None)),
            "11" => {
                if yes("서비스(부팅 실행·관리자 권한 설정)를 지울까요? 페어링은 남습니다", false) { show(service::uninstall()); } else { continue; }
            }
            "12" => {
                if yes("이 PC의 토큰을 지울까요? 작업대 \"원격 대상\"에서도 대상을 삭제하세요", false) {
                    let _ = std::fs::remove_file(config::path());
                    println!("토큰을 지웠습니다 — 실행 중인 러너는 다시 시작하면 연결하지 않고, 작업대에서 대상을 삭제하면 바로 끊깁니다 (서비스도 지우려면 11)");
                } else { continue; }
            }
            "0" | "q" | "Q" => return,
            "" => continue,
            other => println!("{other}: 0~12 중에서 고르세요"),
        }
        pause();
    }
}

/// The running runner keeps the settings it started with: restart it to take a change in.
fn offer_restart() {
    if service::installed().is_some() && service::runner_pid().is_some() && yes("실행 중인 러너를 다시 시작해 반영할까요?", true) {
        show(service::control("restart"));
    }
}

fn pair_flow() {
    let previous = config::load().ok();
    let Some(code) = ask("페어링 코드 (작업대 \"원격 대상\" → 등록, 10분 1회용): ") else { return };
    if code.is_empty() {
        return;
    }
    let default_gw = previous.as_ref().map(|c| c.gateway.clone()).unwrap_or_else(|| "https://dev.nado.work".into());
    let gateway = ask(&format!("게이트웨이 [{default_gw}]: ")).filter(|g| !g.is_empty()).unwrap_or(default_gw);
    let name = ask("표시 이름 (Enter: 등록할 때 정한 이름): ").filter(|n| !n.is_empty());
    match pair::pair(&code, &gateway, name.as_deref()) {
        Ok(cfg) => {
            println!("등록 완료: 대상 #{} {}", cfg.target_id, cfg.name);
            if service::installed().is_some() {
                // the service's runner still holds the old token: the gateway would refuse it from now on
                show(service::control("restart"));
            } else if yes("서비스로 설치해 부팅 때부터 실행할까요?", true) {
                show(service::install(false, false, false, None));
            }
        }
        Err(e) => println!("오류: {e}"),
    }
}

fn install_flow() {
    if config::load().is_err() {
        println!("먼저 페어링하세요 (1번)");
        return;
    }
    let limited = !yes("관리자 권한으로 실행할까요? (에이전트가 sudo 없이 시스템 명령을 씀; n = 일반 사용자 권한)", true);
    show(service::install(false, limited, false, None));
    std::thread::sleep(std::time::Duration::from_secs(3));
    println!("\n{}", service::status_text());
}

fn perms_flow() {
    loop {
        let list = perms::check();
        println!("\n━━ 권한 ━━");
        print!("{}", perms::render(&list));
        let fixable: Vec<&perms::Check> = list.iter().filter(|c| !c.ok && c.fixable).collect();
        if fixable.is_empty() {
            println!("\n얻을 수 있는 빠진 권한이 없습니다");
            pause();
            return;
        }
        println!();
        for (i, c) in fixable.iter().enumerate() {
            println!("  {}) 얻기: {}", i + 1, c.label);
        }
        println!("  a) 모두 얻기    Enter) 돌아가기");
        let Some(pick) = ask("\n번호: ") else { return };
        match pick.as_str() {
            "" => return,
            "a" | "A" => {
                for line in perms::fix_all() { println!("{line}"); }
            }
            n => match n.parse::<usize>().ok().and_then(|n| fixable.get(n.wrapping_sub(1))) {
                Some(c) => show(perms::fix(&c.id)),
                None => println!("{n}: 목록의 번호를 고르세요"),
            },
        }
        // new group memberships reach the runner only when it starts again
        if pick != "" && list.iter().any(|c| c.id.starts_with("group:") && !c.ok) {
            offer_restart();
        }
    }
}

fn logs() {
    let file = config::dir().join("runner.log");
    let user_unit = service::installed().as_deref() == Some("systemd 사용자 서비스");
    // the systemd user service writes to the journal; everything else to ~/.aidev/runner.log
    if user_unit && service::which("journalctl").is_some() {
        let _ = std::process::Command::new("journalctl").args(["--user", "-u", "aidev-runner", "-n", "40", "--no-pager"]).status();
    } else {
        match std::fs::read_to_string(&file) {
            Ok(text) => {
                let lines: Vec<&str> = text.lines().collect();
                for l in &lines[lines.len().saturating_sub(40)..] { println!("{l}"); }
            }
            Err(_) => println!("로그가 아직 없습니다 ({})", file.display()),
        }
    }
    if !cfg!(unix) || !yes("\n이어서 따라가며 볼까요? (Ctrl+C로 멈춤)", false) {
        return;
    }
    let mut cmd = if user_unit && service::which("journalctl").is_some() {
        let mut c = std::process::Command::new("journalctl");
        c.args(["--user", "-u", "aidev-runner", "-f", "-n", "0"]);
        c
    } else {
        let mut c = std::process::Command::new("tail");
        c.args(["-n", "0", "-f"]).arg(&file);
        c
    };
    #[cfg(unix)]
    unsafe {
        // Ctrl+C stops the viewer, not the menu
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        std::os::unix::process::CommandExt::pre_exec(&mut cmd, || {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            Ok(())
        });
    }
    let _ = cmd.status();
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_DFL);
    }
}

fn roots_flow() {
    loop {
        let Ok(mut cfg) = config::load() else { println!("먼저 페어링하세요 (1번)"); pause(); return };
        println!("\n━━ 허용 폴더 — 플랫폼이 읽고 쓰고 실행하는 곳 ━━");
        for (i, r) in cfg.allowed_roots.iter().enumerate() {
            println!("  {}) {}", i + 1, r.display());
        }
        println!("\n  a) 추가    d) 삭제    Enter) 돌아가기");
        let Some(pick) = ask("\n선택: ") else { return };
        let changed = match pick.as_str() {
            "" => return,
            "a" | "A" => match ask("추가할 폴더: ").filter(|p| !p.is_empty()) {
                Some(p) => {
                    let p = if let Some(rest) = p.strip_prefix("~/") { config::home().join(rest) } else if p == "~" { config::home() } else { p.into() };
                    config::add_root(&mut cfg, &p).map(|_| true).unwrap_or_else(|e| { println!("오류: {e}"); false })
                }
                None => false,
            },
            "d" | "D" => match ask("삭제할 번호: ").and_then(|n| n.parse::<usize>().ok()).and_then(|n| cfg.allowed_roots.get(n.wrapping_sub(1)).cloned()) {
                Some(p) => { config::remove_root(&mut cfg, &p); true }
                None => false,
            },
            _ => false,
        };
        if changed {
            match config::save(&cfg) {
                Ok(()) => offer_restart(),
                Err(e) => println!("오류: {e}"),
            }
        }
    }
}

fn consent_flow() {
    let Ok(cfg) = config::load() else { println!("먼저 페어링하세요 (1번)"); return };
    println!("화면 보기: {} / 원격 제어(마우스·키보드): {}", if cfg.screen_consent { "허용" } else { "꺼짐" }, if cfg.control_consent { "허용" } else { "꺼짐" });
    println!("\n  1) 화면 보기 {}    2) 원격 제어 {}    Enter) 돌아가기", if cfg.screen_consent { "끄기" } else { "켜기" }, if cfg.control_consent { "끄기" } else { "켜기" });
    let change = match ask("\n선택: ").as_deref() {
        Some("1") => (Some(!cfg.screen_consent), None),
        Some("2") => (None, Some(!cfg.control_consent)),
        _ => return,
    };
    match config::set_consent(&cfg, change.0, change.1) {
        Ok((s, c)) => {
            println!("화면 보기: {} / 원격 제어: {}", if s { "허용" } else { "꺼짐" }, if c { "허용" } else { "꺼짐" });
            offer_restart();
        }
        Err(e) => println!("오류: {e}"),
    }
}
