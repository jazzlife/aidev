//! `sync.*` (IMPLEMENTATION-PLAN §3.12, F-04): the platform copies a project from the user's runtime to
//! this PC (`<allowed root>/<project>`), sending only what changed.
//!   sync.manifest {root}                → {root, exists, files:[{path,size,mtime,sha256,synced}], truncated}
//!   sync.write    {root, files:[{path, b64, offset?, last?, mode?}]} → {written, bytes}
//!   sync.delete   {root, paths}         → {deleted}   (only files an earlier sync wrote)
//! `root` must lie inside allowed_roots; every `path` is relative, without `..`, and stays under root.
//! Files an earlier sync wrote are listed in `<root>/.aidev/sync-state.json`, so a delete can never touch
//! something the user created on this PC. `node_modules`, `.git` and `.aidev` are never listed or written.

use crate::config::Config;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

type RpcResult = Result<Value, (i64, String)>;
const MAX_ENTRIES: usize = 50_000;
const SKIP_DIRS: &[&str] = &["node_modules", ".git", ".aidev"];
const MAX_WRITE_BATCH: usize = 8 * 1024 * 1024;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// A relative path that stays under root: no absolute parts, no `..`, no NUL, no empty segments.
fn rel_path(p: &str) -> Result<PathBuf, String> {
    if p.is_empty() || p.len() > 1024 || p.contains('\0') || p.contains('\\') {
        return Err(format!("잘못된 경로: {p}"));
    }
    let path = Path::new(p);
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => {
                if SKIP_DIRS.iter().any(|d| s == *d) {
                    return Err(format!("동기화하지 않는 폴더: {p}"));
                }
                out.push(s)
            }
            Component::CurDir => {}
            _ => return Err(format!("허용되지 않는 경로: {p}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("잘못된 경로: {p}"));
    }
    Ok(out)
}

fn root_of(cfg: &Config, params: &Value) -> Result<PathBuf, (i64, String)> {
    let root = params.get("root").and_then(Value::as_str).ok_or((-32602, "root 필요".to_string()))?;
    let resolved = crate::roots::resolve(&cfg.allowed_roots, root).map_err(|e| (-32001, e))?;
    // the root itself must be a sub-folder: syncing onto an allowed root would mix projects
    if cfg.allowed_roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| r == resolved) {
        return Err((-32001, "동기화 대상은 허용 폴더 안의 하위 폴더여야 합니다 (예: <허용 폴더>/<프로젝트>)".into()));
    }
    Ok(resolved)
}

fn state_path(root: &Path) -> PathBuf {
    root.join(".aidev").join("sync-state.json")
}

fn load_state(root: &Path) -> BTreeSet<String> {
    std::fs::read(state_path(root))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("files").and_then(Value::as_array).cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn save_state(root: &Path, files: &BTreeSet<String>) -> Result<(), String> {
    let p = state_path(root);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&json!({ "files": files })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn manifest(root: &Path) -> Value {
    if !root.is_dir() {
        return json!({ "root": root.display().to_string(), "exists": false, "files": [], "truncated": false });
    }
    let synced = load_state(root);
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name();
            if ft.is_dir() {
                if !SKIP_DIRS.iter().any(|d| name == *d) {
                    stack.push(entry.path());
                }
                continue;
            }
            if !ft.is_file() {
                continue; // symlinks and specials are never followed
            }
            if files.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let meta = entry.metadata().ok();
            let sha = sha256_file(&path).unwrap_or_default();
            files.push(json!({
                "path": rel, "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "mtime": meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
                "sha256": sha, "synced": synced.contains(&rel),
            }));
        }
    }
    json!({ "root": root.display().to_string(), "exists": true, "files": files, "truncated": truncated })
}

fn write_files(root: &Path, files: &[Value]) -> RpcResult {
    std::fs::create_dir_all(root).map_err(|e| (-32008, e.to_string()))?;
    let mut state = load_state(root);
    let (mut written, mut bytes) = (0usize, 0usize);
    for f in files {
        let path = f.get("path").and_then(Value::as_str).ok_or((-32602, "path 필요".to_string()))?;
        let rel = rel_path(path).map_err(|e| (-32602, e))?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(f.get("b64").and_then(Value::as_str).unwrap_or(""))
            .map_err(|_| (-32602, format!("b64 형식 오류: {path}")))?;
        bytes += data.len();
        if bytes > MAX_WRITE_BATCH {
            return Err((-32602, "한 번에 보낼 수 있는 크기(8MB)를 넘었습니다".into()));
        }
        // checked before anything is created: a parent that resolves outside root (a symlinked folder
        // on this PC) is refused
        let dest = crate::roots::resolve(&[root.to_path_buf()], &root.join(&rel).display().to_string())
            .map_err(|_| (-32001, format!("동기화 폴더 밖을 가리키는 경로: {path}")))?;
        let parent = dest.parent().unwrap_or(root).to_path_buf();
        std::fs::create_dir_all(&parent).map_err(|e| (-32008, format!("{}: {e}", parent.display())))?;
        let part = dest.with_file_name(format!("{}.aidev-part", dest.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
        let offset = f.get("offset").and_then(Value::as_u64).unwrap_or(0);
        let last = f.get("last").and_then(Value::as_bool).unwrap_or(true);
        {
            let mut out = if offset == 0 {
                std::fs::File::create(&part)
            } else {
                std::fs::OpenOptions::new().append(true).open(&part)
            }
            .map_err(|e| (-32008, format!("{}: {e}", part.display())))?;
            out.write_all(&data).map_err(|e| (-32008, e.to_string()))?;
        }
        if last {
            #[cfg(unix)]
            if let Some(mode) = f.get("mode").and_then(Value::as_u64) {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&part, std::fs::Permissions::from_mode((mode as u32 & 0o777) | 0o600));
            }
            if dest.is_dir() {
                return Err((-32008, format!("같은 이름의 폴더가 있습니다: {path}")));
            }
            std::fs::rename(&part, &dest).map_err(|e| (-32008, e.to_string()))?;
            state.insert(rel.to_string_lossy().replace('\\', "/"));
            written += 1;
        }
    }
    save_state(root, &state).map_err(|e| (-32008, e))?;
    Ok(json!({ "written": written, "bytes": bytes }))
}

fn delete_files(root: &Path, paths: &[Value]) -> RpcResult {
    let mut state = load_state(root);
    let mut deleted = 0usize;
    let mut skipped = Vec::new();
    for p in paths {
        let Some(path) = p.as_str() else { continue };
        let rel = rel_path(path).map_err(|e| (-32602, e))?;
        let key = rel.to_string_lossy().replace('\\', "/");
        if !state.contains(&key) {
            skipped.push(key); // not written by a sync: the user's own file stays
            continue;
        }
        let dest = root.join(&rel);
        if dest.is_file() && std::fs::remove_file(&dest).is_ok() {
            deleted += 1;
        }
        state.remove(&key);
        // prune now-empty folders up to root
        let mut dir = dest.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == root || std::fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }
    save_state(root, &state).map_err(|e| (-32008, e))?;
    Ok(json!({ "deleted": deleted, "skipped": skipped }))
}

const MAX_PULL_CHUNK: u64 = 4 * 1024 * 1024;

/// `fs.pull {path, offset?, length?}` → {path, size, mtime, offset, b64, eof, sha256 (with offset 0)}: one chunk
/// (≤ 4 MB) of a file inside allowed_roots, so the platform can copy it off this PC — logs, build outputs, crash
/// dumps, an APK (SSH's scp / adb pull). Any content, text or binary; the whole-file sha256 checks the copy.
pub fn pull(cfg: &Config, params: &Value) -> RpcResult {
    use std::io::Seek;
    let path = params.get("path").and_then(Value::as_str).unwrap_or("");
    let real = crate::roots::resolve(&cfg.allowed_roots, path).map_err(|e| (-32001, e))?;
    let meta = std::fs::metadata(&real).map_err(|e| (-32001, format!("{}: {e}", real.display())))?;
    if !meta.is_file() {
        return Err((-32001, format!("파일이 아닙니다: {}", real.display())));
    }
    let size = meta.len();
    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0).min(size);
    let length = params.get("length").and_then(Value::as_u64).unwrap_or(MAX_PULL_CHUNK).clamp(1, MAX_PULL_CHUNK);
    let mut f = std::fs::File::open(&real).map_err(|e| (-32001, format!("{}: {e}", real.display())))?;
    f.seek(std::io::SeekFrom::Start(offset)).map_err(|e| (-32001, e.to_string()))?;
    let mut buf = Vec::with_capacity(length.min(size - offset) as usize);
    f.take(length).read_to_end(&mut buf).map_err(|e| (-32001, e.to_string()))?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
    let mut out = json!({
        "path": real.display().to_string(), "size": size, "mtime": mtime, "offset": offset,
        "b64": base64::engine::general_purpose::STANDARD.encode(&buf), "eof": offset + buf.len() as u64 >= size,
    });
    if offset == 0 {
        out["sha256"] = json!(sha256_file(&real).map_err(|e| (-32001, e.to_string()))?);
    }
    Ok(out)
}

/// JSON-RPC entry point for `sync.*`; None when the method is not a sync method.
pub async fn rpc(cfg: &Config, method: &str, params: &Value) -> Option<RpcResult> {
    if !method.starts_with("sync.") {
        return None;
    }
    let root = match root_of(cfg, params) {
        Ok(r) => r,
        Err(e) => return Some(Err(e)),
    };
    let params = params.clone();
    let method = method.to_string();
    // file IO off the connection task
    Some(
        tokio::task::spawn_blocking(move || match method.as_str() {
            "sync.manifest" => Ok(manifest(&root)),
            "sync.write" => write_files(&root, params.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])),
            "sync.delete" => delete_files(&root, params.get("paths").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])),
            other => Err((-32601, format!("method not found: {other}"))),
        })
        .await
        .unwrap_or_else(|e| Err((-32603, e.to_string()))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_reads_any_file_in_roots_in_chunks() {
        let (c, root) = cfg();
        let data: Vec<u8> = (0..(MAX_PULL_CHUNK as usize + 1000)).map(|i| (i % 251) as u8).collect();
        std::fs::write(root.join("big.bin"), &data).unwrap();
        let path = root.join("big.bin").display().to_string();
        let first = pull(&c, &json!({ "path": path })).unwrap();
        assert_eq!(first["size"], data.len() as u64);
        assert_eq!(first["eof"], false);
        assert_eq!(first["sha256"], sha256_bytes(&data));
        let mut got = base64::engine::general_purpose::STANDARD.decode(first["b64"].as_str().unwrap()).unwrap();
        let rest = pull(&c, &json!({ "path": path, "offset": got.len() })).unwrap();
        assert_eq!(rest["eof"], true);
        assert!(rest.get("sha256").is_none());
        got.extend(base64::engine::general_purpose::STANDARD.decode(rest["b64"].as_str().unwrap()).unwrap());
        assert_eq!(got, data);
        assert!(pull(&c, &json!({ "path": "/etc/hosts" })).is_err(), "outside allowed_roots");
        assert!(pull(&c, &json!({ "path": root.display().to_string() })).unwrap_err().1.contains("파일이 아닙니다"));
    }

    fn cfg() -> (Config, PathBuf) {
        use rand::Rng;
        let base = std::env::temp_dir().join(format!("aidev-sync-{}", rand::thread_rng().gen::<u64>()));
        std::fs::create_dir_all(&base).unwrap();
        (Config { allowed_roots: vec![base.clone()], ..Default::default() }, base)
    }
    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[tokio::test]
    async fn write_manifest_delete_roundtrip() {
        let (c, base) = cfg();
        let root = base.join("proj").display().to_string();
        let m = rpc(&c, "sync.manifest", &json!({ "root": root })).await.unwrap().unwrap();
        assert_eq!(m["exists"], false);
        let w = rpc(&c, "sync.write", &json!({ "root": root, "files": [
            { "path": "src/a.txt", "b64": b64("hello") },
            { "path": "run.sh", "b64": b64("#!/bin/sh\necho hi\n"), "mode": 0o755 },
            { "path": "big.bin", "b64": b64("part1-"), "offset": 0, "last": false },
        ] })).await.unwrap().unwrap();
        assert_eq!(w["written"], 2);
        rpc(&c, "sync.write", &json!({ "root": root, "files": [{ "path": "big.bin", "b64": b64("part2"), "offset": 6, "last": true }] })).await.unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(base.join("proj/big.bin")).unwrap(), "part1-part2");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(base.join("proj/run.sh")).unwrap().permissions().mode() & 0o111, 0o111);
        }
        std::fs::write(base.join("proj/mine.txt"), "user file").unwrap();
        std::fs::create_dir_all(base.join("proj/node_modules/x")).unwrap();
        std::fs::write(base.join("proj/node_modules/x/i.js"), "x").unwrap();
        let m = rpc(&c, "sync.manifest", &json!({ "root": root })).await.unwrap().unwrap();
        let files = m["files"].as_array().unwrap();
        assert_eq!(files.len(), 4, "{files:?}");
        let a = files.iter().find(|f| f["path"] == "src/a.txt").unwrap();
        assert_eq!(a["sha256"], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert_eq!(a["synced"], true);
        assert_eq!(files.iter().find(|f| f["path"] == "mine.txt").unwrap()["synced"], false);
        let d = rpc(&c, "sync.delete", &json!({ "root": root, "paths": ["src/a.txt", "mine.txt"] })).await.unwrap().unwrap();
        assert_eq!(d["deleted"], 1);
        assert!(!base.join("proj/src").exists(), "empty folder pruned");
        assert!(base.join("proj/mine.txt").exists(), "user's own file kept");
    }

    #[tokio::test]
    async fn refuses_escapes() {
        let (c, base) = cfg();
        let root = base.join("proj").display().to_string();
        for bad in ["../x", "/etc/passwd", "a/../../x", "node_modules/a.js", ".git/config", ""] {
            let r = rpc(&c, "sync.write", &json!({ "root": root, "files": [{ "path": bad, "b64": b64("x") }] })).await.unwrap();
            assert!(r.is_err(), "{bad} accepted");
        }
        assert!(rpc(&c, "sync.manifest", &json!({ "root": "/etc" })).await.unwrap().is_err());
        assert!(rpc(&c, "sync.manifest", &json!({ "root": base.display().to_string() })).await.unwrap().is_err(), "the allowed root itself is not a sync target");
        #[cfg(unix)]
        {
            std::fs::create_dir_all(base.join("proj")).unwrap();
            std::os::unix::fs::symlink("/tmp", base.join("proj/link")).unwrap();
            let r = rpc(&c, "sync.write", &json!({ "root": root, "files": [{ "path": "link/evil.txt", "b64": b64("x") }] })).await.unwrap();
            assert!(r.is_err(), "symlinked parent accepted");
        }
    }
}
