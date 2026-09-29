//! `install-service` / `uninstall-service`: keep the runner running in the user's session.
//!   Linux  — systemd user unit  ~/.config/systemd/user/aidev-runner.service
//!   macOS  — LaunchAgent        ~/Library/LaunchAgents/work.nado.aidev-runner.plist
//!   Windows — logon task        schtasks "aidev-runner" (runs `aidev-runner start` at sign-in)
//! Runs as the current user, never as root/SYSTEM: the runner only needs the user's own folders.

use crate::config;
use std::path::PathBuf;
use std::process::Command;

fn exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("실행 파일 경로를 알 수 없습니다: {e}"))
}

fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(cmd).args(args).status().map_err(|e| format!("{cmd}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("{cmd} {} 실패 ({status})", args.join(" "))) }
}

pub fn unit_text(exe: &str) -> String {
    format!(
        "[Unit]\nDescription=Nado AI Dev runner\nAfter=network-online.target\n\n[Service]\nExecStart=\"{exe}\" start\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n"
    )
}

pub fn plist_text(exe: &str, log: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>work.nado.aidev-runner</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#
    )
}

pub fn install(print_only: bool) -> Result<String, String> {
    config::load()?; // must be paired first
    let exe = exe()?;
    let exe_s = exe.display().to_string();
    let home = config::home();
    match std::env::consts::OS {
        "linux" => {
            let dir = home.join(".config/systemd/user");
            let unit = dir.join("aidev-runner.service");
            let text = unit_text(&exe_s);
            if print_only { return Ok(format!("# {}\n{text}", unit.display())); }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&unit, text).map_err(|e| e.to_string())?;
            run("systemctl", &["--user", "daemon-reload"])?;
            run("systemctl", &["--user", "enable", "--now", "aidev-runner.service"])?;
            Ok(format!("systemd 사용자 서비스 등록: {}\n로그: journalctl --user -u aidev-runner -f\n로그아웃 후에도 계속 돌리려면: loginctl enable-linger $USER", unit.display()))
        }
        "macos" => {
            let dir = home.join("Library/LaunchAgents");
            let plist = dir.join("work.nado.aidev-runner.plist");
            let log = config::dir().join("runner.log");
            let text = plist_text(&exe_s, &log.display().to_string());
            if print_only { return Ok(format!("# {}\n{text}", plist.display())); }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&plist, text).map_err(|e| e.to_string())?;
            let uid = String::from_utf8_lossy(&Command::new("id").arg("-u").output().map_err(|e| e.to_string())?.stdout).trim().to_string();
            let _ = Command::new("launchctl").args(["bootout", &format!("gui/{uid}"), &plist.display().to_string()]).status();
            run("launchctl", &["bootstrap", &format!("gui/{uid}"), &plist.display().to_string()])?;
            Ok(format!("LaunchAgent 등록: {}\n로그: {}", plist.display(), log.display()))
        }
        "windows" => {
            let tr = format!("\"{exe_s}\" start");
            if print_only { return Ok(format!("schtasks /Create /F /SC ONLOGON /RL LIMITED /TN aidev-runner /TR {tr}")); }
            run("schtasks", &["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", "aidev-runner", "/TR", &tr])?;
            let _ = run("schtasks", &["/Run", "/TN", "aidev-runner"]);
            Ok("로그온 작업 등록: aidev-runner (로그인할 때마다 실행)".into())
        }
        other => Err(format!("{other}: 서비스 등록을 지원하지 않습니다 — `aidev-runner start`를 직접 실행하세요")),
    }
}

pub fn uninstall() -> Result<String, String> {
    let home = config::home();
    match std::env::consts::OS {
        "linux" => {
            let _ = run("systemctl", &["--user", "disable", "--now", "aidev-runner.service"]);
            let _ = std::fs::remove_file(home.join(".config/systemd/user/aidev-runner.service"));
            let _ = run("systemctl", &["--user", "daemon-reload"]);
            Ok("systemd 사용자 서비스를 제거했습니다".into())
        }
        "macos" => {
            let plist = home.join("Library/LaunchAgents/work.nado.aidev-runner.plist");
            let uid = String::from_utf8_lossy(&Command::new("id").arg("-u").output().map_err(|e| e.to_string())?.stdout).trim().to_string();
            let _ = Command::new("launchctl").args(["bootout", &format!("gui/{uid}"), &plist.display().to_string()]).status();
            let _ = std::fs::remove_file(&plist);
            Ok("LaunchAgent를 제거했습니다".into())
        }
        "windows" => {
            run("schtasks", &["/Delete", "/F", "/TN", "aidev-runner"])?;
            Ok("로그온 작업을 제거했습니다".into())
        }
        other => Err(format!("{other}: 지원하지 않습니다")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn service_files_quote_the_path() {
        assert!(super::unit_text("/opt/a b/aidev-runner").contains("ExecStart=\"/opt/a b/aidev-runner\" start"));
        let plist = super::plist_text("/Users/x/bin/aidev-runner", "/Users/x/.aidev/runner.log");
        assert!(plist.contains("<string>/Users/x/bin/aidev-runner</string><string>start</string>"));
    }
}
