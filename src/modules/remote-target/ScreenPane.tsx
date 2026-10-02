import { useCallback, useEffect, useState } from 'react';
import { AppWindow, Camera, MousePointer2, Pause, Play, RefreshCw } from 'lucide-react';

import { RemoteConsole, screenSocketUrl, useRemoteScreen, useScreenSources, type ScreenOptions } from '@/modules/remote-screen';
import { api, readApiJson } from '@/shared/api';
import type { RemoteConsoleSource, RemoteScreenSource, RemoteWindow } from '@/shared/types';

/**
 * ScreenPane (IMPLEMENTATION-PLAN §3.12, F-07/F-07b/F-07c): one program on a PC in the workbench. The
 * source is a program window (live H.264 from the runner's built-in encoder, decoded with WebCodecs, or
 * JPEG; paused = the last picture, snapshots on demand) or a console program running through the runner
 * (its terminal, live and typeable). With control on, mouse, wheel and keyboard on the window's picture
 * drive that window on the PC (the owner's `consent control on` is required; every session is recorded).
 */
type Target = { id: number; name: string; online: boolean; capabilities: { screen?: boolean; control?: boolean; features?: string[] } | null };
const QUALITY: Array<{ id: string; label: string; opts: Omit<ScreenOptions, 'window' | 'display'> }> = [
  { id: 'hq', label: '고화질 (1920 · 30fps)', opts: { mode: 'video', fps: 30, maxWidth: 1920, bitrate: 8000 } },
  { id: 'std', label: '기본 (1440 · 30fps)', opts: { mode: 'video', fps: 30, maxWidth: 1440, bitrate: 4000 } },
  { id: 'smooth', label: '부드럽게 (1280 · 60fps)', opts: { mode: 'video', fps: 60, maxWidth: 1280, bitrate: 6000 } },
  { id: 'low', label: '저대역 (960 · 15fps)', opts: { mode: 'video', fps: 15, maxWidth: 960, bitrate: 1200 } },
  { id: 'jpeg', label: '이미지 (변할 때만 · 2fps)', opts: { mode: 'jpeg', fps: 2, maxWidth: 1440, bitrate: 0 } },
];

const windowLabel = (w: RemoteWindow) => `${w.focused ? '● ' : ''}${w.app || '앱'}${w.title && w.title !== w.app ? ` — ${w.title.length > 60 ? `${w.title.slice(0, 60)}…` : w.title}` : ''}`;
const consoleLabel = (c: RemoteConsoleSource) => `${c.pty ? '⌨ ' : ''}${c.cmd.length > 70 ? `${c.cmd.slice(0, 70)}…` : c.cmd}`;
const sourceKey = (s: RemoteScreenSource | null) => (!s ? '' : s.kind === 'window' ? `w:${s.id}` : s.kind === 'console' ? `c:${s.streamId}` : `d:${s.id}`);

/** Used by WorkbenchLayout (desktop bottom panel "화면", tablet pane) to watch and control a program on a remote PC. */
export function ScreenPane({ isVisible = true }: { isVisible?: boolean }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  // the user's pick, remembered per target (another target starts from its focused window)
  const [chosen, setChosen] = useState<{ targetId: number | null; source: RemoteScreenSource | null }>({ targetId: null, source: null });
  const [quality, setQuality] = useState('std');
  const [streaming, setStreaming] = useState(true);
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const sources = useScreenSources(targetId, isVisible, chosen.targetId === targetId ? chosen.source : null);
  const { windows, consoles, displays, perWindow, refresh, source, parse } = sources;
  const q = QUALITY.find((x) => x.id === quality) ?? QUALITY[1];
  const watching = source?.kind === 'window' || source?.kind === 'display';
  const opts: ScreenOptions = { ...q.opts, window: source?.kind === 'window' ? source.id : null, display: source?.kind === 'display' ? source.id : 1 };
  const screen = useRemoteScreen({ targetId, live: isVisible && streaming && watching, opts, url: screenSocketUrl });
  const { canvasRef, keysRef, state, setControl } = screen;

  useEffect(() => {
    if (!isVisible) return;
    void (async () => {
      try {
        const r = await readApiJson<{ targets: Target[] }>(await api.targets.list());
        setTargets(r.targets ?? []);
        setTargetId((current) => current ?? r.targets.find((t) => t.online && t.capabilities?.screen)?.id ?? r.targets.find((t) => t.online)?.id ?? r.targets[0]?.id ?? null);
      } catch { /* the targets panel shows the error */ }
    })();
  }, [isVisible]);

  // a stream that ended (window closed or minimized) → the list is probably stale
  useEffect(() => { if (state.error) void refresh(); }, [state.error, refresh]);


  // paused: one fresh picture of the window on demand, drawn where the stream was
  const snapshot = useCallback(async () => {
    if (!targetId || !canvasRef.current || !source || source.kind === 'console') return;
    setSnapNote('가져오는 중…');
    try {
      const where = source.kind === 'window' ? { window: source.id } : { display: source.id };
      const r = await readApiJson<{ image: string; width: number; height: number }>(await api.targets.screenshot(targetId, { ...where, maxWidth: q.opts.maxWidth }));
      const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${r.image}`)).blob());
      const c = canvasRef.current; c.width = bmp.width; c.height = bmp.height; c.getContext('2d')?.drawImage(bmp, 0, 0); bmp.close();
      setSnapNote(null);
    } catch (error) { setSnapNote(error instanceof Error ? error.message : '화면을 가져오지 못했습니다'); }
  }, [targetId, source, q.opts.maxWidth, canvasRef]);

  const target = targets.find((t) => t.id === targetId) ?? null;
  const win = source?.kind === 'window' ? windows.find((w) => w.id === source.id) ?? null : null;
  const save = () => {
    const c = canvasRef.current; if (!c || !c.width) return;
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `${target?.name ?? 'screen'}-${win?.app ?? 'window'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`; a.click();
  };
  const canControl = streaming && state.controlAvailable && (source?.kind === 'window' || (source?.kind === 'display' && source.id === 1));
  const controlTitle = !state.controlAvailable ? '이 PC에서 원격 제어가 꺼져 있습니다 — 러너를 최신으로 업데이트하면 자동으로 켜집니다 (직접 껐다면 PC에서 aidev-runner consent control on)' : source?.kind === 'display' && source.id !== 1 ? '제어는 주 화면(1번)에서만 됩니다' : state.control ? '제어 끄기' : '이 창을 마우스·키보드로 제어';
  const empty = !sources.loading && !windows.length && !consoles.length && perWindow;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <AppWindow size={13} className="text-muted-foreground" />
        <select aria-label="원격 대상" value={targetId ?? ''} onChange={(event) => setTargetId(Number(event.target.value) || null)} className="h-7 rounded border border-border bg-background px-1">
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (오프라인)'}{t.capabilities?.screen ? '' : ' · 화면 미허용'}</option>)}
        </select>
        <select aria-label="프로그램" value={sourceKey(source)} onChange={(event) => setChosen({ targetId, source: parse(event.target.value) })} className="h-7 max-w-[22rem] rounded border border-border bg-background px-1">
          {!source ? <option value="">{sources.loading ? '불러오는 중…' : '프로그램 없음'}</option> : null}
          {windows.length ? <optgroup label="프로그램 창">{windows.map((w) => <option key={w.id} value={`w:${w.id}`}>{windowLabel(w)}</option>)}</optgroup> : null}
          {consoles.length ? <optgroup label="콘솔 (러너로 실행 중)">{consoles.map((c) => <option key={c.streamId} value={`c:${c.streamId}`}>{consoleLabel(c)}</option>)}</optgroup> : null}
          {!perWindow ? <optgroup label="디스플레이 (러너 0.7 미만)">{(displays.length ? displays : [{ id: 1, name: '주 화면' }]).map((d) => <option key={d.id} value={`d:${d.id}`}>{d.id}. {d.name ?? '디스플레이'}</option>)}</optgroup> : null}
        </select>
        <button type="button" title="창 목록 새로 고침" aria-label="창 목록 새로 고침" onClick={() => { void refresh(); }} className="rounded p-1 text-muted-foreground hover:bg-muted"><RefreshCw size={14} className={sources.loading ? 'animate-spin' : ''} /></button>
        {watching ? (
          <>
            <select aria-label="화질" value={quality} onChange={(event) => setQuality(event.target.value)} className="h-7 rounded border border-border bg-background px-1">
              {QUALITY.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <button type="button" onClick={() => setStreaming((v) => !v)} className={`flex h-7 items-center gap-1 rounded px-2 ${streaming ? 'bg-muted text-foreground' : 'bg-primary text-primary-foreground'}`}>{streaming ? <><Pause size={13} /> 정지</> : <><Play size={13} /> 스트리밍</>}</button>
            {!streaming ? <button type="button" title="지금 화면 가져오기" aria-label="지금 화면 가져오기" onClick={() => { void snapshot(); }} className="rounded px-1.5 py-1 text-muted-foreground hover:bg-muted">새로 찍기</button> : null}
            <button type="button" title={controlTitle} aria-pressed={state.control} disabled={!canControl} onClick={() => setControl(!state.control)}
              className={`flex h-7 items-center gap-1 rounded px-2 disabled:opacity-40 ${state.control ? 'bg-rose-600 text-white' : 'border border-border hover:bg-muted'}`}><MousePointer2 size={13} />{state.control ? '제어 중' : '제어'}</button>
            <button type="button" title="현재 화면 저장" aria-label="현재 화면 저장" onClick={save} className="rounded p-1 text-muted-foreground hover:bg-muted"><Camera size={14} /></button>
            <span className="ml-auto text-muted-foreground">{streaming ? `${state.codec ?? '…'} · ${state.fps}fps · ${(state.kbps / 1000).toFixed(1)}Mbps${state.width ? ` · ${state.width}×${state.height}` : ''}` : '정지됨 — 마지막 화면'}</span>
          </>
        ) : null}
      </div>
      {watching && state.control ? <div className="shrink-0 border-b border-border bg-rose-600/10 px-2 py-1 text-rose-700 dark:text-rose-300">원격 제어 중 — 화면 위의 마우스·휠·키보드가 {target?.name ?? 'PC'}의 {win ? `“${win.app}” 창` : '화면'}으로 전달됩니다 (Esc도 전달). 끝나면 “제어 중”을 눌러 해제하세요.</div> : null}
      {watching && state.note ? <div className="shrink-0 border-b border-border bg-muted/30 px-2 py-1 text-amber-700 dark:text-amber-300">{state.note}</div> : null}
      {(watching && (state.error || snapNote)) || sources.error ? <div className="shrink-0 border-b border-border bg-muted/30 px-2 py-1 text-rose-600">{(watching ? state.error ?? snapNote : null) ?? sources.error}</div> : null}
      {source?.kind === 'console' && targetId ? (
        <div className="min-h-0 flex-1"><RemoteConsole key={`${targetId}:${source.streamId}`} targetId={targetId} streamId={source.streamId} /></div>
      ) : (
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/85">
          <canvas ref={canvasRef} className={`max-h-full max-w-full ${state.control ? 'cursor-none outline outline-2 outline-rose-500' : ''}`} style={{ touchAction: 'none' }} />
          {/* keyboard sink: keeps focus while controlling, receives IME text */}
          <textarea ref={keysRef} aria-label="원격 키보드 입력" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0" />
          {!state.width && streaming ? (
            <div className="absolute max-w-md px-4 text-center leading-6 text-muted-foreground">
              {target && !target.capabilities?.screen ? '이 PC에서 화면 보기가 꺼져 있습니다. 러너를 최신으로 업데이트하면 첫 실행에서 자동으로 켜집니다 (직접 껐다면 PC에서 `aidev-runner consent screen on`).'
                : empty ? '보이는 프로그램 창이 없습니다 (최소화된 창은 목록에 나오지 않습니다).'
                  : state.status === 'connecting' || state.status === 'live' ? '화면을 기다리는 중…' : '연결되지 않음'}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
