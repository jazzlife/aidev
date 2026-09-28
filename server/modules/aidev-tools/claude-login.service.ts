import crypto from 'node:crypto';
import os from 'node:os';

import pty, { type IPty } from 'node-pty';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { aidevToolsService } from '@/modules/aidev-tools/aidev-tools.service.js';
// Lazy for the same reason as lesson-curator: providers imports this module's barrel.
const loadAuthStore = async () => (await import('@/modules/providers/index.js')).claudeAuthStore;

/**
 * In-app Claude subscription login (no terminal, works from the mobile app too): the runtime
 * drives `claude setup-token` in a private pseudo-terminal, hands the sign-in URL to the UI,
 * types the code the user pastes back, and stores the resulting 1-year token itself.
 * One login at a time per runtime; an abandoned one is killed after LOGIN_TTL_MS.
 */
type ActiveLogin = { id: string; pty: IPty; output: string; url: string | null; timer: NodeJS.Timeout };

const LOGIN_TTL_MS = 10 * 60 * 1000;
const URL_WAIT_MS = 45_000;
const TOKEN_WAIT_MS = 90_000;
// Wide enough that neither the sign-in URL nor the token is wrapped across lines.
const PTY_COLS = 4000;

let active: ActiveLogin | null = null;

/** Terminal output → plain text: cursor-forward becomes a space, every other escape is dropped. */
function toPlainText(chunk: string) {
  return chunk
    .replace(/\x1b\[(\d*)C/g, (_match, count: string) => ' '.repeat(Math.min(Number(count || 1), 8)))
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[78=>()]/g, '');
}

function stop(login: ActiveLogin | null) {
  if (!login) return;
  clearTimeout(login.timer);
  try { login.pty.kill(); } catch { /* already gone */ }
  if (active === login) active = null;
}

/** Resolves with the first match of `pattern` in the login's output, or rejects after `timeoutMs`. */
function waitFor(login: ActiveLogin, pattern: RegExp, timeoutMs: number, fromIndex = 0): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = login.output.slice(fromIndex).match(pattern);
      if (match) { cleanup(); resolve(match); }
    };
    const onExit = () => { cleanup(); reject(new Error(`로그인 프로세스가 종료되었습니다: ${login.output.slice(-300).replace(/\s+/g, ' ').trim()}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('시간 초과')); }, timeoutMs);
    const dataSub = login.pty.onData(check);
    const exitSub = login.pty.onExit(onExit);
    function cleanup() { clearTimeout(timer); dataSub.dispose(); exitSub.dispose(); }
    check();
  });
}

/** Used by aidev-tools.routes.ts for the in-app login endpoints. */
export const claudeLoginService = {
  /** Starts `claude setup-token` and returns the sign-in URL the user must open. */
  async start(): Promise<{ loginId: string; url: string }> {
    stop(active);
    const cli = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
    const env = { ...process.env, TERM: 'xterm-256color', BROWSER: 'true' } as Record<string, string>;
    // the login being replaced must not decide how the new one runs
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const child = pty.spawn(cli, ['setup-token'], { name: 'xterm-256color', cols: PTY_COLS, rows: 50, cwd: os.homedir(), env });
    const login: ActiveLogin = { id: crypto.randomUUID(), pty: child, output: '', url: null, timer: setTimeout(() => stop(login), LOGIN_TTL_MS) };
    child.onData((chunk) => { login.output += toPlainText(chunk); if (login.output.length > 200_000) login.output = login.output.slice(-100_000); });
    child.onExit(() => { if (active === login) { clearTimeout(login.timer); active = null; } });
    active = login;
    try {
      const match = await waitFor(login, /https:\/\/\S*oauth\/authorize\S+/, URL_WAIT_MS);
      login.url = match[0];
      return { loginId: login.id, url: login.url };
    } catch (error) {
      stop(login);
      throw new Error(`로그인 주소를 받지 못했습니다 (${error instanceof Error ? error.message : String(error)})`);
    }
  },

  /** Types the pasted authorization code, waits for the issued token and stores it. */
  async submitCode(loginId: string, code: string): Promise<{ issuedAt: number; expiresAt: number }> {
    const login = active;
    if (!login || login.id !== loginId) throw new Error('로그인 세션이 없거나 만료되었습니다. 다시 시작하세요.');
    const trimmed = code.trim();
    if (!trimmed || trimmed.length > 2000 || /\s/.test(trimmed)) throw new Error('인증 코드 형식이 올바르지 않습니다.');
    const from = login.output.length;
    login.pty.write(trimmed);
    login.pty.write('\r');
    try {
      const token = waitFor(login, /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/, TOKEN_WAIT_MS, from);
      const refusal = waitFor(login, /(invalid|expired|error)[^\n]{0,160}/i, TOKEN_WAIT_MS, from).then((failure) => { throw new Error(failure[0].trim()); });
      // the losing waiter rejects when the pty is stopped below; that is expected, not an error
      token.catch(() => undefined);
      refusal.catch(() => undefined);
      const match = await Promise.race([token, refusal]);
      const saved = (await loadAuthStore()).save(match[0]);
      console.log(`[aidev-tools] Claude subscription token stored (expires ${new Date(saved.expiresAt).toISOString().slice(0, 10)})`);
      void aidevToolsService.reportClaudeAuth({ expires_at: saved.expiresAt });
      return saved;
    } finally {
      stop(login);
    }
  },

  /** Current platform-managed token and any recorded auth failure. */
  async status() {
    const store = await loadAuthStore();
    return { token: store.info(), failure: store.currentFailure() };
  },

  cancel(loginId: string) {
    if (active?.id === loginId) stop(active);
  },
};
