//! `install` / `uninstall`: keep the runner running, from boot and with administrator rights by default
//! (`--limited`: the user's normal rights, `--logon-only`: only while signed in).
//!   Linux  — systemd user unit ~/.config/systemd/user/aidev-runner.service (`start --boot`; from boot without a login
//!            by linger) + XDG autostart ~/.config/autostart/aidev-runner.desktop: a desktop login starts the session's
//!            runner (DISPLAY / WAYLAND_DISPLAY / D-Bus: screen, input, status icon), which takes the connection over;
//!            when the session ends the unit's runner takes it back — as on macOS and Windows
//!   macOS  — LaunchAgent ~/Library/LaunchAgents/work.nado.aidev-runner.plist (the session: screen, icon) + LaunchDaemon
//!            /Library/LaunchDaemons/work.nado.aidev-runner-boot.plist (as the user, from boot, `start --boot`: hands over
//!            to the session's runner like the Windows boot task)
//!   Linux / macOS administrator rights: passwordless sudo for the user (/etc/sudoers.d/aidev-runner) — the closest to
//!   Windows' elevated token without running the runner as root. Setting it up (and the LaunchDaemon) asks for the sudo
//!   password once, as Windows asks UAC; without a terminal for that, the rest is still installed and it says so.
//!   Services start `start --service` (a 정지 from the status icon stays) and are restarted only after a failure:
//!   종료 (exit 0) ends the runner for good.
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

/// Where the service runs the runner from (the installers use it too): the downloaded file can be deleted after
/// `install`, and an update replaces this one file.
pub fn installed_path() -> PathBuf {
    config::dir().join("bin").join(if cfg!(windows) { "aidev-runner.exe" } else { "aidev-runner" })
}

/// scripts/sign-macos.sh, run on the copy `install` makes (macOS).
const SIGN_MACOS: &str = include_str!("../scripts/sign-macos.sh");

/// macOS: a runner file made ready to replace the installed one — no quarantine flag, this Mac's stable signature.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn sign_for_this_mac(file: &std::path::Path) -> Result<(), String> {
    quiet("xattr", &["-d", "com.apple.quarantine", &file.display().to_string()]);
    let out = Command::new("bash").args(["-c", SIGN_MACOS, "sign-macos", &file.display().to_string()]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if why.is_empty() { "서명 스크립트 실패 (~/.aidev/signing.log)".into() } else { format!("{why} (~/.aidev/signing.log)") })
}

/// `aidev-runner` from any terminal: ~/.aidev/bin on the PATH.
///   Windows       — the user's Path (registry, kept as REG_EXPAND_SZ; new windows see it)
///   Linux / macOS — a line in the shell start files (zsh, bash, sh, fish), and a link in /usr/local/bin when sudo
///                   needs no password (after the default install) — also for non-interactive shells
/// Kept on `uninstall`: the file stays for a later `install`.
fn register_path(bin: &std::path::Path) -> String {
    let bin_s = bin.display().to_string();
    #[cfg(windows)]
    {
        let script = format!(
            "$d = {q}\n\
             $k = (Get-Item 'HKCU:\\').OpenSubKey('Environment', $true)\n\
             $p = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')\n\
             if (-not (($p -split ';') | Where-Object {{ $_.TrimEnd('\\') -ieq $d }})) {{\n\
               $k.SetValue('Path', ((@($p.TrimEnd(';'), $d) | Where-Object {{ $_ }}) -join ';'), 'ExpandString')\n\
               # any user variable set this way tells open programs (Explorer) to read the environment again\n\
               [Environment]::SetEnvironmentVariable('AIDEV_RUNNER_BIN', $d, 'User')\n\
             }}\n\
             $k.Close()",
            q = format!("'{}'", bin_s.replace('\'', "''")),
        );
        return match powershell(&script, std::time::Duration::from_secs(30)) {
            Ok(()) => format!("PATH 등록: {bin_s} — 새로 연 창에서 `aidev-runner`"),
            Err(e) => format!("! PATH에 등록하지 못했습니다 ({e}) — {bin_s}\\aidev-runner.exe 로 실행하세요"),
        };
    }
    #[cfg(unix)]
    {
        let home = config::home();
        let line = "\n# NadoVibe runner (aidev-runner install)\nexport PATH=\"$HOME/.aidev/bin:$PATH\"\n";
        let shell = std::env::var("SHELL").unwrap_or_default();
        let mut files: Vec<PathBuf> = [".zshrc", ".bashrc", ".bash_profile", ".profile"].iter().map(|f| home.join(f)).filter(|p| p.exists()).collect();
        if !files.iter().any(|p| p.ends_with(".zshrc") || p.ends_with(".bashrc")) {
            // a fresh account: the start file of the login shell
            files.push(home.join(if shell.ends_with("zsh") { ".zshrc" } else if shell.ends_with("bash") { ".bashrc" } else { ".profile" }));
        }
        let mut done = Vec::new();
        for f in &files {
            let text = std::fs::read_to_string(f).unwrap_or_default();
            if text.contains(".aidev/bin") {
                done.push(f.display().to_string());
                continue;
            }
            if std::fs::OpenOptions::new().create(true).append(true).open(f).and_then(|mut h| std::io::Write::write_all(&mut h, line.as_bytes())).is_ok() {
                done.push(f.display().to_string());
            }
        }
        let fish = home.join(".config/fish");
        if fish.is_dir() {
            let conf = fish.join("conf.d/aidev-runner.fish");
            let _ = std::fs::create_dir_all(fish.join("conf.d"));
            if std::fs::write(&conf, "# NadoVibe runner (aidev-runner install)\ncontains $HOME/.aidev/bin $PATH; or set -gx PATH $HOME/.aidev/bin $PATH\n").is_ok() {
                done.push(conf.display().to_string());
            }
        }
        let exe = bin.join("aidev-runner").display().to_string();
        let linked = quiet("sudo", &["-n", "mkdir", "-p", "/usr/local/bin"]) && quiet("sudo", &["-n", "ln", "-sf", &exe, "/usr/local/bin/aidev-runner"]);
        return format!(
            "PATH 등록: {bin_s} ({}){} — 새로 연 터미널에서 `aidev-runner`",
            done.join(", "),
            if linked { ", /usr/local/bin/aidev-runner" } else { "" }
        );
    }
    #[allow(unreachable_code)]
    String::new()
}

/// `install` from a downloaded file: copies itself to `installed_path()` (true) — or is already there (false).
fn place_self() -> Result<(PathBuf, bool), String> {
    let me = exe()?;
    let target = installed_path();
    if target.exists() && std::fs::canonicalize(&me).ok() == std::fs::canonicalize(&target).ok() {
        return Ok((target, false));
    }
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = target.with_extension("new");
    std::fs::copy(&me, &tmp).map_err(|e| format!("{} → {}: {e}", me.display(), tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    // macOS: a downloaded file carries the quarantine flag, which would stop launchd from running the copy; and its
    // CI signature is not this Mac's: Screen Recording / Accessibility given to the installed runner would not apply to
    // it (the capture shows only the wallpaper, no windows). Sign the copy — before it replaces a running file — with
    // this Mac's stable identity, as the installer does.
    if cfg!(target_os = "macos") {
        if let Err(why) = sign_for_this_mac(&tmp) {
            eprintln!("! 이 Mac의 고정 서명을 입히지 못했습니다 — macOS가 화면 기록 권한을 다시 물을 수 있습니다: {why}");
        }
    }
    // Windows: every runner of the installed file — a task's, or one started by hand (`aidev-runner`, a double click)
    // — holds it open: stop them and wait until they are gone. The swap renames the file aside anyway (a running .exe
    // can be renamed, not overwritten), so one that does not stop does not block the install.
    #[cfg(windows)]
    {
        let script = format!(
            "foreach ($n in 'aidev-runner', '{BOOT_TASK}') {{ Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }}\n\
             $ids = @(Get-CimInstance Win32_Process -Filter \"Name='aidev-runner.exe'\" | Where-Object {{ $_.ExecutablePath -eq '{path}' -and $_.ProcessId -ne {me} }} | ForEach-Object {{ $_.ProcessId }})\n\
             foreach ($i in $ids) {{ Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }}\n\
             if ($ids) {{ Wait-Process -Id $ids -Timeout 10 -ErrorAction SilentlyContinue }}",
            path = target.display().to_string().replace('\'', "''"),
            me = std::process::id(),
        );
        let _ = powershell(&script, std::time::Duration::from_secs(30));
    }
    crate::update::swap(&tmp, &target).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("{e} — 실행 중인 러너를 멈춘 뒤 다시 하세요") })?;
    Ok((target, true))
}

fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(cmd).args(args).status().map_err(|e| format!("{cmd}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("{cmd} {} 실패 ({status})", args.join(" "))) }
}

/// PowerShell with a time limit (Windows): no stdin, so nothing can wait on it; killed after `limit`.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell(script: &str, limit: std::time::Duration) -> Result<(), String> {
    use crate::proc_util::NoWindow;
    let mut child = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::exec::powershell_encoded(script)])
        .stdin(std::process::Stdio::null())
        .no_window()
        .spawn()
        .map_err(|e| format!("powershell: {e}"))?;
    let deadline = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("exit {}", status.code().unwrap_or(-1))),
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(200)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timeout".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// The same, quietly (expected failures such as "not loaded").
fn quiet(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd).args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
}

fn unsafe_uid() -> String {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }.to_string()
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

/// `systemctl --user …` that also works without a login session's environment (SSH, a fresh linger): the user
/// manager's runtime folder is /run/user/<uid>, and its bus may take a moment to come up after enable-linger.
#[cfg(unix)]
fn systemctl_user(args: &[&str]) -> Result<(), String> {
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| format!("/run/user/{}", unsafe { libc::getuid() }));
    for _ in 0..20 {
        if std::path::Path::new(&dir).join("bus").exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let status = Command::new("systemctl").arg("--user").args(args).env("XDG_RUNTIME_DIR", &dir).status().map_err(|e| format!("systemctl: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("systemctl --user {} 실패 ({status})", args.join(" "))) }
}
#[cfg(not(unix))]
fn systemctl_user(_: &[&str]) -> Result<(), String> {
    Err("systemd 없음".into())
}

const SUDOERS: &str = "/etc/sudoers.d/aidev-runner";
const BOOT_LABEL: &str = "work.nado.aidev-runner-boot";
const BOOT_PLIST: &str = "/Library/LaunchDaemons/work.nado.aidev-runner-boot.plist";

fn user_name() -> String {
    std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_default()
}

/// `sudo` for one administrative step; asks for the password on the terminal (once — sudo caches it).
fn sudo(args: &[&str]) -> Result<(), String> {
    run("sudo", args).map_err(|_| "sudo 실패 (비밀번호 입력이 필요합니다 — 터미널에서 `aidev-runner install`)".into())
}

/// A file written to a root-owned place through sudo (`install -m`), from a temporary copy.
fn sudo_write(dest: &str, text: &str, mode: &str) -> Result<(), String> {
    let tmp = std::env::temp_dir().join(format!("aidev-runner-{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    let owner = if cfg!(target_os = "macos") { "root:wheel" } else { "root:root" };
    let (o, g) = owner.split_once(':').unwrap_or(("root", "root"));
    let r = sudo(&["install", "-m", mode, "-o", o, "-g", g, &tmp.display().to_string(), dest]);
    let _ = std::fs::remove_file(&tmp);
    r
}

pub fn sudoers_text(user: &str) -> String {
    format!("# NadoVibe runner (`aidev-runner install`; `install --limited` or `uninstall` removes it): agents run administrator\n# commands on this machine without a password, as on Windows with the runner's elevated token\n{user} ALL=(ALL) NOPASSWD: ALL\n")
}

/// Unix administrator rights: passwordless sudo for this user (checked with visudo before it is put in place).
fn grant_sudo(user: &str) -> Result<(), String> {
    if user.is_empty() || user == "root" {
        return Ok(());
    }
    let tmp = std::env::temp_dir().join(format!("aidev-sudoers-{}", std::process::id()));
    std::fs::write(&tmp, sudoers_text(user)).map_err(|e| e.to_string())?;
    let ok = quiet("visudo", &["-cf", &tmp.display().to_string()]);
    let _ = std::fs::remove_file(&tmp);
    if !ok {
        return Err("sudoers 문법 확인 실패".into());
    }
    sudo_write(SUDOERS, &sudoers_text(user), "0440")
}

fn revoke_sudo() -> Result<(), String> {
    // /etc/sudoers.d is root-only on Ubuntu, so the file cannot be seen from here (CI 2026-10-02: --limited left it in
    // place). While our rule is there sudo needs no password; when sudo -n fails there is no rule of ours to remove.
    if quiet("sudo", &["-n", "rm", "-f", SUDOERS]) {
        return Ok(());
    }
    if std::path::Path::new(SUDOERS).exists() {
        return sudo(&["rm", "-f", SUDOERS]);
    }
    Ok(())
}

pub fn boot_plist_text(exe: &str, user: &str, home: &str, log: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{BOOT_LABEL}</string>
  <key>UserName</key><string>{user}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>{home}</string><key>USER</key><string>{user}</string></dict>
  <key>ProgramArguments</key><array><string>{exe}</string><string>start</string><string>--boot</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#
    )
}

pub fn unit_text(exe: &str) -> String {
    format!(
        "[Unit]\nDescription=NadoVibe runner\nAfter=network-online.target\n\n[Service]\nExecStart=\"{exe}\" start --service --boot\nRestart=on-failure\nRestartSec=5\nRestartPreventExitStatus=3\n\n[Install]\nWantedBy=default.target\n"
    )
}

/// XDG autostart entry: the desktop session's runner (it has the session's display and bus; SSH logins do not run it).
pub fn autostart_text(exe: &str, log: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=NadoVibe runner\nComment=NadoVibe 원격 실행 러너 (화면·상태 아이콘)\nExec=\"{exe}\" start --service --log \"{log}\"\nIcon=utilities-terminal\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\nX-GNOME-Autostart-Delay=3\n"
    )
}

pub fn plist_text(exe: &str, log: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>work.nado.aidev-runner</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>start</string><string>--service</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
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
    // the UAC prompt is on the secure desktop: a remote viewer or a VM window may not show it — say so, and give up
    // after a while instead of waiting forever
    println!("관리자 확인 창(UAC)이 떴습니다 — '예'를 누르세요 (2분 안에 응답이 없으면 취소합니다)");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $p = Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs -WindowStyle Hidden -PassThru\n\
         if (-not $p.WaitForExit(170000)) {{ exit 124 }}\n\
         exit $p.ExitCode",
        exe.replace('\'', "''"), args.replace('\'', "''"),
    );
    powershell(&script, std::time::Duration::from_secs(180)).map_err(|e| {
        if e == "timeout" { "관리자 확인 창(UAC)에 응답이 없어 취소했습니다 — 화면에 UAC 창이 보이는 곳(이 PC 앞)에서 다시 실행하세요".to_string() }
        else { "관리자 권한 승인이 필요합니다 (UAC에서 '예') — 관리자 권한 없이 쓰려면 `aidev-runner install --limited --logon-only`".to_string() }
    })
}

pub fn install(print_only: bool, limited: bool, logon_only: bool, for_user: Option<String>) -> Result<String, String> {
    config::load()?; // must be paired first
    // the service always runs the copy in ~/.aidev/bin — except on Windows before the UAC re-run, which places it itself
    #[cfg(windows)]
    let elevating = !(limited && logon_only) && !crate::proc_util::is_elevated();
    #[cfg(not(windows))]
    let elevating = false;
    let (exe, copied) = if print_only { (installed_path(), false) } else if elevating { (exe()?, false) } else { place_self()? };
    let placed = if copied { format!("\n설치 위치: {} — 받은 파일은 지워도 됩니다", exe.display()) } else { String::new() };
    let exe_s = exe.display().to_string();
    let home = config::home();
    let bin = installed_path().parent().map(|p| p.to_path_buf()).unwrap_or_default();
    match std::env::consts::OS {
        "linux" => {
            let dir = home.join(".config/systemd/user");
            let unit = dir.join("aidev-runner.service");
            let text = unit_text(&exe_s);
            let autostart = home.join(".config/autostart/aidev-runner.desktop");
            let desktop = autostart_text(&exe_s, &config::dir().join("runner.log").display().to_string());
            if print_only { return Ok(format!("# {}\n{text}\n# {}\n{desktop}", unit.display(), autostart.display())); }
            let user = user_name();
            let mut notes = Vec::new();
            if !logon_only {
                // from boot, without a login: the user's services keep running (linger) — first, as it also starts the
                // user's service manager on a machine nobody is logged in to
                let linger = quiet("loginctl", &["enable-linger", &user]) || sudo(&["loginctl", "enable-linger", &user]).is_ok();
                notes.push(if linger { "부팅 직후부터 실행 (로그인하지 않아도: linger)".to_string() } else { "! 부팅 때 실행(linger)을 켜지 못했습니다 — sudo loginctl enable-linger $USER".to_string() });
            }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&unit, text).map_err(|e| e.to_string())?;
            systemctl_user(&["daemon-reload"])?;
            systemctl_user(&["enable", "aidev-runner.service"])?;
            systemctl_user(&["restart", "aidev-runner.service"])?;
            notes.insert(0, format!("systemd 사용자 서비스 등록: {} (로그: ~/.aidev/runner.log)", unit.display()));
            if let Some(dir) = autostart.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
            std::fs::write(&autostart, desktop).map_err(|e| e.to_string())?;
            notes.push(format!("데스크탑 로그인 때 세션 러너 시작: {} — 화면·원격 제어·상태 아이콘", autostart.display()));
            // installed from inside a desktop session: its runner now, not at the next login
            if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some() {
                let log = config::dir().join("runner.log");
                if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&log) {
                    let mut cmd = Command::new(&exe_s);
                    cmd.args(["start", "--service"]).stdin(std::process::Stdio::null())
                        .stdout(f.try_clone().map(std::process::Stdio::from).unwrap_or(std::process::Stdio::null())).stderr(std::process::Stdio::from(f));
                    // its own process group: closing the terminal `install` ran in does not take it down
                    #[cfg(unix)]
                    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
                    let _ = cmd.spawn();
                }
            }
            notes.push(admin_rights(limited, &user));
            notes.push(register_path(&bin));
            Ok(format!("{}{placed}", notes.join("\n")))
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
            quiet("launchctl", &["bootout", &format!("gui/{uid}"), &plist.display().to_string()]);
            // launchd sometimes refuses a bootstrap right after the bootout ("Bootstrap failed: 5"): retry a few times
            let domain = format!("gui/{uid}");
            if !(0..5).any(|i| {
                if i > 0 { std::thread::sleep(std::time::Duration::from_secs(1)); }
                quiet("launchctl", &["bootstrap", &domain, &plist.display().to_string()])
            }) {
                run("launchctl", &["bootstrap", &domain, &plist.display().to_string()])?;
            }
            let user = user_name();
            let mut notes = vec![format!("LaunchAgent 등록: {} (로그: {})", plist.display(), log.display())];
            if logon_only {
                if std::path::Path::new(BOOT_PLIST).exists() {
                    quiet("sudo", &["launchctl", "bootout", &format!("system/{BOOT_LABEL}")]);
                    let _ = sudo(&["rm", "-f", BOOT_PLIST]);
                }
                notes.push("로그인한 동안만 실행".into());
            } else {
                // from boot, as this user, before anyone logs in; hands over to the LaunchAgent's runner at login
                let daemon = boot_plist_text(&exe_s, &user, &home.display().to_string(), &log.display().to_string());
                let r = sudo_write(BOOT_PLIST, &daemon, "0644").and_then(|_| {
                    quiet("sudo", &["launchctl", "bootout", &format!("system/{BOOT_LABEL}")]);
                    sudo(&["launchctl", "bootstrap", "system", BOOT_PLIST])
                });
                notes.push(match r {
                    Ok(()) => "부팅 직후부터 실행 (로그인 전엔 LaunchDaemon, 로그인하면 사용자 세션의 러너 — 화면·아이콘 포함)".into(),
                    Err(e) => format!("! 부팅 때 실행(LaunchDaemon)을 등록하지 못했습니다: {e}"),
                });
            }
            notes.push(admin_rights(limited, &user));
            notes.push(register_path(&bin));
            Ok(format!("{}{placed}", notes.join("\n")))
        }
        "windows" => {
            // no console window at sign-in; output to ~/.aidev/runner.log
            let rerun = for_user.is_some();   // the UAC re-run: the Path was set by the user's own `install`
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
                return Ok(format!("{}\n{}", describe(limited, logon_only, true), register_path(&bin)));
            }
            println!("작업 스케줄러에 등록하는 중…");
            powershell(&script, std::time::Duration::from_secs(90))
                .map_err(|e| if e == "timeout" { "작업 스케줄러가 90초 안에 응답하지 않았습니다".to_string() } else if needs_admin { "작업 등록 실패 — 관리자 권한이 필요합니다".to_string() } else { "작업 등록 실패 (Register-ScheduledTask)".to_string() })?;
            let path_note = if rerun { String::new() } else { format!("\n{}", register_path(&bin)) };
            return Ok(format!("{}{path_note}{placed}", describe(limited, logon_only, false)));
        }
        other => Err(format!("{other}: 서비스 등록을 지원하지 않습니다 — `aidev-runner start`를 직접 실행하세요")),
    }
}

/// Linux / macOS: passwordless sudo by default, removed with --limited.
fn admin_rights(limited: bool, user: &str) -> String {
    if limited {
        match revoke_sudo() {
            Ok(()) => "일반 사용자 권한 (--limited)".into(),
            Err(e) => format!("! 관리자 권한 설정을 지우지 못했습니다: {e}"),
        }
    } else {
        match grant_sudo(user) {
            Ok(()) => format!("관리자 권한: {user}의 sudo를 비밀번호 없이 ({SUDOERS})"),
            Err(e) => format!("! 관리자 권한(비밀번호 없는 sudo)을 설정하지 못했습니다: {e}"),
        }
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
            let _ = systemctl_user(&["disable", "--now", "aidev-runner.service"]);
            let _ = std::fs::remove_file(home.join(".config/systemd/user/aidev-runner.service"));
            let _ = std::fs::remove_file(home.join(".config/autostart/aidev-runner.desktop"));
            let _ = systemctl_user(&["daemon-reload"]);
            // the desktop session's runner (autostart) is not the unit's: stop it too
            quiet("pkill", &["-u", &unsafe_uid(), "-f", &format!("{} start", exe()?.display())]);
            let sudo_note = revoke_sudo().err().map(|e| format!("\n! 관리자 권한 설정({SUDOERS})을 지우지 못했습니다: {e}")).unwrap_or_default();
            Ok(format!("systemd 사용자 서비스를 제거했습니다{sudo_note}"))
        }
        "macos" => {
            let plist = home.join("Library/LaunchAgents/work.nado.aidev-runner.plist");
            let uid = String::from_utf8_lossy(&Command::new("id").arg("-u").output().map_err(|e| e.to_string())?.stdout).trim().to_string();
            quiet("launchctl", &["bootout", &format!("gui/{uid}"), &plist.display().to_string()]);
            let _ = std::fs::remove_file(&plist);
            let mut note = String::new();
            if std::path::Path::new(BOOT_PLIST).exists() {
                quiet("sudo", &["launchctl", "bootout", &format!("system/{BOOT_LABEL}")]);
                if let Err(e) = sudo(&["rm", "-f", BOOT_PLIST]) { note.push_str(&format!("\n! LaunchDaemon을 지우지 못했습니다: {e}")); }
            }
            if let Err(e) = revoke_sudo() { note.push_str(&format!("\n! 관리자 권한 설정({SUDOERS})을 지우지 못했습니다: {e}")); }
            Ok(format!("LaunchAgent·LaunchDaemon을 제거하고 러너를 멈췄습니다{note}"))
        }
        "windows" => {
            // the tasks' runners stop with them (as systemctl disable --now / launchctl bootout do). Tasks registered with
            // administrator rights can only be removed by an administrator: a failure (access denied) must not pass as
            // done — then ask once (UAC). Only service runners (`… start …`) are stopped, never this process or its parent.
            let script = format!(
                "$ErrorActionPreference = 'Stop'\n\
                 foreach ($n in 'aidev-runner', '{BOOT_TASK}') {{\n\
                   if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {{ Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $n -Confirm:$false }}\n\
                 }}\n\
                 Get-CimInstance Win32_Process -Filter \"Name='aidev-runner.exe'\" | Where-Object {{ $_.CommandLine -match ' start( |$)' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
            );
            println!("서비스(작업 스케줄러 작업)를 지우는 중…");
            match powershell(&script, std::time::Duration::from_secs(60)) {
                Ok(()) => Ok("서비스(작업 스케줄러 작업)를 제거하고 러너를 멈췄습니다".into()),
                Err(e) if e == "timeout" => Err("작업 스케줄러가 60초 안에 응답하지 않았습니다 — 작업 스케줄러에서 aidev-runner 작업을 직접 지우세요".into()),
                Err(_) => {
                    #[cfg(windows)]
                    {
                        if crate::proc_util::is_elevated() {
                            return Err("작업을 지우지 못했습니다 — 작업 스케줄러에서 aidev-runner, aidev-runner-boot 작업을 확인하세요".into());
                        }
                        run_elevated(&exe()?.display().to_string(), "uninstall")?;
                        Ok("서비스(작업 스케줄러 작업)를 제거하고 러너를 멈췄습니다 — 관리자 권한(UAC)으로".into())
                    }
                    #[cfg(not(windows))]
                    Err("작업 제거 실패".into())
                }
            }
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
        let unit = super::unit_text("/opt/a b/aidev-runner");
        assert!(unit.contains("ExecStart=\"/opt/a b/aidev-runner\" start --service --boot") && unit.contains("Restart=on-failure") && unit.contains("RestartPreventExitStatus=3"));
        let auto = super::autostart_text("/opt/a b/aidev-runner", "/home/x/.aidev/runner.log");
        assert!(auto.contains("Exec=\"/opt/a b/aidev-runner\" start --service --log \"/home/x/.aidev/runner.log\"") && auto.starts_with("[Desktop Entry]"));
        let plist = super::plist_text("/Users/x/bin/aidev-runner", "/Users/x/.aidev/runner.log");
        assert!(plist.contains("<string>/Users/x/bin/aidev-runner</string><string>start</string><string>--service</string>"));
        assert!(plist.contains("<key>SuccessfulExit</key><false/>"), "종료 (exit 0) is not restarted");
        let boot = super::boot_plist_text("/Users/x/bin/aidev-runner", "x", "/Users/x", "/Users/x/.aidev/runner.log");
        assert!(boot.contains("<key>UserName</key><string>x</string>") && boot.contains("<string>--boot</string>") && boot.contains("<key>HOME</key><string>/Users/x</string>"));
        assert_eq!(super::sudoers_text("dev").lines().last(), Some("dev ALL=(ALL) NOPASSWD: ALL"));
    }
}
