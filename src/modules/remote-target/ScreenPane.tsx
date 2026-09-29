import { useEffect, useRef, useState } from 'react';
import { Camera, Monitor, Pause, Play } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';

/**
 * ScreenPane (IMPLEMENTATION-PLAN §3.12, F-07): the live screen of one of the user's PCs, view only.
 * One WebSocket (`/api/aidev/targets/:id/screen`) delivers JPEG frames only when the picture changes;
 * viewers with the same display/fps/size share the runner's capture. Needs runner ≥ 0.5 and the PC
 * owner's consent (`aidev-runner consent screen on`); otherwise the gateway's message is shown.
 */
type Target = { id: number; name: string; online: boolean; capabilities: { screen?: boolean; features?: string[] } | null };
type Display = { id: number; name?: string; resolution?: string; main?: boolean };
const FPS = [0.5, 1, 2, 5, 10];
const WIDTHS = [960, 1440, 1920];

/** Used by WorkbenchLayout (desktop bottom panel "화면", tablet pane) to watch a remote PC's screen. */
export function ScreenPane({ isVisible = true }: { isVisible?: boolean }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [displays, setDisplays] = useState<Display[]>([]);
  const [display, setDisplay] = useState(1);
  const [fps, setFps] = useState(2);
  const [maxWidth, setMaxWidth] = useState(1440);
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stats, setStats] = useState({ frames: 0, bytes: 0, at: 0 });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isVisible) return;
    void (async () => {
      try {
        const r = await readApiJson<{ targets: Target[] }>(await api.targets.list());
        setTargets(r.targets ?? []);
        setTargetId((current) => current ?? r.targets.find((t) => t.online && t.capabilities?.screen)?.id ?? r.targets.find((t) => t.online)?.id ?? r.targets[0]?.id ?? null);
      } catch { /* targets panel shows the error */ }
    })();
  }, [isVisible]);

  useEffect(() => {
    if (!targetId || !isVisible) return;
    api.targets.screens(targetId).then((res) => readApiJson<{ displays: Display[] }>(res)).then((r) => setDisplays(r.displays ?? [])).catch(() => setDisplays([]));
  }, [targetId, isVisible]);

  // one socket while visible and not paused; new options reconnect
  useEffect(() => {
    if (!targetId || !isVisible || paused) return undefined;
    setNote(null);
    const ws = new WebSocket(api.targets.screenUrl(targetId, { display, fps, maxWidth }));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const m = JSON.parse(event.data) as { type: string; message?: string };
          if (m.type === 'error') setNote(m.message ?? '화면을 가져오지 못했습니다');
          if (m.type === 'offline') setNote('원격 PC가 오프라인입니다');
          if (m.type === 'started') setNote(null);
        } catch { /* ignore */ }
        return;
      }
      const buf = event.data as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setFrame(url);
      setStats((s) => ({ frames: s.frames + 1, bytes: s.bytes + buf.byteLength, at: Date.now() }));
    };
    ws.onclose = (event) => { if (event.code !== 1000 && event.code !== 1005) setNote((n) => n ?? '화면 연결이 끊어졌습니다'); };
    return () => ws.close(1000);
  }, [targetId, display, fps, maxWidth, isVisible, paused]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const target = targets.find((t) => t.id === targetId) ?? null;
  const save = () => {
    if (!frame) return;
    const a = document.createElement('a');
    a.href = frame; a.download = `${target?.name ?? 'screen'}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`; a.click();
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Monitor size={13} className="text-muted-foreground" />
        <select aria-label="원격 대상" value={targetId ?? ''} onChange={(event) => { setTargetId(Number(event.target.value) || null); setFrame(null); }} className="h-7 rounded border border-border bg-background px-1">
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (오프라인)'}{t.capabilities?.screen ? '' : ' · 캡처 미허용'}</option>)}
        </select>
        <select aria-label="디스플레이" value={display} onChange={(event) => setDisplay(Number(event.target.value))} className="h-7 rounded border border-border bg-background px-1">
          {(displays.length ? displays : [{ id: 1, name: '주 화면' }]).map((d) => <option key={d.id} value={d.id}>{d.id}. {d.name ?? '디스플레이'}{d.resolution ? ` (${d.resolution})` : ''}</option>)}
        </select>
        <select aria-label="초당 프레임" value={fps} onChange={(event) => setFps(Number(event.target.value))} className="h-7 rounded border border-border bg-background px-1">
          {FPS.map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select>
        <select aria-label="해상도" value={maxWidth} onChange={(event) => setMaxWidth(Number(event.target.value))} className="h-7 rounded border border-border bg-background px-1">
          {WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
        </select>
        <button type="button" title={paused ? '다시 보기' : '일시 정지'} aria-label={paused ? '다시 보기' : '일시 정지'} onClick={() => setPaused((p) => !p)} className="rounded p-1 text-muted-foreground hover:bg-muted">{paused ? <Play size={14} /> : <Pause size={14} />}</button>
        <button type="button" title="현재 화면 저장" aria-label="현재 화면 저장" disabled={!frame} onClick={save} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"><Camera size={14} /></button>
        <span className="ml-auto text-muted-foreground">{stats.frames ? `${stats.frames}프레임 · ${(stats.bytes / 1048576).toFixed(1)}MB${stats.at ? ` · ${Math.max(0, Math.round((Date.now() - stats.at) / 1000))}초 전 변경` : ''}` : '보기 전용 · 변화가 있을 때만 전송'}</span>
      </div>
      {note ? <div className="shrink-0 border-b border-border bg-muted/30 px-2 py-1 text-rose-600">{note}</div> : null}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/80">
        {frame ? <img src={frame} alt={`${target?.name ?? ''} 화면`} className="max-h-full max-w-full object-contain" /> : <div className="p-6 text-center leading-6 text-muted-foreground">{paused ? '일시 정지됨' : target?.capabilities?.screen === false ? '이 PC에서 화면 캡처가 꺼져 있습니다. PC에서 `aidev-runner consent screen on` 후 러너를 다시 시작하세요.' : '화면을 기다리는 중…'}</div>}
      </div>
    </div>
  );
}
