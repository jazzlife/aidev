//! `allowed_roots`: every path the platform sends is resolved (symlinks, `..`) and must stay inside
//! one of the configured folders. Paths that do not exist yet are checked through their nearest
//! existing ancestor, so a new file cannot escape through a symlinked parent either.

use std::path::{Component, Path, PathBuf};

/// Resolves `requested` (absolute, or relative to the first root) and returns it when it lies inside
/// an allowed root.
pub fn resolve(roots: &[PathBuf], requested: &str) -> Result<PathBuf, String> {
    if roots.is_empty() {
        return Err("허용된 폴더(allowed_roots)가 없습니다".into());
    }
    if requested.is_empty() || requested.contains('\0') {
        return Err("잘못된 경로".into());
    }
    let raw = Path::new(requested);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { roots[0].join(raw) };
    let real = real_path(&joined)?;
    for root in roots {
        let Ok(root_real) = std::fs::canonicalize(root) else { continue };
        if real == root_real || real.starts_with(&root_real) {
            return Ok(real);
        }
    }
    Err(format!("허용된 폴더 밖입니다: {requested}"))
}

/// Canonical path of `p`; for a path that does not exist yet, the canonical nearest existing
/// ancestor plus the remaining (normalised, `..`-free) components.
fn real_path(p: &Path) -> Result<PathBuf, String> {
    if let Ok(c) = std::fs::canonicalize(p) {
        return Ok(c);
    }
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = std::fs::canonicalize(&cur) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return Ok(out);
        }
        match (cur.file_name().map(|s| s.to_os_string()), cur.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                if matches!(Path::new(&name).components().next(), Some(Component::ParentDir)) {
                    return Err("존재하지 않는 경로의 ..은 허용하지 않습니다".into());
                }
                rest.push(name);
                cur = parent;
            }
            _ => return Err(format!("경로를 확인할 수 없습니다: {}", p.display())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aidev-roots-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("work/app")).unwrap();
        std::fs::create_dir_all(d.join("secret")).unwrap();
        std::fs::write(d.join("secret/key"), "x").unwrap();
        d
    }

    #[test]
    fn inside_and_relative() {
        let d = tmp("inside");
        let roots = vec![d.join("work")];
        assert!(resolve(&roots, "app").is_ok());
        assert!(resolve(&roots, d.join("work/app/new-file.txt").to_str().unwrap()).is_ok());
        assert!(resolve(&roots, "app/not/yet/created").is_ok());
    }

    #[test]
    fn escapes_are_refused() {
        let d = tmp("escape");
        let roots = vec![d.join("work")];
        assert!(resolve(&roots, "../secret/key").is_err());
        assert!(resolve(&roots, d.join("secret/key").to_str().unwrap()).is_err());
        assert!(resolve(&roots, "app/../../secret").is_err());
        assert!(resolve(&roots, "/etc/passwd").is_err());
        assert!(resolve(&[], "app").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_is_refused() {
        let d = tmp("symlink");
        let roots = vec![d.join("work")];
        std::os::unix::fs::symlink(d.join("secret"), d.join("work/link")).unwrap();
        assert!(resolve(&roots, "link/key").is_err());
        assert!(resolve(&roots, "link/new-file").is_err());
    }
}
