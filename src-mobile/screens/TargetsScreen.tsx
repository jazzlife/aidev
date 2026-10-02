import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/modules/chat-core';
import { pairingSteps } from '@/modules/remote-target';
import type { RunnerFile } from '@/shared/types';
import { BottomSheet } from '@m/components/BottomSheet';
import { TopBar } from '@m/components/TopBar';
import { relativeTime } from '@m/lib/format';
import { useOpener, useParent } from '@m/lib/nav';

type Target = {
  id: number; name: string; description: string; platform: string | null; online: boolean; paired: boolean;
  last_seen: number | null; pairing_code: string | null; pairing_expires: number | null;
  capabilities: { runner?: string; os?: string; hostname?: string } | null;
};
/** The PC's OS for the pairing lines — the phone is not that PC, so it is chosen, not guessed. */
const OS_CHOICES: Array<{ id: string; label: string }> = [
  { id: 'win-x64', label: 'Windows' }, { id: 'mac-universal', label: 'macOS' }, { id: 'linux-x64', label: 'Linux' },
  { id: 'linux-arm64', label: 'Linux ARM64' }, { id: 'linux-armv7', label: '라즈베리 파이' },
];
const POLL_MS = 5000;

/** The one-time code and the lines to paste on the PC, with copy and share (send them to the PC). */
function PairingCard({ target, files, onRefresh }: { target: Target; files: RunnerFile[]; onRefresh: () => void }) {
  const [platform, setPlatform] = useState('win-x64');
  const [copied, setCopied] = useState(false);
  const steps = pairingSteps({ platform, file: files.find((f) => f.platform === platform), code: target.pairing_code ?? '', gateway: window.location.origin });
  const text = `${steps.prerequisite ? `${steps.prerequisite}\n\n` : ''}${steps.commands}`;
  const left = target.pairing_expires ? Math.max(0, Math.round((target.pairing_expires - Date.now()) / 60000)) : 0;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  const share = navigator.share ? () => { void navigator.share({ title: `NadoVibe PC 연결 (${target.name})`, text }).catch(() => undefined); } : null;
  return (
    <div className="mt-2 rounded-xl2 border border-accent/40 bg-accent/5 p-3" data-testid="pairing-card">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] text-muted">페어링 코드</span>
        <span className="font-mono text-[20px] font-semibold tracking-widest select-all">{target.pairing_code}</span>
        <span className="ml-auto text-[11px] text-muted">{left}분 · 1회용</span>
      </div>
      <div className="mt-2 text-[12px] text-muted">연결할 PC의 OS</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {OS_CHOICES.map((os) => (
          <button key={os.id} type="button" onClick={() => setPlatform(os.id)} aria-pressed={platform === os.id} className={`m-touch rounded-full px-3 text-[13px] ${platform === os.id ? 'bg-ink text-bg' : 'border border-line'}`}>{os.label}</button>
        ))}
      </div>
      <div className="mt-2 text-[12px] text-muted">그 PC의 {steps.shell}에 붙여 넣으세요 — 설치·페어링·서비스 등록까지 합니다</div>
      {steps.prerequisite ? <div className="mt-1 text-[12px] text-warn">{steps.prerequisite}</div> : null}
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-elevated p-2 font-mono text-[11px] select-all">{steps.commands}</pre>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <button type="button" onClick={() => { void copy(); }} className="m-touch flex items-center justify-center gap-1 rounded-xl border border-line text-[13px]">{copied ? <><Check size={14} /> 복사됨</> : <><Copy size={14} /> 복사</>}</button>
        {share ? <button type="button" onClick={share} className="m-touch flex items-center justify-center gap-1 rounded-xl border border-line text-[13px]"><Share2 size={14} /> 보내기</button> : <span />}
        <button type="button" onClick={onRefresh} className="m-touch flex items-center justify-center gap-1 rounded-xl border border-line text-[13px]"><RefreshCw size={14} /> 새 코드</button>
      </div>
    </div>
  );
}

/**
 * "PC 연결": register a PC, get its pairing code and the lines for that PC (copy or send them there), and see which PCs
 * are connected — what the workbench's "원격 대상" offers, for phones. Opened from the remote menu and settings.
 */
export function TargetsScreen() {
  useParent(useOpener('/'));
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [files, setFiles] = useState<RunnerFile[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const reload = useCallback(() => {
    api.targets.list().then((r) => readApiJson<{ targets: Target[] }>(r)).then((body) => setTargets(body.targets)).catch((error: Error) => setNote(error.message));
  }, []);
  useEffect(() => {
    api.targets.runnerDownloads().then((r) => readApiJson<{ files: RunnerFile[] }>(r)).then((body) => setFiles(body.files)).catch(() => setFiles([]));
    reload();
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const act = async (work: () => Promise<Response>, done?: string) => {
    setNote(null);
    try { await readApiJson(await work()); if (done) setNote(done); reload(); } catch (error) { setNote(error instanceof Error ? error.message : '실패했습니다'); }
  };
  const register = async () => {
    if (!form) return;
    const name = form.trim();
    setNote(null);
    try {
      const body = await readApiJson<{ target?: { id?: number }; id?: number }>(await api.targets.create({ name, description: '', policy: 'full' }));
      setForm(null);
      setOpenId(body.target?.id ?? body.id ?? null);
      reload();
    } catch (error) { setNote(error instanceof Error ? error.message : '등록 실패'); }
  };

  return (
    <div className="m-app">
      <TopBar title="PC 연결" subtitle={targets ? `${targets.length}대 · 연결 ${targets.filter((t) => t.online).length}` : undefined} back
        right={<button type="button" aria-label="PC 등록" onClick={() => setForm('')} className="m-touch flex items-center justify-center rounded-full text-accent"><Plus size={22} /></button>} />
      <main className="m-scroll flex-1 pb-8">
        {note ? <div className="px-4 py-2 text-[13px] text-muted">{note}</div> : null}
        {targets === null ? <div className="p-4 text-muted text-sm m-pulse">불러오는 중…</div> : null}
        {targets && targets.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">
            연결된 PC가 없습니다.<br />+ 로 PC를 등록하면 페어링 코드와 그 PC에서 실행할 명령이 나옵니다.
            <button type="button" onClick={() => setForm('')} className="mx-auto mt-4 block h-11 rounded-xl bg-accent px-5 text-[15px] font-medium text-accent-ink">PC 등록</button>
          </div>
        ) : null}
        <ul>
          {targets?.map((t) => {
            const state = t.online ? { dot: 'bg-ok', text: '연결됨' } : t.paired ? { dot: 'bg-muted', text: `오프라인${t.last_seen ? ` · ${relativeTime(new Date(t.last_seen).toISOString())}` : ''}` } : { dot: 'bg-warn', text: '페어링 대기' };
            const open = openId === t.id || Boolean(t.pairing_code && !t.paired);
            return (
              <li key={t.id} className="border-b border-line px-4 py-3" data-testid={`target-${t.name}`}>
                <button type="button" onClick={() => { setConfirmDelete(null); setOpenId(openId === t.id ? null : t.id); }} className="flex w-full items-center gap-2 text-left">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${state.dot}`} aria-hidden />
                  <span className="text-[15px] font-medium">{t.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{[t.capabilities?.os ?? t.platform, t.capabilities?.hostname].filter(Boolean).join(' · ')}</span>
                  <span className="shrink-0 text-[12px] text-muted">{state.text}</span>
                </button>
                {t.pairing_code ? <PairingCard target={t} files={files} onRefresh={() => { void act(() => api.targets.refreshPairing(t.id)); }} /> : null}
                {open && !t.pairing_code ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => { void act(() => api.targets.refreshPairing(t.id), '새 코드로 다시 페어링하면 기존 러너 연결은 끊어집니다'); }} className="m-touch flex items-center justify-center gap-1 rounded-xl border border-line text-[13px]"><RefreshCw size={14} /> 다시 페어링</button>
                    {confirmDelete === t.id
                      ? <button type="button" onClick={() => { void act(() => api.targets.remove(t.id), `${t.name} 삭제 — 러너 연결을 끊었습니다`); }} className="m-touch rounded-xl bg-danger text-[13px] text-white">정말 삭제</button>
                      : <button type="button" onClick={() => setConfirmDelete(t.id)} className="m-touch flex items-center justify-center gap-1 rounded-xl border border-line text-[13px] text-danger"><Trash2 size={14} /> 삭제</button>}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </main>
      <BottomSheet open={form !== null} onClose={() => setForm(null)} title="PC 등록">
        <input autoFocus className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px]" placeholder="이름 (예: my-pc, 영문 소문자·숫자·-)" value={form ?? ''} onChange={(event) => setForm(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
        <p className="mt-2 text-[12px] text-muted">등록하면 10분짜리 페어링 코드와 그 PC에서 실행할 명령이 나옵니다.</p>
        <button type="button" disabled={(form ?? '').trim().length < 2} onClick={() => { void register(); }} className="mt-3 w-full h-12 rounded-xl bg-accent text-accent-ink text-[15px] font-medium disabled:opacity-50">등록하고 코드 받기</button>
      </BottomSheet>
    </div>
  );
}
