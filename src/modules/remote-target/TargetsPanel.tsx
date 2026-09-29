import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Laptop, Plus, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';

/** A developer PC registered for remote run/debug, as the gateway reports it (GET /api/aidev/targets). */
type Target = {
  id: number;
  name: string;
  description: string;
  platform: string | null;
  arch: string | null;
  policy: 'auto' | 'ask' | 'deny';
  paired: boolean;
  online: boolean;
  status: string;
  last_seen: number | null;
  pairing_code: string | null;
  pairing_expires: number | null;
  allowed_roots: string[];
  capabilities: {
    runner?: string; os?: string; arch?: string; hostname?: string; shell?: string;
    tools?: Record<string, string>; devices?: { adb?: string[]; sdb?: string[] }; screen?: boolean;
  } | null;
};

const POLICY_LABEL: Record<Target['policy'], string> = { ask: '실행 전 확인', auto: '자동 실행', deny: '실행 금지' };
const POLL_MS = 5000;

function ago(at: number | null) {
  if (!at) return '없음';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`;
}

/** A runner binary the gateway serves (GET /_runner/download). */
type RunnerFile = { name: string; version: string | null; platform: string | null; size: number; sha256: string | null };

/** Pairing instructions: the code, where to get the runner for the PC's OS, and the exact commands. */
function PairingCard({ target, files, onRefresh }: { target: Target; files: RunnerFile[]; onRefresh: () => void }) {
  const gateway = window.location.origin;
  // platform: which OS the instructions are written for (defaults to the first binary the release ships)
  const [platform, setPlatform] = useState<string>(files[0]?.platform ?? 'mac-universal');
  const file = files.find((f) => f.platform === platform);
  const windows = platform.startsWith('win');
  const exe = windows ? '.\\aidev-runner.exe' : './aidev-runner';
  const fetchLine = file
    ? (windows ? `curl.exe -fsSL ${gateway}/_runner/download/${file.name} -o aidev-runner.exe` : `curl -fsSL ${gateway}/_runner/download/${file.name} -o aidev-runner && chmod +x aidev-runner`)
    : '# 이 릴리스에는 이 OS용 바이너리가 없습니다 — Mac에서 ops/runner/build.sh 로 빌드해 복사하세요';
  const commands = `${fetchLine}\n${exe} pair ${target.pairing_code} --gateway ${gateway}\n${exe} install-service   # 또는 ${exe} start`;
  const left = target.pairing_expires ? Math.max(0, Math.round((target.pairing_expires - Date.now()) / 60000)) : 0;
  const platforms = Array.from(new Set([...files.map((f) => f.platform ?? ''), 'mac-universal', 'win-x64'].filter(Boolean)));
  return (
    <div className="mt-1.5 rounded-md border border-primary/40 bg-primary/5 p-2" data-testid="pairing-card">
      <div className="flex items-baseline gap-2">
        <span className="whitespace-nowrap text-muted-foreground">페어링 코드</span>
        <span className="font-mono text-[15px] font-semibold tracking-widest">{target.pairing_code}</span>
        <span className="ml-auto whitespace-nowrap text-[10px] text-muted-foreground">{left}분 · 1회용</span>
      </div>
      <label className="mt-1 flex items-center gap-1.5 text-muted-foreground">
        그 PC의 OS
        <select aria-label="대상 OS" value={platform} onChange={(event) => setPlatform(event.target.value)} className="h-6 rounded border border-border bg-background px-1 text-foreground">
          {platforms.map((p) => <option key={p} value={p}>{p}{files.some((f) => f.platform === p) ? '' : ' (빌드 필요)'}</option>)}
        </select>
      </label>
      <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted/60 p-1.5 font-mono text-[11px]">{commands}</pre>
      {file?.sha256 ? <div className="break-all text-[10px] text-muted-foreground">sha256 {file.sha256}</div> : null}
      <div className="mt-1 flex gap-1.5">
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(commands); }} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent"><Copy size={11} /> 명령 복사</button>
        <button type="button" onClick={onRefresh} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent"><RefreshCw size={11} /> 새 코드</button>
      </div>
    </div>
  );
}

/** One target row: status, platform, and (expanded) capabilities and actions. */
function TargetRow({ target, files, reload, setNote }: { target: Target; files: RunnerFile[]; reload: () => void; setNote: (note: string | null) => void }) {
  // expanded: details (tools, devices, roots) and actions are shown on demand to keep the list short
  const [open, setOpen] = useState(false);
  // confirmDelete: deleting disconnects the runner immediately, so it takes a second click
  const [confirmDelete, setConfirmDelete] = useState(false);
  const caps = target.capabilities;
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
        <span className="font-medium">{target.name}</span>
        <span className="truncate text-muted-foreground">{[caps?.os ?? target.platform, caps?.arch ?? target.arch, caps?.hostname].filter(Boolean).join(' · ')}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{state.text}</span>
      </button>
      {!target.paired || target.pairing_code ? (target.pairing_code ? <PairingCard target={target} files={files} onRefresh={() => { void act(() => api.targets.refreshPairing(target.id)); }} /> : (
        <button type="button" onClick={() => { void act(() => api.targets.refreshPairing(target.id)); }} className="mt-1 inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent"><RefreshCw size={11} /> 페어링 코드 발급</button>
      )) : null}
      {open ? (
        <div className="mt-1.5 space-y-1.5 pl-5">
          {target.description ? <div className="text-muted-foreground">{target.description}</div> : null}
          {caps ? (
            <>
              <div className="flex flex-wrap gap-1">{Object.entries(caps.tools ?? {}).map(([tool, version]) => <span key={tool} title={version} className="rounded bg-muted px-1 text-[10px]">{tool}</span>)}</div>
              {(caps.devices?.adb?.length || caps.devices?.sdb?.length) ? <div className="text-muted-foreground">기기: {[...(caps.devices?.adb ?? []).map((d) => `adb ${d}`), ...(caps.devices?.sdb ?? []).map((d) => `sdb ${d}`)].join(', ')}</div> : null}
              <div className="text-muted-foreground">허용 폴더: {target.allowed_roots.length ? target.allowed_roots.join(', ') : '없음'}</div>
              <div className="text-[10px] text-muted-foreground">러너 {caps.runner ?? '?'} · 셸 {caps.shell ?? '?'} · 화면 캡처 {caps.screen ? '허용' : '꺼짐'}</div>
            </>
          ) : <div className="text-muted-foreground">러너가 아직 연결된 적이 없습니다.</div>}
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">원격 실행</span>
            <select aria-label="실행 정책" value={target.policy} onChange={(event) => { void act(() => api.targets.update(target.id, { policy: event.target.value })); }} className="h-6 rounded border border-border bg-background px-1">
              {(Object.keys(POLICY_LABEL) as Target['policy'][]).map((policy) => <option key={policy} value={policy}>{POLICY_LABEL[policy]}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={!target.online} onClick={() => { void act(() => api.targets.ping(target.id), (b) => (b.ok ? `응답 ${String(b.rtt_ms)}ms` : `응답 없음: ${String(b.error)}`)); }} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent disabled:opacity-50"><Wifi size={11} /> 연결 확인</button>
            <button type="button" disabled={!target.online} onClick={() => { void act(() => api.targets.refreshCapabilities(target.id), () => '정보를 새로 받았습니다'); }} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent disabled:opacity-50"><RefreshCw size={11} /> 정보 새로고침</button>
            {target.paired && !target.pairing_code ? <button type="button" onClick={() => { void act(() => api.targets.refreshPairing(target.id), () => '새 코드로 다시 페어링하면 기존 러너 연결은 끊어집니다'); }} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent">다시 페어링</button> : null}
            {confirmDelete
              ? <button type="button" onClick={() => { void act(() => api.targets.remove(target.id), () => `${target.name} 삭제 — 러너 연결을 끊었습니다`); }} className="inline-flex h-6 items-center gap-1 rounded bg-red-600 px-2 text-white"><Trash2 size={11} /> 삭제 확인</button>
              : <button type="button" onClick={() => setConfirmDelete(true)} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-red-600 hover:bg-accent"><Trash2 size={11} /> 삭제</button>}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Used by the workbench side view "원격 대상" (F-02): registers developer PCs, shows the one-time pairing
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
    <div className="flex h-full flex-col text-[12px]" data-testid="targets-panel">
      <div className="flex h-8 items-center gap-2 border-b border-border px-3 text-muted-foreground">
        <Laptop size={12} />
        <span>{targets ? `${targets.length}대 · 연결 ${targets.filter((t) => t.online).length}` : '불러오는 중…'}</span>
        <button type="button" onClick={reload} aria-label="새로고침" className="ml-auto rounded p-1 hover:bg-accent"><RefreshCw size={12} /></button>
        <button type="button" onClick={() => setForm(form ? null : { name: '', description: '', policy: 'ask' })} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-foreground hover:bg-accent"><Plus size={11} /> 등록</button>
      </div>
      {note ? <div className="border-b border-border px-3 py-1.5 text-muted-foreground">{note}</div> : null}
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
        {targets?.map((target) => <TargetRow key={target.id} target={target} files={files} reload={reload} setNote={setNote} />)}
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
