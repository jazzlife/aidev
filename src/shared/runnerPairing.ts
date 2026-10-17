/**
 * Pairing instructions for a runner, per OS (F-02): the exact lines a person pastes into a terminal on the
 * PC. Every OS installs to one fixed path — the same one ops/runner/install.sh uses on the Mac — so the
 * service (LaunchAgent / systemd user unit / logon task) keeps pointing at a file that stays put:
 *   macOS, Linux  ~/.aidev/bin/aidev-runner           (bash and zsh; no `#` comments — zsh treats them as words)
 *   Windows       $HOME\.aidev\bin\aidev-runner.exe   (PowerShell; `&` runs a quoted path)
 *   embedded Linux (`linux-*-musl`)  the same, fetched with wget (BusyBox images often have no curl)
 *   Android       the NadoVibe 러너 app (`android`, an APK): steps to install it, and a link that fills in the code
 * Used by remote-target's TargetsPanel and the mobile app's PC screen (pairingSteps). Shared rather than exported from
 * remote-target, whose barrel also carries the run console (xterm) the phone's pairing screen must not download.
 */
import type { RunnerFile } from '@/shared/types';

/** The OS family a platform id (`mac-arm64`, `linux-x64`, `win-x64`, `android`, …) belongs to. */
function platformFamily(platform: string): 'mac' | 'linux' | 'windows' | 'android' {
  return platform.startsWith('win') ? 'windows' : platform.startsWith('mac') ? 'mac' : platform.startsWith('android') ? 'android' : 'linux';
}

/** The platform to preselect: the one matching the browser's OS when the release ships it, else a sensible default. */
export function guessPlatform(files: RunnerFile[], userAgent: string, userAgentPlatform = ''): string {
  const ua = `${userAgentPlatform} ${userAgent}`.toLowerCase();
  const family = /win/.test(ua) ? 'windows' : /mac|iphone|ipad/.test(ua) ? 'mac' : /linux|x11|android/.test(ua) ? 'linux' : null;
  const shipped = files.map((f) => f.platform ?? '').filter(Boolean);
  // an Android browser (its UA also says Linux): the app, when the release has it
  if (/android/.test(ua) && shipped.includes('android')) return 'android';
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
  /** Links to open on the device itself (Android: the APK, and the app with the code filled in). */
  links: Array<{ label: string; href: string }>;
};

/** The lines to install, pair and start the runner on a PC of `platform`. */
export function pairingSteps(p: { platform: string; file: RunnerFile | undefined; code: string; gateway: string }): PairingSteps {
  const family = platformFamily(p.platform);
  if (family === 'android') {
    const apk = p.file ? `${p.gateway}/_runner/download/${p.file.name}` : null;
    const app = `nadovibe-runner://pair?code=${encodeURIComponent(p.code)}&gateway=${encodeURIComponent(p.gateway)}`;
    return {
      commands: [
        `1. 그 기기의 브라우저에서 APK 받기: ${apk ?? '(이 릴리스에 없음)'}`,
        '2. 받은 파일을 열어 설치 (처음이면 "출처를 알 수 없는 앱" 허용)',
        `3. 앱에 페어링 코드 ${p.code}, 게이트웨이 ${p.gateway} → 페어링 (또는 그 기기에서 이 링크: ${app})`,
        '4. 앱의 권한 목록에서 ✗ 항목을 "허용" — 알림·배터리 최적화 제외·저장소. 부팅 때 자동으로 다시 연결합니다',
      ].join('\n'),
      shell: 'Android 기기',
      prerequisite: apk ? null : '이 릴리스에는 Android 앱이 없습니다 — deploy/aidev/runner/scripts/build-android.sh로 빌드해 runner/dist에 넣으세요',
      links: [...(apk ? [{ label: 'APK 받기', href: apk }] : []), { label: '앱에서 페어링 열기', href: app }],
    };
  }
  if (family === 'windows') {
    const exe = '"$HOME\\.aidev\\bin\\aidev-runner.exe"';
    const lines = [
      ...(p.file ? [
        'New-Item -ItemType Directory -Force "$HOME\\.aidev\\bin" | Out-Null',
        `curl.exe -fsSL ${p.gateway}/_runner/download/${p.file.name} -o ${exe}`,
      ] : []),
      `& ${exe} pair ${p.code} --gateway ${p.gateway}`,
      `& ${exe} install`,
    ];
    return {
      commands: lines.join('\n'),
      shell: 'PowerShell',
      links: [],
      prerequisite: p.file ? null : `이 릴리스에는 ${p.platform} 러너가 없습니다 — 이 PC에서 소스로 빌드·설치하세요 (PowerShell): `
        + `curl.exe -fsSL ${p.gateway}/_runner/source/aidev-runner-src.tar.gz -o aidev-runner-src.tar.gz; tar -xzf aidev-runner-src.tar.gz; `
        + `powershell -ExecutionPolicy Bypass -File aidev-runner-src\\scripts\\build-windows.ps1 -InstallTools -Install -Code ${p.code} -Gateway ${p.gateway} — 또는 빌드한 aidev-runner.exe를 ${'$HOME\\.aidev\\bin\\'}에 넣은 뒤 아래를 실행`,
    };
  }
  const exe = '~/.aidev/bin/aidev-runner';
  const url = p.file ? `${p.gateway}/_runner/download/${p.file.name}` : '';
  const lines = [
    ...(p.file ? [
      'mkdir -p ~/.aidev/bin',
      p.platform.endsWith('-musl') ? `wget -qO ${exe} ${url}` : `curl -fsSL ${url} -o ${exe}`,
      `chmod +x ${exe}`,
    ] : []),
    `${exe} pair ${p.code} --gateway ${p.gateway}`,
    `${exe} install`,
  ];
  return {
    commands: lines.join('\n'),
    shell: family === 'mac' ? '터미널 (zsh)' : p.platform.endsWith('-musl') ? '터미널 (sh · SSH · 시리얼 콘솔)' : '터미널 (bash)',
    links: [],
    prerequisite: p.file ? null
      : `이 릴리스에는 ${p.platform} 러너가 없습니다 — 이 ${family === 'mac' ? 'Mac' : 'PC'}에서 소스로 빌드·설치하세요: `
        + `curl -fsSL ${p.gateway}/_runner/source/aidev-runner-src.tar.gz | tar -xz && ./aidev-runner-src/scripts/build-${family === 'mac' ? 'macos' : 'linux'}.sh --install --code ${p.code} --gateway ${p.gateway}`
        + (family === 'mac' ? ' (ops 폴더가 있으면 ./runner/build.sh mac)' : '') + ' — 또는 빌드한 aidev-runner를 ~/.aidev/bin/ 에 넣은 뒤 아래를 실행',
  };
}
