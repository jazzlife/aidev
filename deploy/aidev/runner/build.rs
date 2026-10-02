// macOS: the remote screen's ScreenCaptureKit bridge (F-18) is Swift. Its runtime libraries live in /usr/lib/swift
// on macOS 13+ (the runner's minimum there, .cargo/config.toml); libswift_Concurrency is linked through @rpath,
// and a dependency's own rpath does not reach this binary — without this one the runner would not start.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
    }
    // feature `vpx`: the static libvpx (VP9 encoder only) scripts/build-libvpx.* made for this target
    println!("cargo:rerun-if-env-changed=VPX_LIB_DIR");
    if std::env::var_os("CARGO_FEATURE_VPX").is_some() {
        let target = std::env::var("TARGET").unwrap_or_default();
        let dir = std::env::var_os("VPX_LIB_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/libvpx").join(&target).join("lib")
        });
        let lib = dir.join(if target.contains("msvc") { "vpx.lib" } else { "libvpx.a" });
        if !lib.exists() {
            panic!("{} 이(가) 없습니다 — scripts/build-libvpx.sh {target} (Windows: scripts\\build-libvpx.ps1) 로 먼저 빌드하세요", lib.display());
        }
        println!("cargo:rerun-if-changed={}", lib.display());
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=static=vpx");
    }
}
