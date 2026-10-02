import { useEffect, useState } from 'react';
import { ExternalLink, Play, Plus, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { aidevApi } from '@/modules/aidev-router';
import { fillCommand, useDevServer, usePreviewList } from '@/modules/remote-preview';
import { api, readApiJson } from '@/shared/api';
import type { RemotePreviewEntry } from '@/shared/types';
import { TopBar } from '@m/components/TopBar';
import { useOpener, useParent } from '@m/lib/nav';

/**
 * Dev-server previews on the phone (F-06/F-06b): the page full screen, the previews that are open
 * (agents' ones included), and — to open another — the PC's open ports and its projects with
 * "개발 서버 시작" (the runner starts it; the preview opens once it answers).
 */
type Target = { id: number; name: string; online: boolean };
const keyOf = (p: { targetId: number; port: number }) => `${p.targetId}:${p.port}`;

/** Route `/m/preview` (from the 원격 menu and the chat's "미리보기가 열렸습니다" banner). */
export function PreviewScreen() {
  const [params] = useSearchParams();
  useParent(useOpener('/'));
  const { previews, reload } = usePreviewList(true, 8000);
  // the preview on screen (`targetId:port`); the newest one until the user picks another
  const [selectedKey, setSelectedKey] = useState<string | null>(params.get('p'));
  // the "open another" panel: shown when there is nothing to show yet, or on demand
  const [adding, setAdding] = useState(false);
  // the PC and port the panel works on
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [port, setPort] = useState('5173');
  const [projectDir, setProjectDir] = useState('');
  const [note, setNote] = useState<string | null>(null);
  // bumping it reloads the page in the frame
  const [frameKey, setFrameKey] = useState(0);

  useEffect(() => {
    aidevApi.targets().then((r) => {
      const list = r.targets as unknown as Target[];
      setTargets(list);
      setTargetId((cur) => cur ?? list.find((t) => t.online)?.id ?? list[0]?.id ?? null);
    }).catch(() => setTargets([]));
  }, []);

  const selected: RemotePreviewEntry | null = previews.find((p) => keyOf(p) === selectedKey) ?? previews[0] ?? null;
  const showPanel = adding || !selected;
  const portNum = Number(port) || 5173;

  const open = async (p: number) => {
    if (!targetId) return;
    setNote(null);
    try {
      const r = await readApiJson<{ preview: RemotePreviewEntry; hint: string }>(await api.targets.openPreview(targetId, p));
      await reload();
      setSelectedKey(keyOf(r.preview)); setFrameKey((k) => k + 1);
      if (r.preview.error) setNote(r.hint); else { setAdding(false); setNote(null); }
    } catch (error) { setNote(error instanceof Error ? error.message : '미리보기를 열 수 없습니다'); }
  };
  const dev = useDevServer(targetId, portNum, showPanel, (ready) => { void open(ready); });
  const projects = dev.scan?.projects ?? [];
  const project = projects.find((p) => p.dir === projectDir) ?? projects[0] ?? null;
  const openPorts = (dev.scan?.ports ?? []).filter((p) => p.loopback);

  return (
    <div className="flex h-[100dvh] flex-col bg-bg">
      <TopBar title="미리보기" subtitle={selected ? `${selected.label ? `${selected.label} · ` : ''}${selected.targetName}:${selected.port}` : '열린 미리보기 없음'} back
        right={(
          <div className="flex items-center">
            {selected ? <button type="button" aria-label="새로고침" onClick={() => setFrameKey((k) => k + 1)} className="m-touch flex items-center justify-center rounded-full text-muted"><RefreshCw size={18} /></button> : null}
            {selected ? <a href={selected.url} target="_blank" rel="noreferrer" aria-label="브라우저에서 열기" className="m-touch flex items-center justify-center rounded-full text-muted"><ExternalLink size={18} /></a> : null}
            <button type="button" aria-label="다른 미리보기 열기" aria-pressed={showPanel} onClick={() => setAdding((v) => !v)} className={`m-touch flex items-center justify-center rounded-full ${showPanel ? 'text-accent' : 'text-muted'}`}><Plus size={20} /></button>
          </div>
        )} />
      {previews.length > 1 ? (
        <div className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2 text-[13px]">
          {previews.map((p) => (
            <button key={keyOf(p)} type="button" onClick={() => { setSelectedKey(keyOf(p)); setAdding(false); setFrameKey((k) => k + 1); }} className={`m-touch shrink-0 rounded-full px-3 py-1 ${selected && keyOf(selected) === keyOf(p) ? 'bg-ink text-bg' : 'border border-line'}`}>{p.label ?? p.targetName}:{p.port}{p.by === 'agent' ? ' · agent' : ''}</button>
          ))}
        </div>
      ) : null}
      {showPanel ? (
        <div className="space-y-2 border-b border-line px-3 py-3 text-[13px]">
          <div className="flex gap-2">
            <select aria-label="원격 PC" value={targetId ?? ''} onChange={(e) => setTargetId(Number(e.target.value) || null)} className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5">
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (오프라인)'}</option>)}
            </select>
            <input aria-label="포트" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} className="w-20 rounded-lg border border-line bg-surface px-2 py-1.5" />
            <button type="button" onClick={() => { void open(portNum); }} className="m-touch rounded-lg bg-accent px-3 text-accent-ink">열기</button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted">열린 포트</span>
            {openPorts.length ? openPorts.slice(0, 8).map((p) => <button key={p.port} type="button" onClick={() => { setPort(String(p.port)); void open(p.port); }} className="m-touch rounded-full border border-line px-2.5 py-0.5">{p.port}{p.process ? ` · ${p.process}` : ''}</button>)
              : <span className="text-muted">{dev.scanError ?? (dev.scan ? '없음' : '…')}</span>}
          </div>
          {projects.length ? (
            <div className="space-y-1.5">
              <select aria-label="프로젝트" value={project?.dir ?? ''} onChange={(e) => setProjectDir(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-2 py-1.5">
                {projects.map((p) => <option key={p.dir} value={p.dir}>{p.name} · {p.framework}</option>)}
              </select>
              {project ? <div className="break-all rounded-lg bg-surface px-2 py-1.5 font-mono text-[11px] text-muted">{fillCommand(project.command, portNum, dev.scan?.port === portNum ? dev.scan.base : '…')}</div> : null}
              <button type="button" disabled={!project || dev.start.phase === 'starting'} onClick={() => { if (project) void dev.run(project, null, portNum); }} className="m-touch flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-[15px] font-medium text-accent-ink disabled:opacity-50"><Play size={15} /> 개발 서버 시작</button>
            </div>
          ) : dev.scan ? <div className="text-muted">허용 폴더({dev.scan.allowed_roots.join(', ') || '없음'})에 dev/start 스크립트가 있는 프로젝트가 없습니다. 채팅에서 agent에게 실행해 달라고 해도 됩니다.</div> : null}
          {dev.start.phase === 'starting' ? <div className="text-accent">개발 서버를 시작하는 중… 포트 {dev.start.port}이(가) 열리면 미리보기가 열립니다 (최대 2분)</div> : null}
          {dev.start.phase === 'failed' ? <div className="text-danger">{dev.start.message}</div> : null}
          {note ? <div className="text-danger">{note}</div> : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 bg-white">
        {selected ? (
          // no allow-same-origin: the gateway also sends CSP sandbox, the page gets an opaque origin
          <iframe key={`${keyOf(selected)}:${frameKey}`} title={`미리보기 ${selected.targetName}:${selected.port}`} src={selected.url}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox"
            className="h-full w-full border-0" />
        ) : null}
      </div>
    </div>
  );
}
