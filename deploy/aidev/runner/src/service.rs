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

/// What `install` adds to the shell start files (`purge` takes exactly this out again).
#[cfg_attr(not(unix), allow(dead_code))]
const PATH_LINE: &str = "\n# NadoVibe runner (aidev-runner install)\nexport PATH=\"$HOME/.aidev/bin:$PATH\"\n";

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
        let line = PATH_LINE;
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
        let linked = if crate::proc_util::is_elevated() {
            quiet("mkdir", &["-p", "/usr/local/bin"]) && quiet("ln", &["-sf", &exe, "/usr/local/bin/aidev-runner"])
        } else {
            quiet("sudo", &["-n", "mkdir", "-p", "/usr/local/bin"]) && quiet("sudo", &["-n", "ln", "-sf", &exe, "/usr/local/bin/aidev-runner"])
        };
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
pub(crate) fn quiet(cmd: &str, args: &[&str]) -> bool {
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

pub(crate) fn user_name() -> String {
    let env = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_default();
    if !env.is_empty() {
        return env;
    }
    // no USER (a container, an init script, cron): the account of this process
    #[cfg(unix)]
    unsafe {
        let pw = libc::getpwuid(libc::geteuid());
        if !pw.is_null() && !(*pw).pw_name.is_null() {
            return std::ffi::CStr::from_ptr((*pw).pw_name).to_string_lossy().into_owned();
        }
    }
    env
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
pub(crate) fn grant_sudo(user: &str) -> Result<(), String> {
    if user.is_empty() || user == "root" {
        return Ok(());
    }
    let tmp = std::env::temp_dir().join(format!("aidev-sudoers-{}", std::process::id()));
    std::fs::write(&tmp, sudoers_text(user)).map_err(|e| e.to_string())?;
    // visudo lives in /usr/sbin, often not on a normal user's PATH (Debian); BusyBox systems have none — the text is fixed
    let ok = which("visudo").map_or(true, |visudo| quiet(&visudo, &["-cf", &tmp.display().to_string()]));
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

/// Windows "시작 앱" (Settings → 앱 → 시작 프로그램, Task Manager's startup tab) lists the Run key and the Startup folder,
/// never scheduled tasks — so the runner was missing there (2026-10-07). This entry shows it and, at sign-in, starts
/// the sign-in task (elevated without a UAC prompt; nothing happens when it already runs). conhost --headless: no
/// console window flashes. The task's own AtLogOn trigger stays: the entry is the visible, second way in.
pub const STARTUP_NAME: &str = "NadoVibe Runner";
const RUN_KEY_PS: &str = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_VALUE_PS: &str = "('\"' + $env:SystemRoot + '\\System32\\conhost.exe\" --headless \"' + $env:SystemRoot + '\\System32\\schtasks.exe\" /Run /TN aidev-runner')";

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
    script.push_str(&format!("Set-ItemProperty -Path '{RUN_KEY_PS}' -Name '{STARTUP_NAME}' -Value {STARTUP_VALUE_PS}\n"));
    script.push_str("Start-ScheduledTask -TaskName aidev-runner");
    script
}

/// Windows, the sign-in runner of an installed copy: puts the "시작 앱" entry back when it is missing (installs from
/// before 0.18.4, or one removed by hand and then reinstalled). HKCU needs no administrator. Quiet on failure.
#[cfg(windows)]
pub fn ensure_startup_entry() {
    use crate::proc_util::NoWindow;
    let run_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let quiet = |args: &[&str]| Command::new("reg.exe").args(args).no_window().stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    let task = Command::new("schtasks.exe").args(["/Query", "/TN", "aidev-runner"]).no_window().stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if !task || quiet(&["query", run_key, "/v", STARTUP_NAME]) { return; }
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let value = format!(r#""{sys}\System32\conhost.exe" --headless "{sys}\System32\schtasks.exe" /Run /TN aidev-runner"#);
    if quiet(&["add", run_key, "/v", STARTUP_NAME, "/t", "REG_SZ", "/d", &value, "/f"]) { eprintln!("시작 앱에 '{STARTUP_NAME}'을(를) 등록했습니다"); }
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
    if cfg!(target_os = "android") {
        return Err("Android에서는 NadoVibe 러너 앱이 서비스를 맡습니다 (앱 → 시작, 부팅 때 자동 시작)".into());
    }
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
            let user = user_name();
            // root (an embedded board, a container) or an init system other than systemd (OpenRC, OpenWrt's procd,
            // SysV / BusyBox init): a system service — the user service and its linger are systemd's alone
            if crate::proc_util::is_elevated() || init_system() != Init::Systemd || which("systemctl").is_none() {
                if print_only { return Ok(system_service_text(init_system(), &exe_s, &user)); }
                let mut notes = install_system(&exe_s, &user)?;
                if logon_only { notes.push("--logon-only는 systemd 사용자 서비스에만 해당합니다 — 부팅 때부터 실행합니다".into()); }
                if !crate::proc_util::is_elevated() { notes.push(admin_rights(limited, &user)); }
                notes.push(register_path(&bin));
                return Ok(format!("{}{placed}", notes.join("\n")));
            }
            // an earlier install as a system service (root, before this PC had a user manager): one runner only
            let mut notes = remove_system(true);
            let dir = home.join(".config/systemd/user");
            let unit = dir.join("aidev-runner.service");
            let text = unit_text(&exe_s);
            let autostart = home.join(".config/autostart/aidev-runner.desktop");
            let desktop = autostart_text(&exe_s, &config::dir().join("runner.log").display().to_string());
            if print_only { return Ok(format!("# {}\n{text}\n# {}\n{desktop}", unit.display(), autostart.display())); }
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
            let user_unit = home.join(".config/systemd/user/aidev-runner.service").exists();
            if user_unit {
                let _ = systemctl_user(&["disable", "--now", "aidev-runner.service"]);
                let _ = std::fs::remove_file(home.join(".config/systemd/user/aidev-runner.service"));
                let _ = systemctl_user(&["daemon-reload"]);
            }
            let _ = std::fs::remove_file(home.join(".config/autostart/aidev-runner.desktop"));
            // the desktop session's runner (autostart) is not the unit's: stop it too
            quiet("pkill", &["-u", &unsafe_uid(), "-f", &format!("{} start", exe()?.display())]);
            let system = remove_system(true);
            let sudo_note = revoke_sudo().err().map(|e| format!("\n! 관리자 권한 설정({SUDOERS})을 지우지 못했습니다: {e}")).unwrap_or_default();
            let mut what = system;
            if user_unit { what.insert(0, "systemd 사용자 서비스를 제거했습니다".into()); }
            if what.is_empty() { what.push("등록된 서비스가 없습니다".into()); }
            let what = what.join("\n");
            Ok(format!("{what}{sudo_note}"))
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
                 Remove-ItemProperty -Path '{RUN_KEY_PS}' -Name '{STARTUP_NAME}' -ErrorAction SilentlyContinue\n\
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

/// The target was deleted in the workbench (0.20.0): everything `install` set up goes — the services and their
/// sign-in / boot entries, the PATH entries, the passwordless sudo rule, macOS's permission records — then the runner's
/// folder (settings and token, logs, the installed runner, macOS's signing keychain) and an empty ~/aidev-work.
/// This runner keeps running while it does (stopping its own service would end it half-way) and then exits 0, which
/// no service manager starts again; this PC's other runner (boot-time or session) gets the same answer when it
/// connects and removes itself the same way. Synced projects, linger and device groups stay. The lines say what went.
/// What belongs to the whole machine (a system / boot service, the sudo rule, permission records, the Windows tasks)
/// goes only when it was made for this home's installed runner: another installation on the PC is never touched.
pub fn purge() -> Vec<String> {
    let home = config::home();
    let exe = installed_path();
    let installed = exe.exists();
    let ours = |file: &str| std::fs::read_to_string(file).is_ok_and(|t| t.contains(&exe.display().to_string()));
    let mut notes = Vec::new();
    match std::env::consts::OS {
        "linux" => {
            let unit = home.join(".config/systemd/user/aidev-runner.service");
            if unit.exists() {
                let _ = systemctl_user(&["disable", "aidev-runner.service"]);
                let _ = std::fs::remove_file(&unit);
                let _ = systemctl_user(&["daemon-reload"]);
                notes.push("systemd 사용자 서비스를 제거했습니다".into());
            }
            if std::fs::remove_file(home.join(".config/autostart/aidev-runner.desktop")).is_ok() {
                notes.push("데스크탑 로그인 자동 시작을 지웠습니다".into());
            }
            let cron = Command::new("crontab").arg("-l").stderr(std::process::Stdio::null()).output()
                .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).lines().any(|l| cron_ours(l) && l.contains(&exe.display().to_string())));
            if cron || [SYSTEM_UNIT, INIT_SCRIPT, RCS_SCRIPT].into_iter().any(ours) {
                notes.extend(remove_system(false));
            }
        }
        "macos" => {
            if std::fs::remove_file(home.join("Library/LaunchAgents/work.nado.aidev-runner.plist")).is_ok() {
                notes.push("LaunchAgent를 지웠습니다".into());
            }
            if ours(BOOT_PLIST) {
                notes.push(if quiet_root(&["rm", "-f", BOOT_PLIST]) { "LaunchDaemon(부팅 실행)을 지웠습니다".into() } else { format!("! {BOOT_PLIST}을(를) 지우지 못했습니다 (관리자 권한 필요)") });
            }
            // Screen Recording / Accessibility given to the runner (its signing identifier)
            if installed {
                for service in ["ScreenCapture", "Accessibility"] {
                    quiet("tccutil", &["reset", service, "work.nado.aidev-runner"]);
                }
            }
        }
        "windows" => {
            // the tasks are only unregistered, not stopped: this runner is one of them
            let script = format!(
                "Remove-ItemProperty -Path '{RUN_KEY_PS}' -Name '{STARTUP_NAME}' -ErrorAction SilentlyContinue\n\
                 $exe = '{exe_q}'\n\
                 $d = Split-Path -Parent $exe\n\
                 $k = (Get-Item 'HKCU:\\').OpenSubKey('Environment', $true)\n\
                 $parts = @(([string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';')\n\
                 $keep = @($parts | Where-Object {{ $_.TrimEnd('\\') -ine $d }})\n\
                 if ($keep.Count -ne $parts.Count) {{ $k.SetValue('Path', ($keep -join ';'), 'ExpandString') }}\n\
                 $k.Close()\n\
                 [Environment]::SetEnvironmentVariable('AIDEV_RUNNER_BIN', $null, 'User')\n\
                 $failed = 0\n\
                 foreach ($n in 'aidev-runner', '{BOOT_TASK}') {{\n\
                   $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue\n\
                   if ($t -and $t.Actions[0].Execute -ieq $exe) {{ try {{ Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop }} catch {{ $failed = 1 }} }}\n\
                 }}\n\
                 exit $failed",
                exe_q = exe.display().to_string().replace('\'', "''"),
            );
            notes.push(match powershell(&script, std::time::Duration::from_secs(60)) {
                Ok(()) => "작업 스케줄러 작업·시작 앱·PATH 등록을 지웠습니다".into(),
                Err(e) => format!("! 작업 스케줄러 작업을 모두 지우지 못했습니다 ({e}) — 작업 스케줄러에서 aidev-runner, aidev-runner-boot을 지우세요"),
            });
        }
        _ => {}
    }
    #[cfg(unix)]
    if !cfg!(target_os = "android") {
        notes.extend(unregister_path());
        // last: the steps above may need the passwordless sudo it removes
        if installed {
            if let Err(e) = revoke_sudo() { notes.push(format!("! 관리자 권한 설정({SUDOERS})을 지우지 못했습니다: {e}")); }
        }
    }
    notes.push(remove_runner_files());
    notes
}

/// `register_path` undone: our lines in the shell start files, the fish file, the /usr/local/bin link to our runner.
#[cfg(unix)]
fn unregister_path() -> Vec<String> {
    let home = config::home();
    let mut notes = Vec::new();
    for f in [".zshrc", ".bashrc", ".bash_profile", ".profile"].iter().map(|f| home.join(f)) {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        if text.contains(PATH_LINE) && std::fs::write(&f, text.replace(PATH_LINE, "")).is_ok() {
            notes.push(format!("PATH 줄을 지웠습니다: {}", f.display()));
        }
    }
    let _ = std::fs::remove_file(home.join(".config/fish/conf.d/aidev-runner.fish"));
    let link = "/usr/local/bin/aidev-runner";
    if std::fs::read_link(link).is_ok_and(|to| to == installed_path()) {
        notes.push(if quiet_root(&["rm", "-f", link]) { format!("{link} 링크를 지웠습니다") } else { format!("! {link}을(를) 지우지 못했습니다") });
    }
    notes
}

/// The runner's folder: ~/.aidev whole; a folder given by AIDEV_RUNNER_HOME may hold other things, so only the
/// runner's own files there. Windows cannot delete the running runner or its open log: a hidden PowerShell does it
/// once this process has ended.
fn remove_runner_files() -> String {
    let dir = config::dir();
    let paths: Vec<PathBuf> = if dir == config::home().join(".aidev") {
        vec![dir.clone()]
    } else {
        ["runner.toml", "runner.log", "state", "paused", "updating", "handoff", "boot-holder", "runner.lock", "supervise.pid", "bin", "adapters"].iter().map(|f| dir.join(f)).collect()
    };
    // pairing creates ~/aidev-work; it goes only when nothing was ever synced into it
    let _ = std::fs::remove_dir(config::default_root());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED: u32 = 0x0000_0200 | crate::proc_util::CREATE_NO_WINDOW;   // CREATE_NEW_PROCESS_GROUP, no window
        const BREAKAWAY: u32 = 0x0100_0000;   // CREATE_BREAKAWAY_FROM_JOB: outlives the task's job when it allows it
        let list = paths.iter().map(|p| format!("'{}'", p.display().to_string().replace('\'', "''"))).collect::<Vec<_>>().join(", ");
        let script = format!("Wait-Process -Id {} -Timeout 120 -ErrorAction SilentlyContinue\nStart-Sleep -Seconds 2\nRemove-Item -LiteralPath {list} -Recurse -Force -ErrorAction SilentlyContinue", std::process::id());
        let encoded = crate::exec::powershell_encoded(&script);
        let spawn = |flags: u32| {
            Command::new("powershell.exe")
                .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded])
                // nothing of ours inherited: an open log handle would keep the file
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                .creation_flags(flags)
                .spawn()
        };
        match spawn(DETACHED | BREAKAWAY).or_else(|_| spawn(DETACHED)) {
            Ok(_) => format!("러너가 끝나면 지웁니다: {}", dir.display()),
            Err(e) => format!("! {}을(를) 지우지 못했습니다 ({e}) — 직접 지우세요", dir.display()),
        }
    }
    #[cfg(not(windows))]
    {
        for p in &paths {
            let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
        }
        if dir.exists() && paths.contains(&dir) { format!("! {}을(를) 다 지우지 못했습니다", dir.display()) } else { format!("지웠습니다: {}", dir.display()) }
    }
}

// ---- Linux system services: root, OpenRC, procd, SysV / BusyBox init, cron (embedded boards, containers) ---------
// They run `aidev-runner supervise` (systemd: `start` itself, it restarts on failure), as the installing user, from boot.
// Writing them needs root: as root directly, else through sudo (the password asked once). With no init system to
// register with — or no way to become root — cron @reboot, and the runner started now.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Init {
    Systemd,
    OpenRc,
    Procd,
    SysV,
    Cron,
}

const SYSTEM_UNIT: &str = "/etc/systemd/system/aidev-runner.service";
const INIT_SCRIPT: &str = "/etc/init.d/aidev-runner";
/// BusyBox / Buildroot init: its rcS runs /etc/init.d/S??* in order
const RCS_SCRIPT: &str = "/etc/init.d/S99aidev-runner";
/// Our crontab line: `@reboot '<…>/aidev-runner' supervise …` (the path quoted).
fn cron_ours(line: &str) -> bool {
    line.contains("aidev-runner") && line.contains(" supervise")
}

pub fn init_system() -> Init {
    let p = |s: &str| std::path::Path::new(s).exists();
    if p("/run/systemd/system") {
        Init::Systemd
    } else if p("/sbin/procd") && p("/etc/rc.common") {
        Init::Procd
    } else if (p("/sbin/openrc-run") || p("/usr/sbin/openrc-run")) && p("/run/openrc/softlevel") {
        // installed and booted (a container with OpenRC's files but no OpenRC running falls through)
        Init::OpenRc
    } else if p("/etc/init.d") {
        Init::SysV
    } else {
        Init::Cron
    }
}

pub fn init_label(init: Init) -> &'static str {
    match init {
        Init::Systemd => "systemd 시스템 서비스",
        Init::OpenRc => "OpenRC 서비스",
        Init::Procd => "procd 서비스 (OpenWrt)",
        Init::SysV => "SysV init 스크립트",
        Init::Cron => "cron @reboot",
    }
}

/// A program on PATH or in the sbin folders (a normal user's PATH often lacks them).
pub fn which(cmd: &str) -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let found = path.split(':').chain(["/usr/local/sbin", "/usr/sbin", "/sbin", "/usr/bin", "/bin"]).map(|d| std::path::Path::new(d).join(cmd)).find(|p| p.is_file());
    found.map(|p| p.display().to_string())
}

/// sh single quotes.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The variables the service gives the runner: the user's HOME (and USER), and a moved config folder.
fn service_env(user: &str) -> Vec<(String, String)> {
    let mut env = vec![("HOME".to_string(), config::home().display().to_string()), ("USER".into(), user.into()), ("LOGNAME".into(), user.into())];
    if let Some(dir) = std::env::var_os("AIDEV_RUNNER_HOME") {
        env.push(("AIDEV_RUNNER_HOME".into(), PathBuf::from(dir).display().to_string()));
    }
    env
}

pub fn system_unit_text(exe: &str, user: &str, env: &[(String, String)], log: &str) -> String {
    let env: String = env.iter().map(|(k, v)| format!("Environment=\"{k}={v}\"\n")).collect();
    format!(
        "[Unit]\nDescription=NadoVibe runner\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nUser={user}\n{env}ExecStart=\"{exe}\" start --service --boot --log \"{log}\"\nRestart=on-failure\nRestartSec=5\nRestartPreventExitStatus=3\n\n[Install]\nWantedBy=multi-user.target\n"
    )
}

pub fn openrc_text(exe: &str, user: &str, env: &[(String, String)]) -> String {
    let env: String = env.iter().map(|(k, v)| format!("export {k}={}\n", sq(v))).collect();
    format!(
        "#!/sbin/openrc-run\n# NadoVibe runner (`aidev-runner install`; `aidev-runner uninstall` removes it)\ndescription=\"NadoVibe runner\"\ncommand={}\ncommand_args=\"supervise\"\ncommand_user={}\ncommand_background=true\npidfile=\"/run/aidev-runner.pid\"\nretry=\"TERM/15/KILL/5\"\n{env}\ndepend() {{\n\tuse net dns\n\tafter net\n}}\n",
        sq(exe), sq(user)
    )
}

pub fn procd_text(exe: &str, user: &str, env: &[(String, String)]) -> String {
    let env: String = env.iter().map(|(k, v)| format!(" {}", sq(&format!("{k}={v}")))).collect();
    format!(
        "#!/bin/sh /etc/rc.common\n# NadoVibe runner (`aidev-runner install`; `aidev-runner uninstall` removes it)\nSTART=99\nSTOP=10\nUSE_PROCD=1\n\nstart_service() {{\n\tprocd_open_instance\n\tprocd_set_param command {} supervise\n\tprocd_set_param env{env}\n\tprocd_set_param user {}\n\tprocd_set_param stdout 1\n\tprocd_set_param stderr 1\n\tprocd_close_instance\n}}\n",
        sq(exe), sq(user)
    )
}

pub fn sysv_text(exe: &str, user: &str, env: &[(String, String)], pidfile: &str) -> String {
    let env: String = env.iter().map(|(k, v)| format!("{k}={}; export {k}\n", sq(v))).collect();
    format!(
        r#"#!/bin/sh
### BEGIN INIT INFO
# Provides:          aidev-runner
# Required-Start:    $network $remote_fs
# Required-Stop:     $network $remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: NadoVibe runner
### END INIT INFO
# NadoVibe runner (`aidev-runner install`; `aidev-runner uninstall` removes it)
EXE={exe}
RUN_AS={user}
PIDFILE={pidfile}
{env}
running() {{ [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }}
start() {{
	running && return 0
	cmd="\"$EXE\" supervise </dev/null >/dev/null 2>&1 &"
	if [ "$(id -u)" = 0 ] && [ "$RUN_AS" != root ]; then su "$RUN_AS" -s /bin/sh -c "$cmd"; else sh -c "$cmd"; fi
}}
stop() {{
	running || return 0
	pid=$(cat "$PIDFILE"); kill "$pid" 2>/dev/null
	i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
	kill -9 "$pid" 2>/dev/null; return 0
}}
case "$1" in
	start) start ;;
	stop) stop ;;
	restart|reload|force-reload) stop; start ;;
	status) if running; then echo "aidev-runner: 실행 중 (pid $(cat "$PIDFILE"))"; else echo "aidev-runner: 꺼짐"; exit 3; fi ;;
	*) echo "usage: $0 {{start|stop|restart|status}}"; exit 2 ;;
esac
"#,
        exe = sq(exe), user = sq(user), pidfile = sq(pidfile)
    )
}

fn supervise_pidfile() -> PathBuf {
    config::dir().join("supervise.pid")
}

/// What `install --print` shows for a system service.
fn system_service_text(init: Init, exe: &str, user: &str) -> String {
    let env = service_env(user);
    match init {
        Init::Systemd => format!("# {SYSTEM_UNIT}\n{}", system_unit_text(exe, user, &env, &config::dir().join("runner.log").display().to_string())),
        Init::OpenRc => format!("# {INIT_SCRIPT}\n{}", openrc_text(exe, user, &env)),
        Init::Procd => format!("# {INIT_SCRIPT}\n{}", procd_text(exe, user, &env)),
        Init::SysV => format!("# {INIT_SCRIPT}\n{}", sysv_text(exe, user, &env, &supervise_pidfile().display().to_string())),
        Init::Cron => format!("# crontab\n@reboot {} supervise >/dev/null 2>&1\n", sq(exe)),
    }
}

/// One administrative step: as root directly, else through sudo.
pub(crate) fn as_root(args: &[&str]) -> Result<(), String> {
    if crate::proc_util::is_elevated() { run(args[0], &args[1..]) } else { sudo(args) }
}

fn quiet_root(args: &[&str]) -> bool {
    if crate::proc_util::is_elevated() { quiet(args[0], &args[1..]) } else { quiet("sudo", &[&["-n"], args].concat()) }
}

fn write_root(dest: &str, text: &str, mode: &str) -> Result<(), String> {
    if crate::proc_util::is_elevated() {
        std::fs::write(dest, text).map_err(|e| format!("{dest}: {e}"))?;
        return run("chmod", &[mode, dest]);
    }
    sudo_write(dest, text, mode)
}

/// Root is reachable: we are root, sudo needs no password, or there is a terminal to type it in.
fn can_be_root() -> bool {
    crate::proc_util::is_elevated() || (which("sudo").is_some() && (quiet("sudo", &["-n", "true"]) || std::io::IsTerminal::is_terminal(&std::io::stdin())))
}

/// The user's crontab without our line, plus `line` when given.
fn set_cron(line: Option<&str>) -> Result<(), String> {
    use std::io::Write;
    which("crontab").ok_or("crontab이 없습니다")?;
    let current = Command::new("crontab").arg("-l").stderr(std::process::Stdio::null()).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let mut lines: Vec<&str> = current.lines().filter(|l| !cron_ours(l)).collect();
    if line.is_none() && lines.len() == current.lines().count() {
        return Ok(());   // nothing of ours there
    }
    if let Some(l) = line { lines.push(l); }
    let mut child = Command::new("crontab").arg("-").stdin(std::process::Stdio::piped()).spawn().map_err(|e| format!("crontab: {e}"))?;
    child.stdin.take().map(|mut i| i.write_all(format!("{}\n", lines.join("\n")).as_bytes()));
    if child.wait().map_err(|e| e.to_string())?.success() { Ok(()) } else { Err("crontab 등록 실패".into()) }
}

/// `aidev-runner supervise` in the background, out of this terminal's session.
fn spawn_supervise(exe: &str) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.arg("supervise").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // its own session: closing this terminal leaves it running
    #[cfg(unix)]
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut cmd, || {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("{exe} supervise: {e}"))
}

fn installed_script() -> Option<&'static str> {
    [INIT_SCRIPT, RCS_SCRIPT].into_iter().find(|p| std::path::Path::new(p).exists())
}

/// The init system an installed /etc/init.d script is written for.
fn script_init(path: &str) -> Init {
    match std::fs::read_to_string(path).unwrap_or_default().lines().next().unwrap_or("") {
        l if l.contains("openrc-run") => Init::OpenRc,
        l if l.contains("rc.common") => Init::Procd,
        _ => Init::SysV,
    }
}

/// Registers and starts the system service for `user` (see the section notes); the lines say what was done.
fn install_system(exe: &str, user: &str) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    // one runner per PC: a user service from an earlier install goes
    if config::home().join(".config/systemd/user/aidev-runner.service").exists() {
        let _ = systemctl_user(&["disable", "--now", "aidev-runner.service"]);
        let _ = std::fs::remove_file(config::home().join(".config/systemd/user/aidev-runner.service"));
        notes.push("이전 systemd 사용자 서비스를 지웠습니다".to_string());
    }
    let log = config::dir().join("runner.log").display().to_string();
    let env = service_env(user);
    let mut init = init_system();
    if init != Init::Cron && !can_be_root() {
        notes.push(format!("! 관리자 권한(root·sudo)이 없어 {}로 등록하지 못합니다 — cron @reboot으로 대신합니다", init_label(init)));
        init = Init::Cron;
    }
    let registered: Result<(), String> = match init {
        Init::Systemd => write_root(SYSTEM_UNIT, &system_unit_text(exe, user, &env, &log), "0644").and_then(|_| {
            as_root(&["systemctl", "daemon-reload"])?;
            as_root(&["systemctl", "enable", "aidev-runner.service"])?;
            as_root(&["systemctl", "restart", "aidev-runner.service"])
        }),
        Init::OpenRc => write_root(INIT_SCRIPT, &openrc_text(exe, user, &env), "0755").and_then(|_| {
            quiet_root(&["rc-update", "add", "aidev-runner", "default"]);
            as_root(&["rc-service", "aidev-runner", "restart"])
        }),
        Init::Procd => write_root(INIT_SCRIPT, &procd_text(exe, user, &env), "0755").and_then(|_| {
            as_root(&[INIT_SCRIPT, "enable"])?;
            quiet_root(&[INIT_SCRIPT, "stop"]);   // procd's restart complains when it was not running
            as_root(&[INIT_SCRIPT, "start"])
        }),
        Init::SysV => {
            let text = sysv_text(exe, user, &env, &supervise_pidfile().display().to_string());
            let script = if which("update-rc.d").is_none() && which("chkconfig").is_none() && std::path::Path::new("/etc/init.d/rcS").exists() { RCS_SCRIPT } else { INIT_SCRIPT };
            write_root(script, &text, "0755").and_then(|_| {
                if script == INIT_SCRIPT {
                    if which("update-rc.d").is_some() {
                        as_root(&["update-rc.d", "aidev-runner", "defaults"])?;
                    } else if which("chkconfig").is_some() {
                        as_root(&["chkconfig", "--add", "aidev-runner"])?;
                    } else {
                        let linked: Vec<_> = (2..=5).map(|n| format!("/etc/rc{n}.d")).filter(|d| std::path::Path::new(d).is_dir())
                            .filter(|d| quiet_root(&["ln", "-sf", "../init.d/aidev-runner", &format!("{d}/S99aidev-runner")])).collect();
                        if linked.is_empty() {
                            return Err("부팅 때 실행할 runlevel 폴더(/etc/rc2.d …)가 없습니다".into());
                        }
                    }
                }
                as_root(&[script, "restart"])
            })
        }
        Init::Cron => {
            let r = set_cron(Some(&format!("@reboot {} supervise >/dev/null 2>&1", sq(exe))));
            if let Err(e) = &r {
                notes.push(format!("! 부팅 때 실행을 등록하지 못했습니다 ({e}) — 재부팅 후에는 `aidev-runner service start`"));
            }
            if runner_pid().is_none() { spawn_supervise(exe)?; }
            r.or(Ok(()))
        }
    };
    if let Err(e) = registered {
        // what could not be registered goes (no half-made service), and the runner runs now and from cron at boot
        remove_system(true);
        notes.push(format!("! {}로 등록하지 못했습니다: {e} — cron @reboot으로 대신합니다", init_label(init)));
        let _ = set_cron(Some(&format!("@reboot {} supervise >/dev/null 2>&1", sq(exe))));
        if runner_pid().is_none() { spawn_supervise(exe)?; }
        notes.insert(0, format!("서비스: {} (로그: {log})", init_label(Init::Cron)));
        return Ok(notes);
    }
    if init != Init::Cron {
        let _ = set_cron(None);   // an earlier cron fallback
    }
    notes.insert(0, format!("서비스 등록: {} — 부팅 때부터 {user} 계정으로 실행 (로그: {log})", init_label(init)));
    if init == Init::Cron && which("crond").is_none() && which("cron").is_none() {
        notes.push("! cron 데몬이 보이지 않습니다 — 부팅 때 crond가 실행되는지 확인하세요".into());
    }
    Ok(notes)
}

/// Removes every system-service form of the runner (and its cron line) and, with `stop`, stops it (without: the
/// runner doing it is the service's own — `purge`); the lines say what went.
fn remove_system(stop: bool) -> Vec<String> {
    let mut notes = Vec::new();
    if std::path::Path::new(SYSTEM_UNIT).exists() {
        quiet_root(if stop { &["systemctl", "disable", "--now", "aidev-runner.service"] } else { &["systemctl", "disable", "aidev-runner.service"] });
        notes.push(match as_root(&["rm", "-f", SYSTEM_UNIT]) {
            Ok(()) => { quiet_root(&["systemctl", "daemon-reload"]); "systemd 시스템 서비스를 제거했습니다".to_string() }
            Err(e) => format!("! {SYSTEM_UNIT}을(를) 지우지 못했습니다: {e}"),
        });
    }
    for script in [INIT_SCRIPT, RCS_SCRIPT] {
        if !std::path::Path::new(script).exists() {
            continue;
        }
        let init = script_init(script);
        if stop { quiet_root(&[script, "stop"]); }
        match init {
            Init::OpenRc => { quiet_root(&["rc-update", "del", "aidev-runner", "default"]); }
            Init::Procd => { quiet_root(&[script, "disable"]); }
            _ if script == INIT_SCRIPT => {
                if which("update-rc.d").is_some() { quiet_root(&["update-rc.d", "-f", "aidev-runner", "remove"]); }
                else if which("chkconfig").is_some() { quiet_root(&["chkconfig", "--del", "aidev-runner"]); }
                for n in 2..=5 { quiet_root(&["rm", "-f", &format!("/etc/rc{n}.d/S99aidev-runner")]); }
            }
            _ => {}
        }
        notes.push(match as_root(&["rm", "-f", script]) {
            Ok(()) => format!("{}를 제거했습니다 ({script})", init_label(init)),
            Err(e) => format!("! {script}을(를) 지우지 못했습니다: {e}"),
        });
    }
    if Command::new("crontab").arg("-l").output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).lines().any(cron_ours)) {
        notes.push(match set_cron(None) { Ok(()) => "cron @reboot 등록을 지웠습니다".into(), Err(e) => format!("! cron 등록을 지우지 못했습니다: {e}") });
    }
    // a supervise started by hand or by cron
    #[cfg(unix)]
    if let Some(pid) = std::fs::read_to_string(supervise_pidfile()).ok().filter(|_| stop).and_then(|s| s.trim().parse::<i32>().ok()) {
        if pid > 1 && unsafe { libc::kill(pid, 0) } == 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
    notes
}

/// How the runner is kept running on this PC, when it is (the menu, and a bare `aidev-runner` on a terminal).
pub fn installed() -> Option<String> {
    let home = config::home();
    match std::env::consts::OS {
        "linux" => {
            if home.join(".config/systemd/user/aidev-runner.service").exists() { return Some("systemd 사용자 서비스".into()); }
            if std::path::Path::new(SYSTEM_UNIT).exists() { return Some(init_label(Init::Systemd).into()); }
            if let Some(script) = installed_script() { return Some(init_label(script_init(script)).into()); }
            Command::new("crontab").arg("-l").stderr(std::process::Stdio::null()).output().ok()
                .filter(|o| String::from_utf8_lossy(&o.stdout).lines().any(cron_ours)).map(|_| init_label(Init::Cron).into())
        }
        "macos" => home.join("Library/LaunchAgents/work.nado.aidev-runner.plist").exists().then(|| {
            if std::path::Path::new(BOOT_PLIST).exists() { "LaunchAgent + LaunchDaemon(부팅)".into() } else { "LaunchAgent".into() }
        }),
        _ => None,
    }
}

/// `service start|stop|restart|status`: 정지 drops the connection (the status icon's, for every runner of this PC);
/// 시작 lifts it and starts the service when nothing runs; 다시 시작 restarts the service.
pub fn control(action: &str) -> Result<String, String> {
    if cfg!(target_os = "android") {
        return Err("Android에서는 NadoVibe 러너 앱이 서비스를 관리합니다".into());
    }
    let exe = installed_path().display().to_string();
    let mode = installed();
    let kick = |restart: bool| -> Result<(), String> {
        let verb = if restart { "restart" } else { "start" };
        let home = config::home();
        match std::env::consts::OS {
            "linux" if home.join(".config/systemd/user/aidev-runner.service").exists() => systemctl_user(&[verb, "aidev-runner.service"]),
            "linux" if std::path::Path::new(SYSTEM_UNIT).exists() => as_root(&["systemctl", verb, "aidev-runner.service"]),
            "linux" if installed_script().is_some() => {
                let script = installed_script().unwrap_or(INIT_SCRIPT);
                if script_init(script) == Init::OpenRc { as_root(&["rc-service", "aidev-runner", verb]) } else { as_root(&[script, verb]) }
            }
            "linux" if mode.is_some() => {
                if restart { remove_supervise_only(); std::thread::sleep(std::time::Duration::from_secs(2)); }
                spawn_supervise(&exe)
            }
            "macos" if mode.is_some() => {
                let uid = String::from_utf8_lossy(&Command::new("id").arg("-u").output().map_err(|e| e.to_string())?.stdout).trim().to_string();
                let target = format!("gui/{uid}/work.nado.aidev-runner");
                if restart { run("launchctl", &["kickstart", "-k", &target]) } else { run("launchctl", &["kickstart", &target]) }
            }
            // the sign-in task (MultipleInstances IgnoreNew: running it again is harmless)
            "windows" => {
                if restart { quiet("schtasks", &["/End", "/TN", "aidev-runner"]); }
                run("schtasks", &["/Run", "/TN", "aidev-runner"]).map_err(|_| "작업 스케줄러에 aidev-runner 작업이 없습니다 — 먼저 `aidev-runner install`".to_string())
            }
            _ => Err("설치된 서비스가 없습니다 — 먼저 `aidev-runner install`".into()),
        }
    };
    match action {
        "status" => Ok(status_text()),
        "stop" => {
            crate::control::set_paused(true);
            Ok("정지: 이 PC의 러너가 연결을 끊고 실행 중인 명령을 멈춥니다 (다시 연결: `aidev-runner service start`)".into())
        }
        "start" => {
            crate::control::set_paused(false);
            if runner_pid().is_none() { kick(false)?; }
            Ok("시작: 러너가 다시 연결합니다".into())
        }
        "restart" => {
            crate::control::set_paused(false);
            kick(true)?;
            Ok("서비스를 다시 시작했습니다".into())
        }
        other => Err(format!("{other}: start | stop | restart | status")),
    }
}

/// Stops a cron-started supervise (its runner stops with it).
fn remove_supervise_only() {
    #[cfg(unix)]
    if let Some(pid) = std::fs::read_to_string(supervise_pidfile()).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
        if pid > 1 { unsafe { libc::kill(pid, libc::SIGTERM) }; }
    }
}

/// `~/.aidev/state` ("connected <pid>" …) while that runner lives: its word and pid.
fn live_state() -> Option<(String, u32)> {
    let text = std::fs::read_to_string(crate::control::state_path()).ok()?;
    let mut words = text.split_whitespace();
    let word = words.next()?.to_string();
    let pid: u32 = words.next()?.parse().ok()?;
    #[cfg(unix)]
    if unsafe { libc::kill(pid as i32, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
        return None;
    }
    Some((word, pid))
}

/// A runner process of this config is alive (connected, connecting, or paused without its lock).
pub fn runner_pid() -> Option<u32> {
    config::lock_holder().or_else(|| live_state().map(|(_, pid)| pid))
}

/// The runner's connection as another process sees it.
pub fn connection() -> &'static str {
    let paused = crate::control::is_paused();
    let Some(pid) = runner_pid() else { return if paused { "꺼짐 (정지됨)" } else { "꺼짐" } };
    if paused {
        return "정지됨";
    }
    match live_state() {
        Some((word, by)) if word == "connected" && by == pid => "연결됨",
        _ => "연결 중",
    }
}

pub fn status_text() -> String {
    let pid = runner_pid().map(|p| format!(" (pid {p})")).unwrap_or_default();
    format!(
        "서비스: {}\n러너: {}{pid}",
        installed().unwrap_or_else(|| "설치 안 됨 — `aidev-runner install`".into()),
        connection(),
    )
}

/// `supervise` (OpenRC, procd, SysV, cron): `start --service --boot` as a child, started again 5 s after a failure;
/// ends with it on 0 (종료) and 3 (the token was refused — restarting would only be refused again). SIGTERM/SIGINT go
/// on to the child, which stops its commands and ends; then this ends too.
#[cfg(unix)]
pub fn supervise() -> Result<i32, String> {
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
    static CHILD: AtomicI32 = AtomicI32::new(0);
    static STOP: AtomicBool = AtomicBool::new(false);
    extern "C" fn on_signal(_: libc::c_int) {
        STOP.store(true, Ordering::SeqCst);
        let pid = CHILD.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
    config::load()?;
    unsafe {
        // its own session: closing the terminal that started it (cron, an init script run by hand) leaves it alone
        libc::setsid();
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
    }
    let pidfile = supervise_pidfile();
    let _ = std::fs::write(&pidfile, std::process::id().to_string());
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let log = config::dir().join("runner.log");
    let code = loop {
        // the file path, not the open file: after an update the new runner starts
        let exe = PathBuf::from(exe.display().to_string().trim_end_matches(" (deleted)"));
        let mut child = match Command::new(&exe).args(["start", "--service", "--boot", "--log"]).arg(&log).stdin(std::process::Stdio::null()).spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("supervise: {} 실행 실패: {e}", exe.display());
                std::thread::sleep(std::time::Duration::from_secs(5));
                if STOP.load(Ordering::SeqCst) { break 0; }
                continue;
            }
        };
        CHILD.store(child.id() as i32, Ordering::SeqCst);
        if STOP.load(Ordering::SeqCst) {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
        }
        let status = child.wait();
        CHILD.store(0, Ordering::SeqCst);
        let code = status.ok().and_then(|s| s.code());
        if STOP.load(Ordering::SeqCst) || matches!(code, Some(0) | Some(3)) {
            break code.unwrap_or(0);
        }
        eprintln!("supervise: 러너가 끝났습니다 ({}) — 5초 뒤 다시 시작합니다", code.map(|c| c.to_string()).unwrap_or_else(|| "신호".into()));
        for _ in 0..10 {
            if STOP.load(Ordering::SeqCst) { break; }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        if STOP.load(Ordering::SeqCst) { break 0; }
    };
    if std::fs::read_to_string(&pidfile).ok().as_deref() == Some(&std::process::id().to_string()) {
        let _ = std::fs::remove_file(&pidfile);
    }
    Ok(code)
}

#[cfg(not(unix))]
pub fn supervise() -> Result<i32, String> {
    Err("supervise는 Linux·macOS 전용입니다".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_tasks_strong_by_default() {
        let s = super::task_script("C:\\it's\\aidev-runner.exe", false, false, "PC\\me");
        assert!(s.contains("-Execute 'C:\\it''s\\aidev-runner.exe' -Argument 'start --hidden'") && s.contains("-AtLogOn -User 'PC\\me'"));
        assert!(s.contains("-LogonType Interactive -RunLevel Highest") && s.contains("-ExecutionTimeLimit ([TimeSpan]::Zero)"));
        assert!(s.contains("'start --hidden --boot'") && s.contains("-LogonType S4U -RunLevel Highest") && s.contains("-AtStartup"));
        assert!(s.contains("Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'NadoVibe Runner'") && s.contains("conhost.exe\" --headless") && s.contains("/Run /TN aidev-runner"));
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

    /// The system services of embedded Linux: each runs `supervise` as the user with HOME set, quoted for sh, and the
    /// SysV script is valid sh (`sh -n`).
    #[test]
    fn system_services_run_supervise_as_the_user() {
        let env = vec![("HOME".to_string(), "/home/it's".to_string()), ("USER".into(), "dev".into())];
        let unit = super::system_unit_text("/opt/a b/aidev-runner", "dev", &env, "/home/x/.aidev/runner.log");
        assert!(unit.contains("User=dev") && unit.contains("Environment=\"HOME=/home/it's\"") && unit.contains("ExecStart=\"/opt/a b/aidev-runner\" start --service --boot --log") && unit.contains("RestartPreventExitStatus=3") && unit.contains("WantedBy=multi-user.target"));
        let rc = super::openrc_text("/opt/a b/aidev-runner", "dev", &env);
        assert!(rc.starts_with("#!/sbin/openrc-run") && rc.contains("command='/opt/a b/aidev-runner'") && rc.contains("command_args=\"supervise\"") && rc.contains("command_user='dev'") && rc.contains("export HOME='/home/it'\\''s'"));
        let procd = super::procd_text("/opt/a b/aidev-runner", "dev", &env);
        assert!(procd.starts_with("#!/bin/sh /etc/rc.common") && procd.contains("USE_PROCD=1") && procd.contains("procd_set_param command '/opt/a b/aidev-runner' supervise") && procd.contains("procd_set_param user 'dev'"));
        let sysv = super::sysv_text("/opt/a b/aidev-runner", "dev", &env, "/home/x/.aidev/supervise.pid");
        assert!(sysv.contains("EXE='/opt/a b/aidev-runner'") && sysv.contains("RUN_AS='dev'") && sysv.contains("# Provides:          aidev-runner"));
        #[cfg(unix)]
        {
            let path = std::env::temp_dir().join(format!("aidev-sysv-{}", std::process::id()));
            std::fs::write(&path, &sysv).unwrap();
            let ok = std::process::Command::new("sh").arg("-n").arg(&path).status().unwrap().success();
            let _ = std::fs::remove_file(&path);
            assert!(ok, "the SysV script parses");
        }
        assert!(super::cron_ours("@reboot '/root/.aidev/bin/aidev-runner' supervise >/dev/null 2>&1") && !super::cron_ours("@reboot run-parts /etc/periodic"));
    }
}
