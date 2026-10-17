import { describe, expect, it } from 'vitest';

import { guessPlatform, pairingSteps } from '@/shared/runnerPairing';

const f = (platform: string) => ({ name: `aidev-runner-0.9.0-${platform}${platform.startsWith('win') ? '.exe' : ''}`, platform, version: '0.9.0', size: 1, sha256: 'x' });
const shipped = ['linux-arm64', 'linux-armv7', 'linux-x64', 'win-x64'].map(f);

describe('runnerPairing', () => {
  it('preselects the platform of the browser, including the CPU of ARM boards', () => {
    expect(guessPlatform(shipped, 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux-x64');
    expect(guessPlatform(shipped, 'Mozilla/5.0 (X11; Linux aarch64)')).toBe('linux-arm64');
    expect(guessPlatform(shipped, 'Mozilla/5.0 (X11; Linux armv7l)')).toBe('linux-armv7');
    expect(guessPlatform(shipped, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win-x64');
    expect(guessPlatform(shipped, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac-universal');
  });
  it('without a binary for the OS, says how to build it there from the served source', () => {
    const mac = pairingSteps({ platform: 'mac-universal', file: undefined, code: 'AB12CD', gateway: 'https://g' });
    expect(mac.prerequisite).toContain('curl -fsSL https://g/_runner/source/aidev-runner-src.tar.gz | tar -xz && ./aidev-runner-src/scripts/build-macos.sh --install --code AB12CD --gateway https://g');
    const win = pairingSteps({ platform: 'win-arm64', file: undefined, code: 'AB12CD', gateway: 'https://g' });
    expect(win.prerequisite).toContain('aidev-runner-src\\scripts\\build-windows.ps1 -InstallTools -Install -Code AB12CD -Gateway https://g');
    expect(pairingSteps({ platform: 'linux-x64', file: f('linux-x64'), code: 'AB12CD', gateway: 'https://g' }).prerequisite).toBeNull();
  });
  it('Android: the app, preselected on an Android browser when shipped, with the APK and a link that fills in the code', () => {
    const apk = { name: 'aidev-runner-0.19.0-android.apk', platform: 'android', version: '0.19.0', size: 1, sha256: 'x' };
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';
    expect(guessPlatform([...shipped, apk], ua)).toBe('android');
    expect(guessPlatform(shipped, ua)).toBe('linux-x64');
    const steps = pairingSteps({ platform: 'android', file: apk, code: 'AB12CD', gateway: 'https://g' });
    expect(steps.links).toEqual([
      { label: 'APK 받기', href: 'https://g/_runner/download/aidev-runner-0.19.0-android.apk' },
      { label: '앱에서 페어링 열기', href: 'nadovibe-runner://pair?code=AB12CD&gateway=https%3A%2F%2Fg' },
    ]);
    expect(steps.prerequisite).toBeNull();
  });
  it('embedded Linux (musl): fetched with wget, which BusyBox has', () => {
    const steps = pairingSteps({ platform: 'linux-arm64-musl', file: f('linux-arm64-musl'), code: 'AB12CD', gateway: 'https://g' });
    expect(steps.commands).toContain('wget -qO ~/.aidev/bin/aidev-runner https://g/_runner/download/aidev-runner-0.9.0-linux-arm64-musl');
    expect(steps.commands).toContain('~/.aidev/bin/aidev-runner install');
  });
});
