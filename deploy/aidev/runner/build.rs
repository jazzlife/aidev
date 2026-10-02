// macOS: the remote screen's ScreenCaptureKit bridge (F-18) is Swift. Its runtime libraries live in /usr/lib/swift
// on macOS 13+ (the runner's minimum there, .cargo/config.toml); libswift_Concurrency is linked through @rpath,
// and a dependency's own rpath does not reach this binary — without this one the runner would not start.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
    }
}
