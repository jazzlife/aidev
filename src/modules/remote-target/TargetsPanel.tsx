import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpCircle, Check, ChevronDown, ChevronRight, Copy, KeyRound, Laptop, Plus, RefreshCw, Star, Trash2, Users, Wifi, WifiOff, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { copyTextToClipboard } from '@/shared/utils';
import type { RunnerFile } from '@/shared/types';
import { DevicesSection } from '@/modules/remote-target/DevicesSection';
import { guessPlatform, pairingSteps } from '@/shared/runnerPairing';

/** A developer PC registered for remote run/debug, as the gateway reports it (GET /api/aidev/targets). */
type Target = {
  id: number;
  name: string;
  description: string;
  platform: string | null;
  arch: string | null;
  policy: 'full' | 'auto' | 'ask' | 'deny';
  paired: boolean;
  online: boolean;
  status: string;
  /** F-08: the account's default PC for remote work (1/0 from the gateway) */
  is_default?: number | boolean;
  /** another account's PC shared with this one: the owner's username (only the owner manages it) */
  shared_by?: string | null;
  last_seen: number | null;
  pairing_code: string | null;
  pairing_expires: number | null;
  allowed_roots: string[];
  capabilities: {
    runner?: string; os?: string; arch?: string; hostname?: string; shell?: string;
    tools?: Record<string, string>; devices?: { adb?: string[]; sdb?: string[] }; screen?: boolean; features?: string[];
  } | null;
  /** a runner update asked from here, until the runner reconnects with the new version (or it failed) */
  update?: { from: string; to: string; at: number; error: string | null } | null;
};

// full: agents never wait (the default) — every command is still recorded, pushed to the user and stoppable
const POLICY_LABEL: Record<Target['policy'], string> = { full: '전체 권한 (확인 없음)', auto: '위험 명령만 확인', ask: '변경 명령은 확인', deny: '실행 금지' };
const POLL_MS = 5000;
// below this panel width the buttons and badges keep only their icons (the text moves to the tooltip)
const COMPACT_PX = 380;
const BUTTON = 'inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2 hover:bg-accent disabled:opacity-50';

/** A button's or badge's text: shown in a wide panel; a narrow one keeps only the icon (screen readers still read it). */
function Label({ compact, children }: { compact: boolean; children: ReactNode }) {
  return compact ? <span className="sr-only">{children}</span> : <>{children}</>;
}

/** a > b for runner versions ("0.20.0" > "0.9.3"). */
function versionAbove(a: string, b: string) {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}

/** The newest runner this release serves to PCs (the Android app updates itself). */
function servedVersion(files: RunnerFile[]) {
  return files.filter((f) => f.platform !== 'android' && f.version).map((f) => f.version!).reduce<string | null>((best, v) => (!best || versionAbove(v, best) ? v : best), null);
}

/** The owner's online PC runs an older runner than the one served, and no update is under way. */
function updatable(target: Target, latest: string | null) {
  const runner = target.capabilities?.runner;
  return Boolean(!target.shared_by && target.online && latest && runner && target.capabilities?.os !== 'android' && versionAbove(latest, runner) && (!target.update || target.update.error));
}

function ago(at: number | null) {
  if (!at) return '없음';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`;
}


/** Pairing instructions: the code, where to get the runner for the PC's OS, and the exact commands. */
function PairingCard({ target, files, onRefresh }: { target: Target; files: RunnerFile[]; onRefresh: () => void }) {
  const gateway = window.location.origin;
  // platform: which OS the instructions are written for (defaults to this browser's OS)
  const [platform, setPlatform] = useState<string>(() => guessPlatform(files, navigator.userAgent, (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform));
  const file = files.find((f) => f.platform === platform);
  const steps = pairingSteps({ platform, file, code: target.pairing_code ?? '', gateway });
  const commands = steps.commands;
  const left = target.pairing_expires ? Math.max(0, Math.round((target.pairing_expires - Date.now()) / 60000)) : 0;
  const platforms = Array.from(new Set([...files.map((f) => f.platform ?? ''), 'mac-universal', 'linux-x64', 'win-x64', platform].filter(Boolean)));
  // copied: result of the last "명령 복사" (the Clipboard API can be refused; the fallback may fail too)
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const copy = async () => {
    const ok = await copyTextToClipboard(commands);
    setCopied(ok ? 'ok' : 'failed');
    window.setTimeout(() => setCopied(null), 2500);
  };
  return (
    <div className="mt-1.5 rounded-md border border-primary/40 bg-primary/5 p-2" data-testid="pairing-card">
      <div className="flex items-baseline gap-2">
        <span className="whitespace-nowrap text-muted-foreground">페어링 코드</span>
        <span className="aidev-selectable font-mono text-[15px] font-semibold tracking-widest">{target.pairing_code}</span>
        <span className="ml-auto whitespace-nowrap text-[10px] text-muted-foreground">{left}분 · 1회용</span>
      </div>
      <label className="mt-1 flex items-center gap-1.5 text-muted-foreground">
        그 PC의 OS
        <select aria-label="대상 OS" value={platform} onChange={(event) => setPlatform(event.target.value)} className="h-6 rounded border border-border bg-background px-1 text-foreground">
          {platforms.map((p) => <option key={p} value={p}>{p}{files.some((f) => f.platform === p) ? '' : ' (빌드 필요)'}</option>)}
        </select>
      </label>
      {steps.prerequisite ? <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">{steps.prerequisite}</div> : null}
      <div className="mt-1 text-[10px] text-muted-foreground">{platform === 'android'
        ? 'Android 기기에서 · NadoVibe 러너 앱이 포그라운드 서비스로 상시 실행, 부팅 때 자동 시작'
        : `${steps.shell}에 붙여 넣기 · 설치 위치 ${platform.startsWith('win') ? '%USERPROFILE%\\.aidev\\bin' : '~/.aidev/bin'} · 서비스로 등록돼 부팅 때부터 실행 · 관리 메뉴: aidev-runner menu`}</div>
      <pre className="aidev-selectable mt-1 whitespace-pre-wrap break-all rounded bg-muted/60 p-1.5 font-mono text-[11px]">{commands}</pre>
      {file?.sha256 ? <div className="aidev-selectable break-all text-[10px] text-muted-foreground">sha256 {file.sha256}</div> : null}
      {steps.links.length ? <div className="mt-1 flex flex-wrap gap-2">{steps.links.map((link) => <a key={link.href} href={link.href} className="text-[11px] text-primary underline">{link.label}</a>)}</div> : null}
      <div className="mt-1 flex gap-1.5">
        <button type="button" onClick={() => { void copy(); }} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent">{copied === 'ok' ? <><Check size={11} /> 복사됨</> : <><Copy size={11} /> 명령 복사</>}</button>
        <button type="button" onClick={onRefresh} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent"><RefreshCw size={11} /> 새 코드</button>
      </div>
      {copied === 'failed' ? <div className="mt-1 text-[10px] text-rose-600">이 브라우저가 클립보드 쓰기를 막았습니다 — 위 명령을 드래그해 선택한 뒤 복사하세요</div> : null}
    </div>
  );
}

/** The owner's list of accounts that may use the PC (watch, run, control — one controller at a time). */
function SharesSection({ targetId, setNote }: { targetId: number; setNote: (note: string | null) => void }) {
  // shares: accounts the PC is shared with; null until loaded
  const [shares, setShares] = useState<Array<{ user_id: number; username: string }> | null>(null);
  // username: the account being added
  const [username, setUsername] = useState('');
  const apply = useCallback(async (work: () => Promise<Response>) => {
    try { setShares((await readApiJson<{ shares: Array<{ user_id: number; username: string }> }>(await work())).shares); }
    catch (error) { setNote(error instanceof Error ? error.message : '공유 처리 실패'); }
  }, [setNote]);
  useEffect(() => { void apply(() => api.targets.shares(targetId)); }, [apply, targetId]);
  const add = () => { const name = username.trim().toLowerCase(); if (!name) return; setUsername(''); void apply(() => api.targets.share(targetId, name)); };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground"><Users size={11} /> 공유 — 화면·명령·터미널을 함께 쓰고, 제어는 한 번에 한 명</div>
      <div className="flex flex-wrap gap-1">
        {shares?.map((share) => (
          <span key={share.user_id} className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[11px]">
            {share.username}
            <button type="button" aria-label={`${share.username} 공유 해제`} title="공유 해제 — 열려 있는 화면·터미널도 몇 초 안에 닫힙니다" onClick={() => { void apply(() => api.targets.unshare(targetId, share.user_id)); }} className="rounded hover:text-red-600"><X size={10} /></button>
          </span>
        ))}
        {shares && !shares.length ? <span className="text-[11px] text-muted-foreground">공유한 사용자 없음</span> : null}
      </div>
      <div className="flex gap-1.5">
        <input aria-label="공유할 사용자 이름" placeholder="사용자 이름" value={username} onChange={(event) => setUsername(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') add(); }} className="h-6 w-36 rounded border border-border bg-background px-1.5" />
        <button type="button" disabled={!username.trim()} onClick={add} className="h-6 rounded border border-border px-2 hover:bg-accent disabled:opacity-50">공유</button>
      </div>
    </div>
  );
}

/** One target row: status, platform, and (expanded) capabilities and actions (managing it: the owner only). */
function TargetRow({ target, files, latest, compact, reload, setNote }: { target: Target; files: RunnerFile[]; latest: string | null; compact: boolean; reload: () => void; setNote: (note: string | null) => void }) {
  // expanded: details (tools, devices, roots) and actions are shown on demand to keep the list short
  const [open, setOpen] = useState(false);
  // confirmDelete: deleting disconnects the runner immediately (leaving a share closes this account's screens), so it takes a second click
  const [confirmDelete, setConfirmDelete] = useState(false);
  const caps = target.capabilities;
  // runner 0.20.0+ removes itself from the PC when its target is deleted (now, or when it next connects)
  const removesItself = Boolean(caps?.features?.includes('remove'));
  const shared = Boolean(target.shared_by);
  const act = async (work: () => Promise<Response>, done?: (body: Record<string, unknown>) => string | null) => {
    setNote(null);
    try {
      const body = await readApiJson<Record<string, unknown>>(await work());
      const message = done?.(body);
      if (message) setNote(message);
      reload();
    } catch (error) { setNote(error instanceof Error ? error.message : '실패했습니다'); }
  };
  const state = target.online ? { dot: 'bg-emerald-500', text: '연결됨' } : target.paired ? { dot: 'bg-muted-foreground/40', text: `오프라인 · ${ago(target.last_seen)}` } : { dot: 'bg-amber-500', text: '페어링 대기' };
  return (
    <li className="border-b border-border/60 px-3 py-2" data-testid={`target-${target.name}`}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 text-left">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className={`h-2 w-2 shrink-0 rounded-full ${state.dot}`} aria-hidden />
        <span className="min-w-10 truncate font-medium">{target.name}</span>
        {shared ? <span title={`${target.shared_by} 님이 공유한 PC — 설정은 소유자만 바꿀 수 있습니다`} className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-sky-500/15 px-1 py-px text-[10px] text-sky-700 dark:text-sky-300"><Users size={9} /> <Label compact={compact}>{target.shared_by} 공유</Label></span> : null}
        {target.is_default ? <span title="기본 PC — 명령이 PC를 지정하지 않으면 여기서 실행" className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-amber-500/15 px-1 py-px text-[10px] text-amber-700 dark:text-amber-400"><Star size={9} className="fill-current" /> <Label compact={compact}>기본</Label></span> : null}
        {target.update && !target.update.error ? <span title={`러너 ${target.update.from} → ${target.update.to} 업데이트 중 — 다시 연결되면 끝`} className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-sky-500/15 px-1 py-px text-[10px] text-sky-700 dark:text-sky-300"><RefreshCw size={9} className="animate-spin" /> <Label compact={compact}>업데이트 중</Label></span>
          : updatable(target, latest) ? <span title={`업데이트 가능: 러너 ${caps?.runner} → ${latest}`} className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-amber-500/15 px-1 py-px text-[10px] text-amber-700 dark:text-amber-400"><ArrowUpCircle size={9} /> <Label compact={compact}>업데이트 가능</Label></span> : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{[caps?.os ?? target.platform, caps?.arch ?? target.arch, caps?.hostname].filter(Boolean).join(' · ')}</span>
        <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{state.text}</span>
      </button>
      {!shared && (!target.paired || target.pairing_code) ? (target.pairing_code ? <PairingCard target={target} files={files} onRefresh={() => { void act(() => api.targets.refreshPairing(target.id)); }} /> : (
        <button type="button" onClick={() => { void act(() => api.targets.refreshPairing(target.id)); }} className="mt-1 inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent"><RefreshCw size={11} /> 페어링 코드 발급</button>
      )) : null}
      {open ? (
        <div className="mt-1.5 space-y-1.5 pl-5">
          {target.description ? <div className="text-muted-foreground">{target.description}</div> : null}
          {caps ? (
            <>
              <div className="flex flex-wrap gap-1">{Object.entries(caps.tools ?? {}).map(([tool, version]) => <span key={tool} title={version} className="rounded bg-muted px-1 text-[10px]">{tool}</span>)}</div>
              {target.online && caps.features?.includes('device') ? <DevicesSection targetId={target.id} /> : (caps.devices?.adb?.length || caps.devices?.sdb?.length) ? <div className="text-muted-foreground">기기: {[...(caps.devices?.adb ?? []).map((d) => `adb ${d}`), ...(caps.devices?.sdb ?? []).map((d) => `sdb ${d}`)].join(', ')}</div> : null}
              <div className="aidev-selectable text-muted-foreground">허용 폴더: {target.allowed_roots.length ? target.allowed_roots.join(', ') : '없음'}</div>
              <div className="aidev-selectable text-[10px] text-muted-foreground">러너 {caps.runner ?? '?'} · 셸 {caps.shell ?? '?'} · 화면 캡처 {caps.screen ? '허용' : '꺼짐'}</div>
            </>
          ) : <div className="text-muted-foreground">러너가 아직 연결된 적이 없습니다.</div>}
          {target.update?.error ? <div className="break-words text-rose-600">러너 업데이트 실패 ({target.update.from} → {target.update.to}): {target.update.error}</div> : null}
          {shared ? <div className="text-muted-foreground">원격 실행: {POLICY_LABEL[target.policy]} · {target.shared_by} 님이 관리</div> : (
            <>
              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">원격 실행</span>
                <select aria-label="실행 정책" value={target.policy} onChange={(event) => { void act(() => api.targets.update(target.id, { policy: event.target.value })); }} className="h-6 rounded border border-border bg-background px-1">
                  {(Object.keys(POLICY_LABEL) as Target['policy'][]).map((policy) => <option key={policy} value={policy}>{POLICY_LABEL[policy]}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5" title="명령이 PC를 지정하지 않고 채팅에 고정된 PC도 없으면 이 PC에서 실행합니다">
                <input type="checkbox" checked={Boolean(target.is_default)} onChange={(event) => { void act(() => api.targets.update(target.id, { default: event.target.checked })); }} />
                <span>기본 PC (원격 작업을 보낼 곳)</span>
              </label>
              <SharesSection targetId={target.id} setNote={setNote} />
            </>
          )}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" title="연결 확인" disabled={!target.online} onClick={() => { void act(() => api.targets.ping(target.id), (b) => (b.ok ? `응답 ${String(b.rtt_ms)}ms` : `응답 없음: ${String(b.error)}`)); }} className={`${BUTTON} border-border`}><Wifi size={11} /> <Label compact={compact}>연결 확인</Label></button>
            <button type="button" title="정보 새로고침" disabled={!target.online} onClick={() => { void act(() => api.targets.refreshCapabilities(target.id), () => '정보를 새로 받았습니다'); }} className={`${BUTTON} border-border`}><RefreshCw size={11} /> <Label compact={compact}>정보 새로고침</Label></button>
            {updatable(target, latest) ? <button type="button" title={`러너 업데이트 ${caps?.runner} → ${latest}`} onClick={() => { void act(() => api.targets.updateRunner(target.id, latest!), () => null); }} className={`${BUTTON} border-amber-500/60 text-amber-700 dark:text-amber-400`}><ArrowUpCircle size={11} /> <Label compact={compact}>업데이트 → {latest}</Label></button> : null}
            {!shared && target.paired && !target.pairing_code ? <button type="button" title="다시 페어링" onClick={() => { void act(() => api.targets.refreshPairing(target.id), () => '새 코드로 다시 페어링하면 기존 러너 연결은 끊어집니다'); }} className={`${BUTTON} border-border`}><KeyRound size={11} /> <Label compact={compact}>다시 페어링</Label></button> : null}
            {shared ? (confirmDelete
              ? <button type="button" title={`내 목록에서 빼고 공유를 끊습니다 — PC와 러너는 ${target.shared_by} 님에게 그대로 남습니다`} onClick={() => { void act(() => api.targets.remove(target.id), () => `${target.name} 공유 해제 — PC와 러너는 ${target.shared_by} 님에게 그대로 남습니다`); }} className={`${BUTTON} border-red-600 bg-red-600 text-white hover:bg-red-700`}><X size={11} /> <Label compact={compact}>공유 해제 확인</Label></button>
              : <button type="button" title="공유 해제" onClick={() => setConfirmDelete(true)} className={`${BUTTON} border-border text-red-600`}><X size={11} /> <Label compact={compact}>공유 해제</Label></button>)
              : confirmDelete
              ? <button type="button" title={removesItself ? 'PC에서 러너 서비스와 파일(설정·토큰·로그)까지 지웁니다 — 오프라인이면 다음에 연결될 때' : '이 러너는 0.20.0 미만이라 PC에 남습니다 — PC에서 aidev-runner uninstall'} onClick={() => { void act(() => api.targets.remove(target.id), () => (removesItself ? `${target.name} 삭제 — PC에서 러너를 제거합니다${target.online ? '' : ' (다음에 연결될 때)'}` : `${target.name} 삭제 — 러너 연결을 끊었습니다 (러너 0.20.0 미만이라 PC에 남습니다: PC에서 aidev-runner uninstall)`)); }} className={`${BUTTON} border-red-600 bg-red-600 text-white hover:bg-red-700`}><Trash2 size={11} /> <Label compact={compact}>{removesItself ? 'PC에서도 제거' : '삭제 확인'}</Label></button>
              : <button type="button" title="삭제" onClick={() => setConfirmDelete(true)} className={`${BUTTON} border-border text-red-600`}><Trash2 size={11} /> <Label compact={compact}>삭제</Label></button>}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Used by the workbench's "원격 대상" — the desktop side view and the tablet pane (F-02): registers developer PCs, shows the one-time pairing
 * code with the runner commands, and lists targets with live online state and what each PC offers.
 */
export function TargetsPanel() {
  // targets: the list polled from the gateway; null until the first load
  const [targets, setTargets] = useState<Target[] | null>(null);
  // note: result or error of the last action, shown under the header
  const [note, setNote] = useState<string | null>(null);
  // files: runner binaries the release ships, for the download line in pairing instructions
  const [files, setFiles] = useState<RunnerFile[]>([]);
  // form: registration inputs while "등록" is open (null = closed)
  const [form, setForm] = useState<{ name: string; description: string; policy: Target['policy'] } | null>(null);

  const reload = useCallback(() => {
    api.targets.list().then((r) => readApiJson<{ targets: Target[] }>(r)).then((body) => setTargets(body.targets)).catch((error: Error) => setNote(error.message));
  }, []);
  useEffect(() => {
    api.targets.runnerDownloads().then((r) => readApiJson<{ files: RunnerFile[] }>(r)).then((body) => setFiles(body.files)).catch(() => setFiles([]));
  }, []);
  useEffect(() => {
    reload();
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const latest = servedVersion(files);
  // compact: the panel is narrow — buttons and badges keep only their icons
  const panel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < COMPACT_PX));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const outdated = targets?.filter((t) => updatable(t, latest)) ?? [];
  // PCs whose runner update is under way (from the gateway's state: gone once each runner is back with the new version)
  const updating = targets?.filter((t) => t.update && !t.update.error) ?? [];
  // every outdated PC (8 requests at a time; each PC replaces its own runner and reconnects)
  const updateAll = async () => {
    setNote(null);
    const failed: string[] = [];
    for (let i = 0; i < outdated.length; i += 8) {
      await Promise.all(outdated.slice(i, i + 8).map(async (t) => {
        try { await readApiJson(await api.targets.updateRunner(t.id, latest!)); } catch (error) { failed.push(`${t.name}: ${error instanceof Error ? error.message : '실패'}`); }
      }));
    }
    // only what failed to start stays as a note; the progress line follows the PCs until they are back
    setNote(failed.length ? `러너 ${latest} 업데이트를 시작하지 못한 PC ${failed.length}대 — ${failed.join(' / ')}` : null);
    reload();
  };

  const register = async () => {
    if (!form) return;
    setNote(null);
    try {
      await readApiJson(await api.targets.create({ name: form.name.trim(), description: form.description.trim(), policy: form.policy }));
      setForm(null);
      reload();
    } catch (error) { setNote(error instanceof Error ? error.message : '등록 실패'); }
  };

  return (
    <div ref={panel} className="flex h-full flex-col text-[12px]" data-testid="targets-panel">
      <div className="flex h-8 items-center gap-2 border-b border-border px-3 text-muted-foreground">
        <Laptop size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{targets ? `${targets.length}대 · 연결 ${targets.filter((t) => t.online).length}` : '불러오는 중…'}</span>
        {outdated.length ? <button type="button" onClick={() => { void updateAll(); }} title={`연결된 PC 중 러너가 ${latest}보다 오래된 ${outdated.length}대를 업데이트합니다`} className={`${BUTTON} border-amber-500/60 text-amber-700 dark:text-amber-400`}><ArrowUpCircle size={11} /> <Label compact={compact}>모두 업데이트</Label> {outdated.length}</button> : null}
        <button type="button" onClick={reload} aria-label="새로고침" className="ml-auto shrink-0 rounded p-1 hover:bg-accent"><RefreshCw size={12} /></button>
        <button type="button" title="PC 등록" onClick={() => setForm(form ? null : { name: '', description: '', policy: 'full' })} className={`${BUTTON} border-border text-foreground`}><Plus size={11} /> <Label compact={compact}>등록</Label></button>
      </div>
      {updating.length ? <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-sky-700 dark:text-sky-300"><RefreshCw size={11} className="shrink-0 animate-spin" /><span className="min-w-0 truncate">러너 업데이트 중 {updating.length}대 — 다시 연결되면 끝</span></div> : null}
      {note ? (
        <div className="flex items-start gap-1.5 border-b border-border px-3 py-1.5 text-muted-foreground">
          <span className="min-w-0 flex-1 break-words">{note}</span>
          <button type="button" aria-label="알림 닫기" onClick={() => setNote(null)} className="shrink-0 rounded p-0.5 hover:bg-accent"><X size={11} /></button>
        </div>
      ) : null}
      {form ? (
        <div className="space-y-1.5 border-b border-border px-3 py-2">
          <input autoFocus className="w-full rounded border border-border bg-background px-2 py-1" placeholder="이름 (예: my-mac, 영문 소문자·숫자·-)" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value.toLowerCase() })} />
          <input className="w-full rounded border border-border bg-background px-2 py-1" placeholder="설명 (agent가 대상을 고를 때 참고)" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">원격 실행</span>
            <select aria-label="실행 정책" value={form.policy} onChange={(event) => setForm({ ...form, policy: event.target.value as Target['policy'] })} className="h-6 rounded border border-border bg-background px-1">
              {(Object.keys(POLICY_LABEL) as Target['policy'][]).map((policy) => <option key={policy} value={policy}>{POLICY_LABEL[policy]}</option>)}
            </select>
          </label>
          <div className="flex gap-1.5">
            <button type="button" disabled={form.name.trim().length < 2} onClick={() => { void register(); }} className="h-6 rounded bg-primary px-2 text-primary-foreground disabled:opacity-50">등록하고 코드 받기</button>
            <button type="button" onClick={() => setForm(null)} className="h-6 rounded border border-border px-2">취소</button>
          </div>
        </div>
      ) : null}
      <ul className="flex-1 overflow-auto">
        {targets?.map((target) => <TargetRow key={target.id} target={target} files={files} latest={latest} compact={compact} reload={reload} setNote={setNote} />)}
      </ul>
      {targets && targets.length === 0 && !form ? (
        <div className="px-3 py-4 text-muted-foreground">
          <WifiOff size={14} className="mb-1" />
          등록된 PC가 없습니다. "등록"으로 이름을 정하면 페어링 코드가 나옵니다. 그 PC에서 <code className="rounded bg-muted px-1">aidev-runner</code>를 실행하면 여기에 연결됨으로 표시되고, agent가 그 PC에서 실행·테스트·디버깅할 수 있게 됩니다.
        </div>
      ) : null}
    </div>
  );
}
