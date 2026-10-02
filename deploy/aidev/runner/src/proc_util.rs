//! Process helpers shared by every place the runner starts a program.
//! Windows: the runner runs without a console of its own (the logon task starts it with `start --hidden`), so a
//! console program it starts would open a new console window each time — `no_window()` (CREATE_NO_WINDOW) keeps
//! them windowless; their output is piped anyway. A no-op elsewhere.
//! `redirect_output(path)`: the runner's own stdout/stderr to a log file (the service has no terminal).

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn FreeConsole() -> i32;
    fn SetStdHandle(which: u32, handle: *mut core::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn IsUserAnAdmin() -> i32;
}

/// Running with administrator rights (Windows elevated token / Unix root).
pub fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        unsafe { IsUserAnAdmin() != 0 }
    }
    #[cfg(unix)]
    {
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(any(windows, unix)))]
    {
        false
    }
}

/// Windows: let go of the console window the logon task opened (no-op elsewhere).
pub fn detach_console() {
    #[cfg(windows)]
    unsafe {
        FreeConsole();
    }
}

/// Appends the runner's stdout and stderr to `path` (created with its folder). Keeps the last ~5 MB: a bigger
/// file is renamed to `<path>.1` first.
pub fn redirect_output(path: &std::path::Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    if std::fs::metadata(path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        unsafe {
            libc::dup2(file.as_raw_fd(), 1);
            libc::dup2(file.as_raw_fd(), 2);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::IntoRawHandle;
        // Rust's stdout/stderr look the handle up on every write: pointing the process's std handles at the file
        // redirects eprintln!/println! from here on (the handle stays open for the process lifetime)
        let h = file.into_raw_handle();
        const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
        const STD_ERROR_HANDLE: u32 = -12i32 as u32;
        unsafe {
            SetStdHandle(STD_OUTPUT_HANDLE, h as *mut core::ffi::c_void);
            SetStdHandle(STD_ERROR_HANDLE, h as *mut core::ffi::c_void);
        }
    }
    #[cfg(not(any(unix, windows)))]
    let _ = file;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn no_window_is_harmless_here() {
        use super::NoWindow;
        let out = std::process::Command::new("sh").args(["-c", "echo ok"]).no_window().output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }
}
