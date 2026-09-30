import { describe, expect, it } from 'vitest';

import { guessPlatform, pairingSteps } from '@/modules/remote-target/utils/runnerPairing';

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
});
