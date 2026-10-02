//! Native popups for the status icon (2026-10-02): a list to pick from (the versions for 업데이트) and a message.
//! The OS's own tools, nothing to install: macOS osascript, Windows PowerShell + WinForms, Linux zenity or kdialog
//! (without either, the list opens `aidev-runner update` in a terminal window).

use std::process::Command;

/// What the person picked: an index into `items`, or None (cancelled).
pub enum Choice {
    Picked(usize),
    Cancelled,
    /// No popup could be shown here; the reason.
    Unavailable(String),
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn applescript_text(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn ps_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn win_list_script(title: &str, prompt: &str, items: &[String], action: &str) -> String {
    let list = items.iter().map(|x| ps_text(x)).collect::<Vec<_>>().join(", ");
    format!(
        "Add-Type -AssemblyName System.Windows.Forms\n\
         Add-Type -AssemblyName System.Drawing\n\
         [System.Windows.Forms.Application]::EnableVisualStyles()\n\
         $f = New-Object System.Windows.Forms.Form\n\
         $f.Text = {title}; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.FormBorderStyle = 'FixedDialog'\n\
         $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.AutoScaleMode = 'Dpi'; $f.ClientSize = New-Object System.Drawing.Size(380, 320)\n\
         $l = New-Object System.Windows.Forms.Label; $l.Text = {prompt}; $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point(12, 12)\n\
         $b = New-Object System.Windows.Forms.ListBox; $b.Location = New-Object System.Drawing.Point(12, 38); $b.Size = New-Object System.Drawing.Size(356, 220)\n\
         foreach ($i in @({list})) {{ [void]$b.Items.Add($i) }}\n\
         $b.SelectedIndex = 0\n\
         $ok = New-Object System.Windows.Forms.Button; $ok.Text = {action}; $ok.DialogResult = 'OK'; $ok.Location = New-Object System.Drawing.Point(196, 272); $ok.Size = New-Object System.Drawing.Size(84, 30)\n\
         $no = New-Object System.Windows.Forms.Button; $no.Text = '취소'; $no.DialogResult = 'Cancel'; $no.Location = New-Object System.Drawing.Point(286, 272); $no.Size = New-Object System.Drawing.Size(84, 30)\n\
         $f.AcceptButton = $ok; $f.CancelButton = $no\n\
         $b.Add_DoubleClick({{ $f.DialogResult = 'OK'; $f.Close() }})\n\
         $f.Controls.AddRange(@($l, $b, $ok, $no))\n\
         $f.Add_Shown({{ $f.Activate() }})\n\
         if ($f.ShowDialog() -eq 'OK' -and $b.SelectedIndex -ge 0) {{ [Console]::Out.Write($b.SelectedIndex) }}",
        title = ps_text(title), prompt = ps_text(prompt), action = ps_text(action),
    )
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_list_script(title: &str, prompt: &str, items: &[String], action: &str) -> String {
    let list = items.iter().map(|x| applescript_text(x)).collect::<Vec<_>>().join(", ");
    format!(
        "activate\nset picked to choose from list {{{list}}} with title {} with prompt {} default items {{{}}} OK button name {} cancel button name \"취소\"\nif picked is false then return \"\"\nreturn item 1 of picked",
        applescript_text(title), applescript_text(prompt), applescript_text(items.first().map(String::as_str).unwrap_or("")), applescript_text(action)
    )
}

/// A list popup: `title`, a line of `prompt`, the items (the first one chosen), and the OK button's `action`.
pub fn choose(title: &str, prompt: &str, items: &[String], action: &str) -> Choice {
    if items.is_empty() {
        return Choice::Cancelled;
    }
    let picked = |out: &str| -> Choice {
        let out = out.trim();
        if out.is_empty() || out == "false" {
            return Choice::Cancelled;
        }
        if let Ok(i) = out.parse::<usize>() {
            if i < items.len() {
                return Choice::Picked(i);
            }
        }
        items.iter().position(|x| x == out).map_or(Choice::Cancelled, Choice::Picked)
    };
    #[cfg(target_os = "macos")]
    {
        let script = mac_list_script(title, prompt, items, action);
        return match Command::new("osascript").args(["-e", &script]).output() {
            Ok(out) => picked(&String::from_utf8_lossy(&out.stdout)),
            Err(e) => Choice::Unavailable(format!("osascript: {e}")),
        };
    }
    #[cfg(windows)]
    {
        use crate::proc_util::NoWindow;
        let script = win_list_script(title, prompt, items, action);
        return match Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::exec::powershell_encoded(&script)])
            .stdin(std::process::Stdio::null())
            .no_window()
            .output()
        {
            Ok(out) => picked(&String::from_utf8_lossy(&out.stdout)),
            Err(e) => Choice::Unavailable(format!("powershell: {e}")),
        };
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = Command::new("zenity")
            .args(["--list", "--title", title, "--text", prompt, "--column", "버전", "--ok-label", action, "--cancel-label", "취소", "--width", "420", "--height", "380"])
            .args(items)
            .output()
        {
            return picked(&String::from_utf8_lossy(&out.stdout));
        }
        let mut args: Vec<String> = vec!["--title".into(), title.into(), "--radiolist".into(), prompt.into()];
        for (i, x) in items.iter().enumerate() {
            args.extend([i.to_string(), x.clone(), if i == 0 { "on".into() } else { "off".into() }]);
        }
        if let Ok(out) = Command::new("kdialog").args(&args).output() {
            return picked(&String::from_utf8_lossy(&out.stdout));
        }
        return Choice::Unavailable("zenity, kdialog가 없습니다".into());
    }
    #[allow(unreachable_code)]
    Choice::Unavailable("이 OS에는 팝업이 없습니다".into())
}

/// A message popup (an error or a notice); printed to the log as well.
pub fn message(title: &str, text: &str, error: bool) {
    eprintln!("[aidev-runner] {title}: {text}");
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "activate\ndisplay dialog {} with title {} buttons {{\"확인\"}} default button 1 with icon {}",
            applescript_text(text), applescript_text(title), if error { "stop" } else { "note" }
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }
    #[cfg(windows)]
    {
        use crate::proc_util::NoWindow;
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms\n[void][System.Windows.Forms.MessageBox]::Show({}, {}, 'OK', '{}')",
            ps_text(text), ps_text(title), if error { "Error" } else { "Information" }
        );
        let _ = Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::exec::powershell_encoded(&script)])
            .stdin(std::process::Stdio::null())
            .no_window()
            .output();
    }
    #[cfg(target_os = "linux")]
    {
        let shown = Command::new("zenity").args([if error { "--error" } else { "--info" }, "--title", title, "--text", text]).output().is_ok()
            || Command::new("kdialog").args(["--title", title, if error { "--error" } else { "--msgbox" }, text]).output().is_ok();
        if !shown {
            let _ = Command::new("notify-send").args([title, text]).output();
        }
    }
}

/// Linux without zenity / kdialog: `aidev-runner update` in a terminal window (the same list, in the console).
#[cfg(target_os = "linux")]
pub fn open_update_terminal() -> bool {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "aidev-runner".into());
    let exe = exe.trim_end_matches(" (deleted)").to_string();
    let terminals: [(&str, &[&str]); 5] = [
        ("x-terminal-emulator", &["-e"]),
        ("gnome-terminal", &["--"]),
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-x"]),
        ("xterm", &["-e"]),
    ];
    terminals.iter().any(|(term, pre)| Command::new(term).args(*pre).arg(&exe).arg("update").spawn().is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<String> {
        vec!["0.14.1 (최신)  2026-10-03".into(), "0.14.0 (현재)".into(), "it's \"quoted\"".into()]
    }

    /// The list popup's AppleScript compiles (osacompile: no window is shown).
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_popup_script_compiles() {
        let path = std::env::temp_dir().join(format!("aidev-popup-{}.scpt", std::process::id()));
        let out = Command::new("osacompile").args(["-o", &path.display().to_string(), "-e", &mac_list_script("제목", "고르세요", &sample(), "업데이트")]).output().unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// The list popup's PowerShell parses (the parser only: no window is shown) — on Windows, and wherever pwsh is.
    #[test]
    fn win_popup_script_parses() {
        let shell = if cfg!(windows) { "powershell.exe" } else { "pwsh" };
        if !cfg!(windows) && Command::new(shell).arg("-Version").output().is_err() {
            return;
        }
        let path = std::env::temp_dir().join(format!("aidev-popup-{}.ps1", std::process::id()));
        std::fs::write(&path, format!("\u{feff}{}", win_list_script("제목", "고르세요", &sample(), "업데이트"))).unwrap();
        let check = format!("$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('{}', [ref]$null, [ref]$e); if ($e.Count) {{ $e | ForEach-Object {{ $_.Message }}; exit 1 }}", path.display());
        let out = Command::new(shell).args(["-NoProfile", "-Command", &check]).output().unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
    }
}
