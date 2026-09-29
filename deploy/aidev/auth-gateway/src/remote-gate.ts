import crypto from 'node:crypto';

import type { openStore } from './store.js';
import type { TargetRow } from './store-aidev.js';
import type { LayaClient } from './laya.js';
import type { Push } from './push.js';
import { decide } from './laya-questions.js';
import type { ExecParams, RunnerHub, StreamInfo } from './runner-hub.js';

/**
 * Remote execution gate for agents (IMPLEMENTATION-PLAN §3.12, F-05). An agent's `remote_exec`
 * arrives here (runtime session); the user's own commands from the workbench do not.
 *
 *   risk   = rules first (destructive patterns → 2; read/build/test commands → ≤0.5) + Laya `remote.approve` (0…2)
 *   policy = deny → refused · destructive → always ask ·
 *            ask  → only read/build/test commands run without asking ·
 *            auto → ask only when risk ≥ 1.5
 * A pending approval lives 10 minutes; the user answers from the chat card (workbench / mobile,
 * with a web push) and may switch the target to `auto` in the same tap. Every outcome — started,
 * denied, expired — is a remote_runs row. A remote test command also sets the chat run's
 * test_result, so the run's outcome (and the lessons learned from it) reflects the real result.
 */
type Store = ReturnType<typeof openStore>;

export type Assessment = { risk: number; destructive: boolean; safe: boolean; reasons: string[]; decisionId: number | null; laya: number | null };
export type ApprovalView = {
  id: string; targetId: number; targetName: string; cmd: string; cwd: string | null; agent: string | null; runId: number | null;
  risk: number; reasons: string[]; destructive: boolean; policy: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired'; createdAt: number; expiresAt: number; decidedAt: number | null; decidedBy: string | null;
  remoteRunId: number | null; error: string | null;
};
type Approval = ApprovalView & { userId: number; exec: ExecParams; waiters: Set<() => void> };
export type GateResult =
  | { status: 'started'; stream: StreamInfo; approval: ApprovalView | null; assessment: Assessment }
  | { status: 'pending'; approval: ApprovalView; assessment: Assessment }
  | { status: 'denied'; reason: string; approval: ApprovalView | null; assessment: Assessment | null };

const APPROVAL_TTL_MS = 10 * 60_000;
const KEEP_DECIDED_MS = 5 * 60_000;

/** Destructive or system-changing shapes: always asked, whatever Laya says. */
const DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\b|--recursive|--force)/, '파일 삭제 (rm -r/-f)'],
  [/\b(sudo|doas)\b|\bsu\s+-?\s*\w*/, '관리자 권한 (sudo)'],
  [/\bdd\s+if=|\bmkfs\b|\bdiskutil\s+(erase|partition|reformat|unmount)|\bformat\s+[a-z]:/i, '디스크 조작'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, '시스템 종료·재시작'],
  [/\b(chmod|chown)\s+-R\b/, '권한 일괄 변경'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|iex|powershell)\b/i, '내려받은 스크립트 바로 실행'],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f/, '되돌리기 어려운 git 작업'],
  [/\b(brew|apt|apt-get|yum|dnf|pacman|choco|winget)\s+(install|uninstall|remove|purge|upgrade)\b|\bnpm\s+(i|install|uninstall)\s+(-g|--global)\b|\bpip3?\s+install\b(?![^;&|]*(-r\b|--user|\.\s|-e\s))/, '시스템 소프트웨어 설치·제거'],
  [/\b(launchctl|systemctl|defaults\s+write|crontab\s+-r|security\s+(delete|add)|csrutil|spctl|nvram|scutil)\b/, '시스템 설정 변경'],
  [/\b(del|erase)\s+\/[sSqQ]|\brd\s+\/s|\bRemove-Item\b[^;&|]*-Recurse/i, '파일 삭제 (Windows)'],
  [/\bdrop\s+(database|table|schema)\b|\btruncate\s+table\b/i, '데이터베이스 삭제'],
  [/\b(kill|pkill|killall)\b/, '프로세스 종료'],
  [/>\s*\/dev\/(sd|disk|nvme)|:\(\)\s*\{/, '장치 덮어쓰기·폭주 스크립트'],
  [/(^|[\s;&|])(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/?(\s|$)/, '홈 폴더 전체 대상'],
];

/** Commands that only read, build or test: fine to run without a tap under policy `ask`. */
const SAFE_HEAD = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'whereis', 'type', 'env', 'printenv', 'uname', 'sw_vers', 'whoami', 'id', 'date', 'df', 'du', 'ps', 'top', 'file', 'stat', 'tree', 'find', 'grep', 'rg', 'ag', 'diff', 'sort', 'uniq', 'less', 'more', 'jq', 'true', 'test', 'sleep', 'nproc', 'sysctl', 'system_profiler', 'xcode-select', 'xcrun', 'lsof', 'netstat', 'ping', 'curl', 'wget', 'open', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'pytest', 'tox', 'flutter', 'dart', 'adb', 'sdb', 'tizen', 'gradle', './gradlew', 'gradlew', 'mvn', 'swift', 'xcodebuild', 'cmake', 'make', 'ninja', 'dotnet', 'rustc', 'javac']);
const SAFE_SUB: Record<string, RegExp> = {
  git: /^git\s+(status|log|diff|show|branch|remote\s+-v|rev-parse|ls-files|describe|fetch|blame|stash\s+list)\b/,
  npm: /^npm\s+(test|t|run|ci|install|i|ls|list|outdated|view|audit|exec|start|-v|--version)\b/,
  npx: /^npx\s+(--yes\s+|-y\s+)?(vitest|jest|tsc|eslint|prettier|playwright|vite|next|expo|serve|http-server|mocha|ts-node|tsx)\b/,
  pnpm: /^pnpm\s+(test|run|install|i|ls|exec|dev|build|start)\b/,
  yarn: /^yarn(\s+(test|run|install|dev|build|start|lint))?\s*$|^yarn\s+(test|run|install|dev|build|start|lint)\b/,
  cargo: /^cargo\s+(test|build|check|run|clippy|fmt|tree|metadata|--version)\b/,
  pip: /^pip3?\s+(list|show|freeze|install\s+(-r|-e|--user))\b/,
  brew: /^brew\s+(list|info|--version|doctor|config)\b/,
  docker: /^docker\s+(ps|images|logs|inspect|version|info|compose\s+(ps|logs|config))\b/,
  go: /^go\s+(test|build|vet|version|env|list|mod\s+(download|tidy|verify))\b/,
  node: /^node\s+(-v|--version)\b/, python: /^python\s+(-V|--version)\b/, python3: /^python3\s+(-V|--version|-m\s+(pytest|unittest|http\.server))\b/,
  java: /^java\s+(-version|--version)\b/, ruby: /^ruby\s+(-v|--version)\b/, deno: /^deno\s+(test|check|lint|fmt\s+--check|--version)\b/, bun: /^bun\s+(test|run|install|--version)\b/,
};
const SUB_HEADS = new Set(Object.keys(SAFE_SUB));

/** Splits `a && b; c | d` into its simple commands (quotes respected well enough for classification). */
export function segments(cmd: string) {
  return cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""').split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

export function assessRules(cmd: string) {
  const reasons: string[] = [];
  for (const [re, label] of DESTRUCTIVE) if (re.test(cmd) && !reasons.includes(label)) reasons.push(label);
  const safe = !reasons.length && segments(cmd).every((seg) => {
    const words = seg.replace(/^(\w+=\S*\s+)+/, '').split(/\s+/);
    const head = words[0] ?? '';
    if (head === 'cd') return true;
    if (SUB_HEADS.has(head)) return SAFE_SUB[head]!.test(seg.replace(/^(\w+=\S*\s+)+/, ''));
    if (/^(>|>>)/.test(words[1] ?? '')) return false;
    return SAFE_HEAD.has(head);
  }) && !/(^|[^>])>>?\s*[^&\s]/.test(cmd.replace(/2>&1|>\s*\/dev\/null/g, ''));   // writing files is not "read-only"
  return { destructive: reasons.length > 0, safe, reasons };
}

const TEST_CMD = /\b(npm\s+(run\s+)?test|npm\s+t\b|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+test|deno\s+test|npx\s+(vitest|jest|playwright\s+test|mocha)|vitest|jest|pytest|tox|cargo\s+test|go\s+test|(gradlew?|mvn|xcodebuild)\b[^;&|]*\btest\b|swift\s+test|dotnet\s+test|flutter\s+test|dart\s+test|rspec|phpunit)/i;
export const isTestCommand = (cmd: string) => TEST_CMD.test(cmd);

export function createRemoteGate(deps: { store: Store; laya: LayaClient; runners: RunnerHub; push?: Push }) {
  const { store, laya, runners } = deps;
  const approvals = new Map<string, Approval>();

  const view = (a: Approval): ApprovalView => {
    const { userId: _u, exec: _e, waiters: _w, ...rest } = a;
    return { ...rest };
  };
  function settle(a: Approval) {
    for (const fn of a.waiters) fn();
    a.waiters.clear();
  }
  function sweep() {
    const now = Date.now();
    for (const a of approvals.values()) {
      if (a.status === 'pending' && a.expiresAt <= now) {
        a.status = 'expired'; a.decidedAt = now; a.decidedBy = 'timeout';
        recordRefused(a, 'expired');
        settle(a);
      }
      if (a.status !== 'pending' && (a.decidedAt ?? now) + KEEP_DECIDED_MS < now) approvals.delete(a.id);
    }
  }
  const timer = setInterval(sweep, 5000); timer.unref();

  function recordRefused(a: Approval, by: 'denied' | 'expired') {
    try {
      const id = store.addRemoteRun({ runId: a.runId, targetId: a.targetId, userId: a.userId, kind: 'exec', cmd: a.cmd, cwd: a.cwd, risk: a.risk, approvedBy: by });
      store.finishRemoteRun(id, { exitCode: null, artifacts: { refused: by, reasons: a.reasons } });
      a.remoteRunId = id;
    } catch { /* target deleted meanwhile */ }
  }

  async function assess(userId: number, target: TargetRow, cmd: string, cwd: string | null): Promise<Assessment> {
    const rules = assessRules(cmd);
    let lay: number | null = null; let decisionId: number | null = null;
    try {
      const state = { command: cmd.slice(0, 1500), cwd: cwd ?? '(default folder)', machine: `${target.name} (${target.platform ?? 'unknown'})` };
      const d = await decide(laya, 'remote.approve', { state });
      lay = typeof d.answer === 'number' ? d.answer : null;
      decisionId = store.logKindDecision({ userId, kind: 'remote.approve', command: cmd, answer: d.answer, confidence: d.confidence, probabilities: d.probabilities, latencyMs: d.latency_ms, device: d.device, fallback: d.fallback, state: { ...state, rules } });
      if (d.fallback) lay = null;
    } catch { /* Laya down: rules decide, unknown → ask */ }
    const risk = rules.destructive ? 2 : rules.safe ? Math.min(lay ?? 0.3, 0.5) : lay ?? 1.5;
    const reasons = [...rules.reasons];
    if (rules.safe) reasons.push('읽기·빌드·테스트 명령');
    if (lay !== null) reasons.push(`Laya 위험도 ${lay.toFixed(2)}`);
    else if (!rules.safe && !rules.destructive) reasons.push('위험도 판단 불가 → 확인');
    return { risk: Math.round(risk * 100) / 100, destructive: rules.destructive, safe: rules.safe, reasons, decisionId, laya: lay };
  }

  function needsApproval(policy: string, a: Assessment) {
    if (a.destructive) return true;
    if (policy === 'auto') return a.risk >= 1.5;
    return !a.safe;   // 'ask' (default): only read/build/test commands go straight through
  }

  async function start(a: Approval, approvedBy: 'auto' | 'user') {
    const stream = await runners.exec(a.targetId, a.userId, a.exec, { approvedBy, runId: a.runId, risk: a.risk });
    a.remoteRunId = stream.remoteRunId;
    return stream;
  }

  return {
    assess,
    /** An agent asks to run `exec` on `target`. */
    async request(userId: number, target: TargetRow, exec: ExecParams, meta: { runId?: number | null; agent?: string | null }): Promise<GateResult> {
      if (target.policy === 'deny') return { status: 'denied', reason: `대상 ${target.name}의 실행 정책이 "실행 금지"입니다`, approval: null, assessment: null };
      const assessment = await assess(userId, target, exec.cmd, exec.cwd ?? null);
      const now = Date.now();
      const a: Approval = {
        id: crypto.randomBytes(9).toString('base64url'), userId, targetId: target.id, targetName: target.name, cmd: exec.cmd, cwd: exec.cwd ?? null,
        agent: meta.agent ?? null, runId: meta.runId ?? null, risk: assessment.risk, reasons: assessment.reasons, destructive: assessment.destructive, policy: target.policy,
        status: 'pending', createdAt: now, expiresAt: now + APPROVAL_TTL_MS, decidedAt: null, decidedBy: null, remoteRunId: null, error: null, exec, waiters: new Set(),
      };
      if (!needsApproval(target.policy, assessment)) {
        a.status = 'allowed'; a.decidedAt = now; a.decidedBy = 'auto';
        const stream = await start(a, 'auto');
        return { status: 'started', stream, approval: null, assessment };
      }
      approvals.set(a.id, a);
      void deps.push?.sendToUser(userId, { title: `원격 실행 승인 요청 · ${target.name}`, body: `${a.agent ? `${a.agent}: ` : ''}${a.cmd.slice(0, 140)}`, url: `/m/?approval=${a.id}`, tag: `approval-${a.id}` }).catch(() => undefined);
      console.log(`[remote-gate] approval ${a.id} pending: target #${target.id} risk ${a.risk} (${a.reasons.join(', ')})`);
      return { status: 'pending', approval: view(a), assessment };
    },

    list(userId: number, includeDecided = false) {
      sweep();
      return [...approvals.values()].filter((a) => a.userId === userId && (includeDecided || a.status === 'pending')).sort((x, y) => x.createdAt - y.createdAt).map(view);
    },
    get(userId: number, id: string) { const a = approvals.get(id); return a && a.userId === userId ? view(a) : null; },

    /** The user's answer. `auto` also switches the target to policy auto (the next safe-enough commands run without asking). */
    async answer(userId: number, id: string, allow: boolean, opts: { auto?: boolean } = {}) {
      sweep();
      const a = approvals.get(id);
      if (!a || a.userId !== userId) throw Object.assign(new Error('승인 요청이 없습니다(만료되었거나 이미 처리됨)'), { status: 404 });
      if (a.status !== 'pending') return view(a);
      a.decidedAt = Date.now(); a.decidedBy = 'user';
      if (!allow) { a.status = 'denied'; recordRefused(a, 'denied'); settle(a); return view(a); }
      a.status = 'allowed';
      if (opts.auto) { try { store.updateTarget(userId, a.targetId, { policy: 'auto' }); } catch { /* deleted */ } }
      try { await start(a, 'user'); } catch (error) { a.error = error instanceof Error ? error.message : String(error); }
      settle(a);
      return view(a);
    },

    /** Long-poll until the approval is decided (or `timeoutMs` passes). */
    wait(userId: number, id: string, timeoutMs: number): Promise<ApprovalView | null> {
      const a = approvals.get(id);
      if (!a || a.userId !== userId) return Promise.resolve(null);
      if (a.status !== 'pending') return Promise.resolve(view(a));
      return new Promise((resolve) => {
        const done = () => { clearTimeout(t); a.waiters.delete(done); resolve(view(a)); };
        const t = setTimeout(done, timeoutMs);
        a.waiters.add(done);
      });
    },

    /** A remote run finished: a test command sets the chat run's test_result (outcome rule §3.8). */
    onFinished(stream: StreamInfo, userId: number, runId: number | null) {
      if (!runId || !isTestCommand(stream.cmd)) return;
      const run = store.run(userId, runId);
      if (!run) return;
      if (stream.signal && stream.code === null) return;   // interrupted: no verdict
      store.updateRun(userId, runId, { testResult: stream.code === 0 ? 'pass' : 'fail' });
      console.log(`[remote-gate] run #${runId} test_result=${stream.code === 0 ? 'pass' : 'fail'} (remote run #${stream.remoteRunId})`);
    },
    stop() { clearInterval(timer); },
  };
}
export type RemoteGate = ReturnType<typeof createRemoteGate>;
