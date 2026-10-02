//! macOS privacy permissions the runner needs for the live screen and remote control: Screen Recording (window
//! capture) and Accessibility (mouse and keyboard). macOS only grants them with a click in System Settings, so the
//! first run in a desktop session asks for both at once; once granted nothing asks again (`request_once` checks first
//! and stays silent). They stay granted across runner updates because every build is signed with the same identity
//! (scripts/install-macos.sh — a stable designated requirement instead of a per-build ad-hoc hash).

use std::ffi::c_void;

type CFTypeRef = *const c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFTypeRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFDictionaryCreate(allocator: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, count: isize, key_cb: *const c_void, value_cb: *const c_void) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
}

/// (screen recording, accessibility) granted now.
pub fn granted() -> (bool, bool) {
    unsafe { (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted()) }
}

/// Asks for what is missing — both prompts together, on the first run — and logs what is still to be allowed.
pub fn request_once() {
    let (screen, control) = granted();
    if screen && control {
        return;
    }
    unsafe {
        if !screen {
            CGRequestScreenCaptureAccess();
        }
        if !control {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let options = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
            AXIsProcessTrustedWithOptions(options);
            if !options.is_null() {
                CFRelease(options);
            }
        }
    }
    eprintln!(
        "macOS 권한 요청: {}{} — 시스템 설정 → 개인정보 보호 및 보안에서 aidev-runner를 한 번 켜 주세요 (이후 업데이트해도 유지됨)",
        if screen { "" } else { "화면 기록 " },
        if control { "" } else { "손쉬운 사용" },
    );
}
