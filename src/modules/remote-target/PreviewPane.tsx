import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Laptop, MonitorPlay, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';

/**
 * PreviewPane (IMPLEMENTATION-PLAN §3.12, F-06): a dev server running on one of the user's PCs, shown in
 * the workbench through the gateway's `/p/<cap>/` tunnel (HMR included). The page runs sandboxed (opaque
 * origin), so it cannot touch the platform session. Previews opened by an agent (`remote_preview`) appear
 * in the list on their own; the user can also open one by port. Width presets frame the page like a phone
 * or tablet; "새 창" opens the same URL in a browser tab (the URL also works on a phone).
 */
type Target = { id: number; name: string; online: boolean };
export type PreviewEntry = { targetId: number; targetName: string; port: number; url: string; base: string; mode: 'keep' | 'strip' | null; by: 'user' | 'agent'; label: string | null; createdAt: number; status: number | null; error: string | null; online?: boolean };
type Width = 'full' | 'tablet' | 'phone';
const WIDTHS: Array<{ id: Width; px: number | null; title: string; icon: typeof Laptop }> = [
  { id: 'full', px: null, title: '전체 폭', icon: Laptop },
  { id: 'tablet', px: 820, title: '태블릿 (820)', icon: Tablet },
  { id: 'phone', px: 390, title: '휴대폰 (390)', icon: Smartphone },
];
const keyOf = (p: { targetId: number; port: number }) => `${p.targetId}:${p.port}`;

/** Newest preview list, polled while `active` (the workbench also uses it to notice agent-opened previews). */
export function usePreviewList(active: boolean, intervalMs = 5000) {
  const [previews, setPreviews] = useState<PreviewEntry[]>([]);
  const load = useCallback(async () => {
    try { setPreviews((await readApiJson<{ previews: PreviewEntry[] }>(await api.targets.previews())).previews ?? []); } catch { /* keep the last list */ }
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    void load();
    const timer = window.setInterval(() => { void load(); }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs, load]);
  return { previews, reload: load };
}

/** Used by WorkbenchLayout (desktop bottom panel "미리보기", tablet pane) to show dev servers of remote PCs. */
export function PreviewPane({ isVisible = true }: { isVisible?: boolean }) {
  const { previews, reload } = usePreviewList(isVisible);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [width, setWidth] = useState<Width>('full');
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [port, setPort] = useState('5173');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const seenRef = useRef<number>(0);

  useEffect(() => {
    if (!isVisible) return;
    void (async () => {
      try {
        const r = await readApiJson<{ targets: Target[] }>(await api.targets.list());
        setTargets(r.targets ?? []);
        setTargetId((current) => current ?? r.targets.find((t) => t.online)?.id ?? r.targets[0]?.id ?? null);
      } catch { /* targets panel shows the error */ }
    })();
  }, [isVisible]);

  // a preview opened after the pane was last looked at (typically by an agent) becomes the selection
  useEffect(() => {
    const newest = previews[0];
    if (!newest) return;
    if (!selectedKey || newest.createdAt > seenRef.current) {
      seenRef.current = newest.createdAt;
      setSelectedKey(keyOf(newest));
      setFrameKey((n) => n + 1);
    }
  }, [previews, selectedKey]);

  const selected = previews.find((p) => keyOf(p) === selectedKey) ?? null;
  const open = async () => {
    const n = Number(port);
    if (!targetId || !Number.isInteger(n) || n < 1024 || n > 65535) { setNote('대상과 포트(1024~65535)를 확인하세요'); return; }
    setBusy(true); setNote(null);
    try {
      const r = await readApiJson<{ preview: PreviewEntry; hint: string }>(await api.targets.openPreview(targetId, n));
      setNote(r.hint);
      await reload();
      setSelectedKey(keyOf(r.preview)); setFrameKey((k) => k + 1);
    } catch (error) { setNote(error instanceof Error ? error.message : '미리보기를 열 수 없습니다'); }
    finally { setBusy(false); }
  };
  const close = async (p: PreviewEntry) => {
    try { await api.targets.closePreview(p.targetId, p.port); } catch { /* list refresh shows the truth */ }
    if (keyOf(p) === selectedKey) setSelectedKey(null);
    await reload();
  };
  const px = WIDTHS.find((w) => w.id === width)?.px ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <MonitorPlay size={13} className="text-muted-foreground" />
        <select aria-label="미리보기" value={selectedKey ?? ''} onChange={(event) => { setSelectedKey(event.target.value || null); setFrameKey((k) => k + 1); }} className="h-7 max-w-[260px] rounded border border-border bg-background px-1">
          {previews.length ? null : <option value="">열린 미리보기 없음</option>}
          {previews.map((p) => <option key={keyOf(p)} value={keyOf(p)}>{p.label ? `${p.label} · ` : ''}{p.targetName}:{p.port}{p.by === 'agent' ? ' (agent)' : ''}{p.online === false ? ' · 오프라인' : ''}</option>)}
        </select>
        {WIDTHS.map((w) => (
          <button key={w.id} type="button" title={w.title} aria-label={w.title} aria-pressed={width === w.id} onClick={() => setWidth(w.id)} className={`rounded p-1 ${width === w.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted'}`}><w.icon size={14} /></button>
        ))}
        <button type="button" title="새로고침" aria-label="새로고침" disabled={!selected} onClick={() => setFrameKey((k) => k + 1)} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"><RefreshCw size={14} /></button>
        {selected ? <a href={selected.url} target="_blank" rel="noreferrer" title="새 창에서 열기" className="rounded p-1 text-muted-foreground hover:bg-muted"><ExternalLink size={14} /></a> : null}
        {selected ? <button type="button" title="목록에서 닫기" aria-label="목록에서 닫기" onClick={() => { void close(selected); }} className="rounded p-1 text-muted-foreground hover:bg-muted"><X size={14} /></button> : null}
        <div className="ml-auto flex items-center gap-1">
          <select aria-label="원격 대상" value={targetId ?? ''} onChange={(event) => setTargetId(Number(event.target.value) || null)} className="h-7 rounded border border-border bg-background px-1">
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (오프라인)'}</option>)}
          </select>
          <input aria-label="포트" value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={(event) => { if (event.key === 'Enter') void open(); }} className="h-7 w-16 rounded border border-border bg-background px-1.5" placeholder="5173" />
          <button type="button" disabled={busy || !targetId} onClick={() => { void open(); }} className="h-7 rounded bg-primary px-2 text-primary-foreground disabled:opacity-50">열기</button>
        </div>
      </div>
      {note ? <div className="shrink-0 border-b border-border bg-muted/30 px-2 py-1 text-muted-foreground">{note}</div> : null}
      {selected?.error ? <div className="shrink-0 border-b border-border px-2 py-1 text-rose-600">{selected.error}</div> : null}
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-muted/40">
        {selected ? (
          // no allow-same-origin: the gateway also sends CSP sandbox, the page gets an opaque origin
          <iframe key={`${selectedKey}:${frameKey}`} title={`미리보기 ${selected.targetName}:${selected.port}`} src={selected.url}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox"
            className="h-full border-x border-border bg-white" style={{ width: px ? `${px}px` : '100%', maxWidth: '100%' }} />
        ) : (
          <div className="self-center p-6 text-center leading-6 text-muted-foreground">원격 PC에서 개발 서버를 실행하고 포트를 입력해 여세요.<br />agent에게 “내 Mac에서 실행해서 보여줘”라고 하면 자동으로 열립니다.</div>
        )}
      </div>
    </div>
  );
}
