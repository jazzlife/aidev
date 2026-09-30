import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Laptop, MonitorPlay, Play, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';

import { focusRemoteRun } from '@/modules/aidev-router';
import { fillCommand, useDevServer, usePreviewList } from '@/modules/remote-preview';
import { api, readApiJson } from '@/shared/api';
import type { RemotePreviewEntry } from '@/shared/types';

/**
 * PreviewPane (IMPLEMENTATION-PLAN §3.12, F-06): a dev server running on one of the user's PCs, shown in
 * the workbench through the gateway's `/p/<cap>/` tunnel (HMR included). The page runs sandboxed (opaque
 * origin), so it cannot touch the platform session. Previews opened by an agent (`remote_preview`) appear
 * in the list on their own; the user can also open one by port — the ports listening on the PC are
 * suggested — or start a project's dev server from here (F-06b: the runner finds the projects in the
 * allowed folders with their command; the preview opens once the server answers). Width presets frame the
 * page like a phone or tablet; "새 창" opens the same URL in a browser tab (the URL also works on a phone).
 */
type Target = { id: number; name: string; online: boolean };
type Width = 'full' | 'tablet' | 'phone';
const WIDTHS: Array<{ id: Width; px: number | null; title: string; icon: typeof Laptop }> = [
  { id: 'full', px: null, title: '전체 폭', icon: Laptop },
  { id: 'tablet', px: 820, title: '태블릿 (820)', icon: Tablet },
  { id: 'phone', px: 390, title: '휴대폰 (390)', icon: Smartphone },
];
const keyOf = (p: { targetId: number; port: number }) => `${p.targetId}:${p.port}`;

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
  // dev server start: chosen project (index into scan.projects) and its command as the user may edit it
  const [projectDir, setProjectDir] = useState<string>('');
  const [command, setCommand] = useState('');

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
  const open = async (portOverride?: number) => {
    const n = portOverride ?? Number(port);
    if (!targetId || !Number.isInteger(n) || n < 1024 || n > 65535) { setNote('대상과 포트(1024~65535)를 확인하세요'); return; }
    setBusy(true); setNote(null);
    try {
      const r = await readApiJson<{ preview: RemotePreviewEntry; hint: string }>(await api.targets.openPreview(targetId, n));
      setNote(r.hint);
      await reload();
      setSelectedKey(keyOf(r.preview)); setFrameKey((k) => k + 1);
      if (portOverride) setPort(String(portOverride));
    } catch (error) { setNote(error instanceof Error ? error.message : '미리보기를 열 수 없습니다'); }
    finally { setBusy(false); }
  };
  const close = async (p: RemotePreviewEntry) => {
    try { await api.targets.closePreview(p.targetId, p.port); } catch { /* list refresh shows the truth */ }
    if (keyOf(p) === selectedKey) setSelectedKey(null);
    await reload();
  };
  const px = WIDTHS.find((w) => w.id === width)?.px ?? null;

  const portNum = Number(port) || 5173;
  const dev = useDevServer(targetId, portNum, isVisible, (ready) => { void open(ready); });
  const projects = dev.scan?.projects ?? [];
  const project = projects.find((p) => p.dir === projectDir) ?? projects[0] ?? null;
  // the command follows the project and port until the user edits it
  // the preview path is signed per port: shown once the scan for this port is in (start() refills it anyway)
  const suggested = project && dev.scan?.port === portNum ? fillCommand(project.command, portNum, dev.scan.base) : project ? fillCommand(project.command, portNum, '…') : '';
  const reloadDev = dev.reload;
  useEffect(() => {
    if (!isVisible || !targetId || portNum < 1024) return undefined;
    const t = window.setTimeout(() => { void reloadDev(portNum); }, 400);
    return () => window.clearTimeout(t);
  }, [portNum, targetId, isVisible, reloadDev]);
  const [edited, setEdited] = useState(false);
  const shownCommand = edited ? command : suggested;
  const startDev = () => {
    if (!project || !shownCommand.trim()) return;
    setNote(null);
    void dev.run(project, edited ? shownCommand.trim() : null, portNum);
  };
  const openPorts = (dev.scan?.ports ?? []).filter((p) => p.loopback);

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
          <input aria-label="포트" list="preview-open-ports" value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={(event) => { if (event.key === 'Enter') void open(); }} className="h-7 w-16 rounded border border-border bg-background px-1.5" placeholder="5173" />
          <datalist id="preview-open-ports">{openPorts.map((p) => <option key={p.port} value={p.port}>{p.process ?? ''}</option>)}</datalist>
          <button type="button" disabled={busy || !targetId} onClick={() => { void open(); }} className="h-7 rounded bg-primary px-2 text-primary-foreground disabled:opacity-50">열기</button>
        </div>
      </div>
      {targetId ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
          <span className="text-muted-foreground">열린 포트</span>
          {openPorts.length ? openPorts.slice(0, 8).map((p) => (
            <button key={p.port} type="button" title={`${p.address}:${p.port}${p.pid ? ` · pid ${p.pid}` : ''}`} onClick={() => { void open(p.port); }} className="rounded border border-border px-1.5 py-0.5 hover:bg-muted">{p.port}{p.process ? ` · ${p.process}` : ''}</button>
          )) : <span className="text-muted-foreground/70">{dev.scan ? '없음' : '…'}</span>}
          <span className="mx-1 h-4 w-px bg-border" />
          {projects.length ? (
            <>
              <select aria-label="프로젝트" value={project?.dir ?? ''} onChange={(event) => { setProjectDir(event.target.value); setEdited(false); }} className="h-7 max-w-56 rounded border border-border bg-background px-1">
                {projects.map((p) => <option key={p.dir} value={p.dir}>{p.name} · {p.framework}</option>)}
              </select>
              <input aria-label="개발 서버 명령" value={shownCommand} onChange={(event) => { setCommand(event.target.value); setEdited(true); }} className="aidev-selectable h-7 min-w-64 flex-1 rounded border border-border bg-background px-1.5 font-mono text-[11px]" />
              <button type="button" disabled={!project || dev.start.phase === 'starting'} onClick={startDev} className="flex h-7 items-center gap-1 rounded border border-border px-2 hover:bg-muted disabled:opacity-50"><Play size={12} /> 개발 서버 시작</button>
            </>
          ) : <span className="text-muted-foreground">{dev.scanError ?? (dev.scan ? `허용 폴더(${dev.scan.allowed_roots.join(', ') || '없음'})에 dev/start 스크립트가 있는 프로젝트가 없습니다` : '프로젝트 찾는 중…')}</span>}
          <button type="button" title="포트·프로젝트 다시 찾기" aria-label="포트·프로젝트 다시 찾기" onClick={() => { void dev.reload(); }} className="rounded p-1 text-muted-foreground hover:bg-muted"><RefreshCw size={12} /></button>
        </div>
      ) : null}
      {dev.start.phase === 'starting' ? <div className="shrink-0 border-b border-border bg-sky-500/10 px-2 py-1 text-sky-700 dark:text-sky-300">개발 서버를 시작하는 중… 포트 {dev.start.port}이(가) 열리면 미리보기가 열립니다 (최대 2분){dev.start.remoteRunId && targetId ? <> · <button type="button" className="underline" onClick={() => focusRemoteRun({ remoteRunId: (dev.start as { remoteRunId: number }).remoteRunId, targetId })}>출력 보기</button></> : null}</div> : null}
      {dev.start.phase === 'failed' ? <div className="shrink-0 border-b border-border px-2 py-1 text-rose-600">{dev.start.message}{dev.start.remoteRunId && targetId ? <> · <button type="button" className="underline" onClick={() => focusRemoteRun({ remoteRunId: (dev.start as { remoteRunId: number }).remoteRunId, targetId })}>출력 보기</button></> : null}</div> : null}
      {note ? <div className="shrink-0 border-b border-border bg-muted/30 px-2 py-1 text-muted-foreground">{note}</div> : null}
      {selected?.error ? <div className="shrink-0 border-b border-border px-2 py-1 text-rose-600">{selected.error}</div> : null}
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-muted/40">
        {selected ? (
          // no allow-same-origin: the gateway also sends CSP sandbox, the page gets an opaque origin
          <iframe key={`${selectedKey}:${frameKey}`} title={`미리보기 ${selected.targetName}:${selected.port}`} src={selected.url}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox"
            className="h-full border-x border-border bg-white" style={{ width: px ? `${px}px` : '100%', maxWidth: '100%' }} />
        ) : (
          <div className="self-center p-6 text-center leading-6 text-muted-foreground">위에서 열린 포트를 고르거나, 프로젝트를 골라 “개발 서버 시작”을 누르세요.<br />agent에게 “내 Mac에서 실행해서 보여줘”라고 해도 자동으로 열립니다.</div>
        )}
      </div>
    </div>
  );
}
