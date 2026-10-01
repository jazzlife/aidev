//! aidev-runner — connects this PC to the Nado AI Dev platform so agents and the workbench can run,
//! test, preview, show and debug code here (IMPLEMENTATION-PLAN §3.12, stage F).
//! Outbound WebSocket only; everything it touches is confined to `allowed_roots`.

mod appwin;
mod caps;
mod config;
mod conn;
mod dap;
mod dap_adapters;
mod devices;
mod devserver;
mod encoder;
mod exec;
mod input;
mod pair;
mod proc_util;
mod roots;
mod screen;
mod service;
mod sync;
mod tunnel;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "aidev-runner", version, about = "Nado AI Dev 원격 실행 러너 (밖으로만 연결)")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
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
    /// 포그라운드로 실행 (Ctrl+C로 종료)
    Start {
        /// 출력을 이 파일에 덧붙임 (서비스로 실행할 때)
        #[arg(long)]
        log: Option<PathBuf>,
        /// Windows: 콘솔 창 없이 (로그온 작업이 씀; --log 기본값 ~/.aidev/runner.log)
        #[arg(long)]
        hidden: bool,
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
    /// 로그인 시 자동 실행 등록 (systemd 사용자 서비스 / LaunchAgent / 로그온 작업)
    InstallService {
        /// 등록하지 않고 내용만 출력
        #[arg(long)]
        print: bool,
    },
    UninstallService,
    /// 이 PC의 토큰을 지움 (작업대에서도 대상을 삭제하세요)
    Unpair,
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
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("오류: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode, String> {
    match cli.cmd {
        Cmd::Pair { code, gateway, name } => {
            let cfg = pair::pair(&code, &gateway, name.as_deref())?;
            println!("등록 완료: 대상 #{} {}\n{}\n\n다음: `aidev-runner start` (또는 `aidev-runner install-service`)", cfg.target_id, cfg.name, config::describe(&cfg));
        }
        Cmd::Start { log, hidden } => {
            if hidden {
                proc_util::detach_console();
            }
            if let Some(path) = log.or_else(|| hidden.then(|| config::dir().join("runner.log"))) {
                proc_util::redirect_output(&path)?;
            }
            let cfg = config::load()?;
            // one runner per config: a second `start` (terminal + service) would keep stealing the connection
            let _lock = config::lock_instance()?;
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            match rt.block_on(conn::run(cfg)) {
                conn::Exit::Shutdown => eprintln!("종료합니다"),
                conn::Exit::Unauthorized => {
                    eprintln!("게이트웨이가 이 러너의 토큰을 거부했습니다(대상이 삭제되었거나 다시 페어링됨). 작업대에서 새 페어링 코드를 받아 `aidev-runner pair <코드>`를 실행하세요.");
                    return Ok(ExitCode::from(3));
                }
            }
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
                "screen" => cfg.screen_consent = on,
                // control implies seeing the screen
                "control" => { cfg.control_consent = on; if on { cfg.screen_consent = true; } }
                _ => return Err("지원: consent screen on|off, consent control on|off".into()),
            }
            config::save(&cfg)?;
            println!("화면 보기: {} / 원격 제어(마우스·키보드): {}", if cfg.screen_consent { "허용" } else { "꺼짐" }, if cfg.control_consent { "허용" } else { "꺼짐" });
            println!("(실행 중인 러너는 다시 시작해야 반영됩니다)");
        }
        Cmd::InstallService { print } => println!("{}", service::install(print)?),
        Cmd::UninstallService => println!("{}", service::uninstall()?),
        Cmd::Unpair => {
            let p = config::path();
            if p.exists() { std::fs::remove_file(&p).map_err(|e| e.to_string())?; }
            println!("토큰을 지웠습니다. 작업대 \"원격 대상\"에서도 이 대상을 삭제하세요.");
        }
    }
    Ok(ExitCode::SUCCESS)
}
