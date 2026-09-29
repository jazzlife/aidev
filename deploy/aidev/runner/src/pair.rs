//! Pairing: the one-time code shown in the workbench ("원격 대상" → 등록) is exchanged for this
//! target's token. The code expires after 10 minutes and works once.

use crate::{caps, config};
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct PairResponse {
    token: String,
    target_id: u64,
    name: String,
}

/// https only, except a local development gateway.
pub fn check_gateway(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    let local = ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|p| trimmed.starts_with(p));
    if !(trimmed.starts_with("https://") || local) {
        return Err("게이트웨이 주소는 https:// 로 시작해야 합니다 (예: https://dev.nado.work)".into());
    }
    Ok(trimmed.to_string())
}

pub fn pair(code: &str, gateway: &str, name: Option<&str>) -> Result<config::Config, String> {
    let gateway = check_gateway(gateway)?;
    let code = code.trim().to_uppercase();
    if !(code.len() >= 6 && code.len() <= 16 && code.chars().all(|c| c.is_ascii_alphanumeric())) {
        return Err("페어링 코드 형식이 올바르지 않습니다".into());
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
    let body = serde_json::json!({
        "code": code,
        "hostname": caps::hostname(),
        "platform": caps::platform(),
        "arch": std::env::consts::ARCH,
        "runner": env!("CARGO_PKG_VERSION"),
        "name": name,
    });
    let response = agent.post(&format!("{gateway}/_runner/pair")).send_json(body);
    let parsed: PairResponse = match response {
        Ok(r) => r.into_json().map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?,
        Err(ureq::Error::Status(status, r)) => {
            let text = r.into_string().unwrap_or_default();
            return Err(format!("페어링 실패 ({status}): {}", text.chars().take(200).collect::<String>()));
        }
        Err(e) => return Err(format!("게이트웨이에 연결하지 못했습니다: {e}")),
    };
    let previous = config::load().ok();
    let roots = previous.as_ref().map(|c| c.allowed_roots.clone()).filter(|r| !r.is_empty()).unwrap_or_else(|| vec![config::default_root()]);
    for root in &roots {
        let _ = std::fs::create_dir_all(root);
    }
    let cfg = config::Config {
        gateway,
        token: parsed.token,
        target_id: parsed.target_id,
        name: parsed.name,
        allowed_roots: roots,
        screen_consent: previous.as_ref().map(|c| c.screen_consent).unwrap_or(false),
        inherit_env: previous.as_ref().map(|c| c.inherit_env).unwrap_or(false),
    };
    config::save(&cfg)?;
    Ok(cfg)
}
