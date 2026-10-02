//! `install-service` / `uninstall-service`: keep the runner running in the user's session.
//!   Linux  — systemd user unit  ~/.config/systemd/user/aidev-runner.service
//!   macOS  — LaunchAgent        ~/Library/LaunchAgents/work.nado.aidev-runner.plist
//!   Windows — two tasks (Register-ScheduledTask, no time limit, restarted if they stop), by default with the
//!             user's full administrator token (what WinRM gives: services, registry, firewall, installs):
//!     "aidev-runner"       at sign-in, in the user's session (screen, input, GUI apps)
//!     "aidev-runner-boot"  at boot without a sign-in (S4U: no stored password, no desktop) — `start --boot` hands the
//!                          connection to the sign-in's runner and takes it back when that one ends
//!   `--limited`: the user's normal rights; `--logon-only`: no boot task. Registering either default needs an
//!   administrator: `install` from a normal prompt asks once (UAC) and re-runs itself elevated.
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
        "[Unit]\nDescription=NadoVibe runner\nAfter=network-online.target\n\n[Service]\nExecStart=\"{exe}\" start\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n"
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

const BOOT_TASK: &str = "aidev-runner-boot";

/// PowerShell that registers the Windows tasks. Register-ScheduledTask, not schtasks: schtasks /NP still asks for a
/// password (CI, 2026-10-02), and its tasks stop after 72 hours by default — these have no time limit.
pub fn task_script(exe: &str, limited: bool, logon_only: bool, user: &str) -> String {
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let level = if limited { "Limited" } else { "Highest" };
    let mut script = format!(
        "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew\n\
         $a = New-ScheduledTaskAction -Execute {exe} -Argument 'start --hidden'\n\
         $t = New-ScheduledTaskTrigger -AtLogOn -User {user}\n\
         $p = New-ScheduledTaskPrincipal -UserId {user} -LogonType Interactive -RunLevel {level}\n\
         Register-ScheduledTask -TaskName aidev-runner -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null\n",
        exe = q(exe), user = q(user),
    );
    if logon_only {
        script.push_str(&format!("Unregister-ScheduledTask -TaskName {BOOT_TASK} -Confirm:$false -ErrorAction SilentlyContinue\n"));
    } else {
        script.push_str(&format!(
            "$a = New-ScheduledTaskAction -Execute {exe} -Argument 'start --hidden --boot'\n\
             $p = New-ScheduledTaskPrincipal -UserId {user} -LogonType S4U -RunLevel {level}\n\
             Register-ScheduledTask -TaskName {BOOT_TASK} -Action $a -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $p -Settings $s -Force | Out-Null\n\
             Start-ScheduledTask -TaskName {BOOT_TASK}\n",
            exe = q(exe), user = q(user),
        ));
    }
    script.push_str("Start-ScheduledTask -TaskName aidev-runner");
    script
}

/// Windows: re-run `aidev-runner <args>` with administrator rights (one UAC prompt) and wait for it.
#[cfg(windows)]
fn run_elevated(exe: &str, args: &str) -> Result<(), String> {
    let script = format!(
        "$p = Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru\nexit $p.ExitCode",
        exe.replace('\'', "''"), args.replace('\'', "''"),
    );
    run("powershell.exe", &["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::exec::powershell_encoded(&script)])
        .map_err(|_| "관리자 권한 승인이 필요합니다 (UAC에서 '예') — 관리자 권한 없이 쓰려면 `aidev-runner install --limited --logon-only`".to_string())
}

pub fn install(print_only: bool, limited: bool, logon_only: bool, for_user: Option<String>) -> Result<String, String> {
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
            // no console window at sign-in; output to ~/.aidev/runner.log
            let user = for_user.unwrap_or_else(|| format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").unwrap_or_default()).trim_start_matches('\\').to_string());
            let script = task_script(&exe_s, limited, logon_only, &user);
            if print_only { return Ok(script); }
            let needs_admin = !(limited && logon_only);
            #[cfg(windows)]
            if needs_admin && !crate::proc_util::is_elevated() {
                let mut args = vec!["install".to_string(), "--user".into(), format!("\"{user}\"")];
                if limited { args.push("--limited".into()); }
                if logon_only { args.push("--logon-only".into()); }
                run_elevated(&exe_s, &args.join(" "))?;
                return Ok(describe(limited, logon_only, true));
            }
            run("powershell.exe", &["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::exec::powershell_encoded(&script)])
                .map_err(|_| if needs_admin { "작업 등록 실패 — 관리자 권한이 필요합니다".to_string() } else { "작업 등록 실패 (Register-ScheduledTask)".to_string() })?;
            return Ok(describe(limited, logon_only, false));
        }
        other => Err(format!("{other}: 서비스 등록을 지원하지 않습니다 — `aidev-runner start`를 직접 실행하세요")),
    }
}

/// What `install` set up on Windows, in one line.
fn describe(limited: bool, logon_only: bool, via_uac: bool) -> String {
    format!(
        "서비스 설치: {}{}{}",
        if logon_only { "로그인할 때마다 실행" } else { "부팅 직후부터 실행 (로그인 전엔 부팅 작업, 로그인하면 사용자 세션의 러너 — 화면·GUI 포함)" },
        if limited { ", 일반 사용자 권한" } else { ", 관리자 권한" },
        if via_uac { " — 관리자 권한(UAC)으로 등록했습니다" } else { "" },
    )
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
            // the tasks' runners stop with them (as systemctl disable --now / launchctl bootout do); tasks registered
            // with administrator rights can only be removed by an administrator — ask once (UAC) when needed
            let script = format!(
                "foreach ($n in 'aidev-runner', '{BOOT_TASK}') {{ if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {{ Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $n -Confirm:$false }} }}\n\
                 Get-Process aidev-runner -ErrorAction SilentlyContinue | Where-Object {{ $_.Id -ne {pid} }} | Stop-Process -Force -ErrorAction SilentlyContinue",
                pid = std::process::id(),
            );
            let ps = |s: &str| run("powershell.exe", &["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::exec::powershell_encoded(s)]);
            if ps(&script).is_err() {
                #[cfg(windows)]
                {
                    run_elevated(&exe()?.display().to_string(), "uninstall")?;
                    return Ok("서비스(작업 스케줄러 작업)를 제거하고 러너를 멈췄습니다 — 관리자 권한(UAC)으로".into());
                }
                #[cfg(not(windows))]
                return Err("작업 제거 실패".into());
            }
            Ok("서비스(작업 스케줄러 작업)를 제거하고 러너를 멈췄습니다".into())
        }
        other => Err(format!("{other}: 지원하지 않습니다")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_tasks_strong_by_default() {
        let s = super::task_script("C:\\it's\\aidev-runner.exe", false, false, "PC\\me");
        assert!(s.contains("-Execute 'C:\\it''s\\aidev-runner.exe' -Argument 'start --hidden'") && s.contains("-AtLogOn -User 'PC\\me'"));
        assert!(s.contains("-LogonType Interactive -RunLevel Highest") && s.contains("-ExecutionTimeLimit ([TimeSpan]::Zero)"));
        assert!(s.contains("'start --hidden --boot'") && s.contains("-LogonType S4U -RunLevel Highest") && s.contains("-AtStartup"));
        let s = super::task_script("x", true, true, "PC\\me");
        assert!(s.contains("-LogonType Interactive -RunLevel Limited") && !s.contains("S4U") && s.contains("Unregister-ScheduledTask -TaskName aidev-runner-boot"));
    }

    #[test]
    fn service_files_quote_the_path() {
        assert!(super::unit_text("/opt/a b/aidev-runner").contains("ExecStart=\"/opt/a b/aidev-runner\" start"));
        let plist = super::plist_text("/Users/x/bin/aidev-runner", "/Users/x/.aidev/runner.log");
        assert!(plist.contains("<string>/Users/x/bin/aidev-runner</string><string>start</string>"));
    }
}
