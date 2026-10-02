/**
 * Pairing instructions for a runner, per OS (F-02): the exact lines a person pastes into a terminal on the
 * PC. Every OS installs to one fixed path — the same one ops/runner/install.sh uses on the Mac — so the
 * service (LaunchAgent / systemd user unit / logon task) keeps pointing at a file that stays put:
 *   macOS, Linux  ~/.aidev/bin/aidev-runner           (bash and zsh; no `#` comments — zsh treats them as words)
 *   Windows       $HOME\.aidev\bin\aidev-runner.exe   (PowerShell; `&` runs a quoted path)
 * Module-private to remote-target (TargetsPanel), kept apart so the generated lines can be tested in real shells.
 */
import type { RunnerFile } from '@/shared/types';

/** The OS family a platform id (`mac-arm64`, `linux-x64`, `win-x64`, …) belongs to. */
function platformFamily(platform: string): 'mac' | 'linux' | 'windows' {
  return platform.startsWith('win') ? 'windows' : platform.startsWith('mac') ? 'mac' : 'linux';
}

/** The platform to preselect: the one matching the browser's OS when the release ships it, else a sensible default. */
export function guessPlatform(files: RunnerFile[], userAgent: string, userAgentPlatform = ''): string {
  const ua = `${userAgentPlatform} ${userAgent}`.toLowerCase();
  const family = /win/.test(ua) ? 'windows' : /mac|iphone|ipad/.test(ua) ? 'mac' : /linux|x11|android/.test(ua) ? 'linux' : null;
  const shipped = files.map((f) => f.platform ?? '').filter(Boolean);
  if (family) {
    // the CPU when the browser tells it (a Raspberry Pi / ARM laptop browser), else the common one
    const cpu = /aarch64|arm64/.test(ua) ? 'arm64' : /armv7|armv8l|armhf/.test(ua) ? 'armv7' : 'x64';
    const want = family === 'mac' ? 'mac-universal' : family === 'windows' ? `win-${cpu === 'armv7' ? 'x64' : cpu}` : `linux-${cpu}`;
    const match = shipped.find((p) => p === want) ?? shipped.find((p) => platformFamily(p) === family && p.endsWith('universal'))
      ?? shipped.find((p) => platformFamily(p) === family && p.endsWith('-x64')) ?? shipped.find((p) => platformFamily(p) === family);
    return match ?? want;
  }
  return shipped[0] ?? 'mac-universal';
}

export type PairingSteps = {
  /** What to paste (one command per line). */
  commands: string;
  /** Where to paste it. */
  shell: string;
  /** Said before the commands when the release has no binary for this OS (built on a Mac instead). */
  prerequisite: string | null;
};

/** The lines to install, pair and start the runner on a PC of `platform`. */
export function pairingSteps(p: { platform: string; file: RunnerFile | undefined; code: string; gateway: string }): PairingSteps {
  const family = platformFamily(p.platform);
  if (family === 'windows') {
    const exe = '"$HOME\\.aidev\\bin\\aidev-runner.exe"';
    const lines = [
      ...(p.file ? [
        'New-Item -ItemType Directory -Force "$HOME\\.aidev\\bin" | Out-Null',
        `curl.exe -fsSL ${p.gateway}/_runner/download/${p.file.name} -o ${exe}`,
      ] : []),
      `& ${exe} pair ${p.code} --gateway ${p.gateway}`,
      `& ${exe} service`,
    ];
    return {
      commands: lines.join('\n'),
      shell: 'PowerShell',
      prerequisite: p.file ? null : `이 릴리스에는 ${p.platform} 러너가 없습니다 — 이 PC에서 소스로 빌드·설치하세요 (PowerShell): `
        + `curl.exe -fsSL ${p.gateway}/_runner/source/aidev-runner-src.tar.gz -o aidev-runner-src.tar.gz; tar -xzf aidev-runner-src.tar.gz; `
        + `powershell -ExecutionPolicy Bypass -File aidev-runner-src\\scripts\\build-windows.ps1 -InstallTools -Install -Code ${p.code} -Gateway ${p.gateway} — 또는 빌드한 aidev-runner.exe를 ${'$HOME\\.aidev\\bin\\'}에 넣은 뒤 아래를 실행`,
    };
  }
  const exe = '~/.aidev/bin/aidev-runner';
  const lines = [
    ...(p.file ? [
      'mkdir -p ~/.aidev/bin',
      `curl -fsSL ${p.gateway}/_runner/download/${p.file.name} -o ${exe}`,
      `chmod +x ${exe}`,
    ] : []),
    `${exe} pair ${p.code} --gateway ${p.gateway}`,
    `${exe} service`,
  ];
  return {
    commands: lines.join('\n'),
    shell: family === 'mac' ? '터미널 (zsh)' : '터미널 (bash)',
    prerequisite: p.file ? null
      : `이 릴리스에는 ${p.platform} 러너가 없습니다 — 이 ${family === 'mac' ? 'Mac' : 'PC'}에서 소스로 빌드·설치하세요: `
        + `curl -fsSL ${p.gateway}/_runner/source/aidev-runner-src.tar.gz | tar -xz && ./aidev-runner-src/scripts/build-${family === 'mac' ? 'macos' : 'linux'}.sh --install --code ${p.code} --gateway ${p.gateway}`
        + (family === 'mac' ? ' (ops 폴더가 있으면 ./runner/build.sh mac)' : '') + ' — 또는 빌드한 aidev-runner를 ~/.aidev/bin/ 에 넣은 뒤 아래를 실행',
  };
}
