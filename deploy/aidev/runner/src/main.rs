//! aidev-runner — connects this PC to the Nado AI Dev platform so agents and the workbench can run,
//! test, preview, show and debug code here (IMPLEMENTATION-PLAN §3.12, stage F).
//! Outbound WebSocket only; everything it touches is confined to `allowed_roots`.

mod appwin;
mod caps;
mod config;
mod conn;
mod control;
mod dap;
mod dap_adapters;
mod devices;
mod devserver;
mod encoder;
mod exec;
mod input;
#[cfg(target_os = "macos")]
mod macperm;
#[cfg(target_os = "macos")]
mod mac_screen;
#[cfg(windows)]
mod win_screen;
mod pair;
mod proc_util;
mod roots;
mod screen;
mod service;
mod sync;
mod tray;
mod tunnel;
mod update;
mod dialog;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "aidev-runner", version, about = "NadoVibe 원격 실행 러너 (밖으로만 연결) — `aidev-runner`: 포그라운드 실행, `install`: 서비스 설치, `uninstall`: 서비스 제거")]
struct Cli {
    /// 없으면 포그라운드로 실행(`start`) — 아직 페어링하지 않았으면 코드를 물어봄
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// 작업대 "원격 대상"에서 받은 페어링 코드로 이 PC를 등록
    Pair {
        code: String,
        #[arg(long, default_value = "https://dev.nado.work")]
        gateway: String,
        /// 표시 이름 (기본: 등록할 때 정한 이름)
        #[arg(long)]
        name: Option<String>,
    },
    /// 포그라운드로 실행 (Ctrl+C로 종료) — 아무 명령 없이 `aidev-runner`만 실행해도 같음
    Start {
        /// 출력을 이 파일에 덧붙임 (서비스로 실행할 때)
        #[arg(long)]
        log: Option<PathBuf>,
        /// Windows: 콘솔 창 없이 (로그온 작업이 씀; --log 기본값 ~/.aidev/runner.log)
        #[arg(long)]
        hidden: bool,
        /// 부팅 작업용: 로그인 전 연결을 맡고, 로그인한 사용자의 러너가 오면 넘긴 뒤 그 러너가 끝나면 다시 이어받음
        #[arg(long, hide = true)]
        boot: bool,
        /// 서비스가 실행함: 상태 아이콘의 "정지"를 그대로 둠 (직접 실행하면 정지를 풀고 시작)
        #[arg(long, hide = true)]
        service: bool,
    },
    /// 설정·연결 대상 표시 (토큰은 표시하지 않음)
    Status,
    /// 이 PC가 보고할 capabilities를 JSON으로 출력
    Caps,
    /// 플랫폼이 접근할 수 있는 폴더 관리
    Roots {
        #[command(subcommand)]
        action: RootsCmd,
    },
    /// 화면 캡처 허용 여부 (기본 꺼짐)
    Consent {
        what: String,
        state: String,
    },
    /// 서비스 설치: 등록하고 바로 시작, 로그인(또는 부팅) 때마다 자동 실행 (systemd 사용자 서비스 / LaunchAgent / 작업 스케줄러)
    #[command(name = "install", alias = "install-service")]
    InstallService {
        /// 등록하지 않고 내용만 출력
        #[arg(long)]
        print: bool,
        /// Windows: 일반 사용자 권한으로 실행 (기본은 관리자 권한 — 서비스·레지스트리·방화벽·설치까지)
        #[arg(long)]
        limited: bool,
        /// Windows: 로그인한 동안만 실행 (기본은 부팅 직후부터 — 로그인 전엔 부팅 작업이, 로그인하면 사용자 세션의 러너가 맡음)
        #[arg(long)]
        logon_only: bool,
        /// 예전 옵션(이제 기본값) — 무시
        #[arg(long, hide = true)]
        elevated: bool,
        #[arg(long, hide = true)]
        at_startup: bool,
        /// 관리자 권한으로 다시 실행된 설치가 원래 사용자를 받음
        #[arg(long, hide = true)]
        user: Option<String>,
    },
    /// 서비스 제거 (자동 실행 등록을 지우고 서비스로 돌던 러너를 멈춤)
    #[command(name = "uninstall", alias = "uninstall-service")]
    UninstallService,
    /// 이 PC의 토큰을 지움 (작업대에서도 대상을 삭제하세요)
    Unpair,
    /// 원격 화면 단계별 시간 측정 (캡처·축소·변화 확인·인코딩)
    #[command(hide = true)]
    Bench {
        /// 창 id (screen.list) — 없으면 주 화면
        #[arg(long)]
        window: Option<u32>,
        #[arg(long, default_value_t = 60)]
        frames: u32,
        #[arg(long, default_value_t = 1440)]
        max_width: u32,
    },
    /// 업데이트: 받을 수 있는 버전(최신·이전)을 보여 주고 고른 버전으로 교체 — 서비스·권한·설정은 그대로
    Update {
        /// 이 버전으로 바로 (`latest`: 최신) — 없으면 목록에서 고름
        version: Option<String>,
        /// 게이트웨이 (기본: 페어링한 게이트웨이)
        #[arg(long)]
        gateway: Option<String>,
    },
}

#[derive(Subcommand)]
enum RootsCmd {
    List,
    Add { path: PathBuf },
    Remove { path: PathBuf },
}

fn main() -> ExitCode {
    // Windows: window bounds, window captures and mouse input all in physical pixels (no DPI virtualization
    // on 125–150 % displays, where they would disagree). The runner has no UI, so nothing else is affected.
    #[cfg(windows)]
    let _ = enigo::set_dpi_awareness();
    control::remember_exe();
    let cli = Cli::parse();
    let bare = cli.cmd.is_none();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("오류: {e}");
            // double-clicked on Windows: keep the window open long enough to read why
            if bare && cfg!(windows) && std::io::IsTerminal::is_terminal(&std::io::stdin()) {
                eprintln!("\nEnter 키를 누르면 닫힙니다");
                let _ = std::io::stdin().read_line(&mut String::new());
            }
            ExitCode::FAILURE
        }
    }
}

/// `aidev-runner` with nothing after it on a PC that was never paired: ask for the code in the terminal.
fn pair_interactively() -> Result<(), String> {
    use std::io::{IsTerminal, Write};
    if config::path().exists() || !std::io::stdin().is_terminal() {
        return Ok(());
    }
    println!("이 PC는 아직 등록되지 않았습니다. 작업대 \"원격 대상\"에서 받은 페어링 코드를 입력하세요.");
    print!("페어링 코드: ");
    let _ = std::io::stdout().flush();
    let mut code = String::new();
    std::io::stdin().read_line(&mut code).map_err(|e| e.to_string())?;
    let code = code.trim();
    if code.is_empty() {
        return Err("페어링 코드가 없습니다".into());
    }
    let cfg = pair::pair(code, "https://dev.nado.work", None)?;
    println!("등록 완료: 대상 #{} {}\n", cfg.target_id, cfg.name);
    Ok(())
}

/// `aidev-runner update`: the versions as a numbered list (the status icon's popup, in the console), then the one
/// chosen installed.
fn update_console(version: Option<String>, gateway: Option<String>) -> Result<String, String> {
    use std::io::{IsTerminal, Write};
    let gateway = gateway.or_else(|| config::load().ok().map(|c| c.gateway)).unwrap_or_else(|| "https://dev.nado.work".into());
    let list = update::versions(&gateway)?;
    let newest = list.first().ok_or("받을 수 있는 버전이 없습니다")?.version.clone();
    let pick = match version.as_deref() {
        Some("latest") => 0,
        Some(v) => list.iter().position(|x| x.version == v.trim_start_matches('v')).ok_or_else(|| {
            format!("{v}: 받을 수 있는 버전이 아닙니다 ({})", list.iter().map(|x| x.version.as_str()).collect::<Vec<_>>().join(", "))
        })?,
        None => {
            println!("NadoVibe 러너 업데이트 — 지금 {}
", update::CURRENT);
            for (i, v) in list.iter().enumerate() {
                println!("  {:>2}) {}", i + 1, update::label(v, &newest));
            }
            if !std::io::stdin().is_terminal() {
                return Ok(format!("
설치하려면: aidev-runner update <버전>  (최신: aidev-runner update latest)"));
            }
            print!("
설치할 번호 [1, 취소는 q]: ");
            let _ = std::io::stdout().flush();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).map_err(|e| e.to_string())?;
            match line.trim() {
                "" => 0,
                "q" | "Q" => return Ok("취소했습니다".into()),
                n => n.parse::<usize>().ok().filter(|n| (1..=list.len()).contains(n)).map(|n| n - 1).ok_or_else(|| format!("{n}: 1~{} 중에서 고르세요", list.len()))?,
            }
        }
    };
    update::install(&list[pick], &|s| println!("{s}"))
}

/// The runner's life: connect, reconnect, hand over (boot-time runner), pause and resume (status icon) — until a
/// shutdown (exit 0) or a refused token (exit 3).
fn serve(cfg: config::Config, boot: bool) -> Result<i32, String> {
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    if update::emulated() {
        eprintln!("! 이 PC는 ARM64인데 x64 러너가 에뮬레이션으로 돌고 있습니다 — 원격 화면 등이 몇 배 느립니다: 상태 아이콘의 \"업데이트\" 또는 `aidev-runner update latest`로 ARM64 빌드로 바꾸세요");
    }
    loop {
        // an update is replacing the file: hold on, disconnected, then start again from the new one
        if control::update_pending() {
            control::set_state(control::State::Connecting);
            eprintln!("업데이트: 연결을 끊고 러너 파일이 바뀌기를 기다립니다");
            while control::updating() && !control::quit_requested() {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            if control::quit_requested() {
                return Ok(0);
            }
            let why = control::restart_self();
            eprintln!("업데이트: 다시 시작하지 못했습니다 ({why}) — 이 러너로 계속합니다");
        }
        if control::is_paused() {
            control::set_state(control::State::Paused);
            eprintln!("정지됨 — 상태 아이콘의 \"시작\"(또는 `aidev-runner` 직접 실행)으로 다시 연결합니다");
            let interrupted = rt.block_on(async {
                while control::is_paused() && !control::quit_requested() && !control::update_pending() {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => return true,
                        _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                    }
                }
                false
            });
            if interrupted || control::quit_requested() {
                eprintln!("종료합니다");
                return Ok(0);
            }
            if control::update_pending() {
                continue;   // restarts from the new file, still paused
            }
            control::set_state(control::State::Connecting);
        }
        // one runner per config: a second `start` would keep stealing the target's connection — except that
        // the boot-time runner hands over to a sign-in's runner and takes over again when it ends
        let lock = match config::acquire_instance(boot, std::time::Duration::from_secs(60)) {
            Ok(lock) => lock,
            Err(_) if control::update_pending() => continue,
            Err(e) => return Err(e),
        };
        if boot {
            eprintln!("부팅 러너: 연결을 맡습니다");
        }
        match rt.block_on(conn::run(cfg.clone(), boot)) {
            conn::Exit::Handoff => {
                drop(lock);
                eprintln!("부팅 러너: 로그인한 사용자의 러너에 연결을 넘깁니다 — 그 러너가 끝나면 다시 이어받습니다");
            }
            conn::Exit::Paused => drop(lock),
            conn::Exit::Shutdown => {
                eprintln!("종료합니다");
                return Ok(0);
            }
            conn::Exit::Unauthorized => {
                eprintln!("게이트웨이가 이 러너의 토큰을 거부했습니다(대상이 삭제되었거나 다시 페어링됨). 작업대에서 새 페어링 코드를 받아 `aidev-runner pair <코드>`를 실행하세요.");
                return Ok(3);
            }
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode, String> {
    let cmd = match cli.cmd {
        Some(cmd) => cmd,
        None => {
            pair_interactively()?;
            Cmd::Start { log: None, hidden: false, boot: false, service: false }
        }
    };
    match cmd {
        Cmd::Pair { code, gateway, name } => {
            let cfg = pair::pair(&code, &gateway, name.as_deref())?;
            println!("등록 완료: 대상 #{} {}\n{}\n\n다음: `aidev-runner` (포그라운드) 또는 `aidev-runner install` (서비스 설치)", cfg.target_id, cfg.name, config::describe(&cfg));
        }
        Cmd::Start { log, hidden, boot, service } => {
            if hidden {
                proc_util::detach_console();
            }
            if let Some(path) = log.or_else(|| (hidden || boot).then(|| config::dir().join("runner.log"))) {
                proc_util::redirect_output(&path)?;
            }
            let mut cfg = config::load()?;
            control::set_boot(boot);
            if config::grant_on_first_run(&mut cfg) {
                eprintln!("첫 실행: 화면 보기·원격 제어를 허용했습니다 (끄기: aidev-runner consent screen off)");
            }
            // macOS: the OS permissions (screen recording, accessibility) asked once, together, in the desktop session
            #[cfg(target_os = "macos")]
            if !boot && tray::wanted(boot) {
                macperm::request_once();
            }
            // started by hand: that is asking it to run (a 정지 from the status icon is lifted); services keep it
            if !(hidden || boot || service) {
                control::set_paused(false);
            }
            #[cfg(any(windows, target_os = "macos"))]
            if tray::wanted(boot) {
                tray::run(cfg.name.clone(), cfg.gateway.clone(), move || serve(cfg, boot).unwrap_or_else(|e| {
                    eprintln!("오류: {e}");
                    1
                }));
            }
            #[cfg(target_os = "linux")]
            if tray::wanted(boot) {
                tray::spawn(cfg.name.clone(), cfg.gateway.clone());
            }
            return Ok(ExitCode::from(serve(cfg, boot)? as u8));
        }
        Cmd::Status => println!("{}", config::describe(&config::load()?)),
        Cmd::Caps => {
            let cfg = config::load().unwrap_or_default();
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&rt.block_on(caps::collect(&cfg))).unwrap_or_default());
        }
        Cmd::Roots { action } => {
            let mut cfg = config::load()?;
            match action {
                RootsCmd::List => {}
                RootsCmd::Add { path } => {
                    std::fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                    let real = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
                    // the home folder is allowed (agents work with full permissions); the whole disk is not
                    if real.parent().is_none() {
                        return Err("루트(/) 전체는 허용할 수 없습니다 — 홈 폴더나 작업용 폴더를 지정하세요".into());
                    }
                    if !cfg.allowed_roots.contains(&real) { cfg.allowed_roots.push(real); }
                }
                RootsCmd::Remove { path } => {
                    let real = std::fs::canonicalize(&path).unwrap_or(path);
                    cfg.allowed_roots.retain(|r| r != &real);
                }
            }
            config::save(&cfg)?;
            for r in &cfg.allowed_roots { println!("{}", r.display()); }
            println!("(실행 중인 러너는 다시 시작해야 반영됩니다)");
        }
        Cmd::Consent { what, state } => {
            let mut cfg = config::load()?;
            let on = match state.as_str() { "on" => true, "off" => false, _ => return Err("on|off".into()) };
            match what.as_str() {
                "screen" => { cfg.screen_consent = on; if !on { cfg.control_consent = false; } }
                // control implies seeing the screen
                "control" => { cfg.control_consent = on; if on { cfg.screen_consent = true; } }
                _ => return Err("지원: consent screen on|off, consent control on|off".into()),
            }
            cfg.consent_version = 1;   // the owner's choice: the first-run grant never overrides it
            config::save(&cfg)?;
            println!("화면 보기: {} / 원격 제어(마우스·키보드): {}", if cfg.screen_consent { "허용" } else { "꺼짐" }, if cfg.control_consent { "허용" } else { "꺼짐" });
            println!("(실행 중인 러너는 다시 시작해야 반영됩니다)");
        }
        Cmd::InstallService { print, limited, logon_only, user, .. } => println!("{}", service::install(print, limited, logon_only, user)?),
        Cmd::UninstallService => println!("{}", service::uninstall()?),
        Cmd::Bench { window, frames, max_width } => {
            println!("[CPU: xcap + OpenH264]\n{}", screen::bench(window, frames.max(1), max_width)?);
            #[cfg(windows)]
            println!("\n[{}]", screen::bench_wgc(window, max_width).unwrap_or_else(|e| format!("Windows Graphics Capture 측정 실패: {e}")));
            #[cfg(target_os = "macos")]
            if mac_screen::available() {
                println!("\n[{}]", screen::bench_native(window, frames.max(1), max_width).unwrap_or_else(|e| format!("ScreenCaptureKit 측정 실패: {e}")));
            }
        }
        Cmd::Update { version, gateway } => println!("{}", update_console(version, gateway)?),
        Cmd::Unpair => {
            let p = config::path();
            if p.exists() { std::fs::remove_file(&p).map_err(|e| e.to_string())?; }
            println!("토큰을 지웠습니다. 작업대 \"원격 대상\"에서도 이 대상을 삭제하세요.");
        }
    }
    Ok(ExitCode::SUCCESS)
}
