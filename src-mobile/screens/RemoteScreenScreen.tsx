import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { aidevApi } from '@/modules/aidev-router';
import { isWholeScreen, RemoteConsole, screenSocketUrl, useRemoteScreen, useScreenSources, type ScreenOptions, type StickyMods } from '@/modules/remote-screen';
import type { RemoteScreenSource } from '@/shared/types';
import { TopBar } from '@m/components/TopBar';
import { useOpener, useParent } from '@m/lib/nav';

/**
 * A program on a PC, on the phone (IMPLEMENTATION-PLAN §3.12, F-07b/F-07c). The source is one program
 * window — starts paused on one snapshot (data and battery); "스트리밍" plays it live (H.264/WebCodecs,
 * JPEG fallback); with control on: tap = click, long press = right click, drag = drag, two fingers =
 * scroll, the key bar and the phone keyboard type into that window — or a console program running
 * through the runner (its terminal, with a key bar for Esc/Tab/Ctrl-C/arrows).
 */
type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean; control?: boolean } | null };
const QUALITY: Array<{ id: string; label: string; opts: Omit<ScreenOptions, 'window' | 'display'> }> = [
  { id: 'std', label: '기본', opts: { mode: 'video', fps: 30, maxWidth: 1440, bitrate: 3000 } },
  { id: 'low', label: '데이터 절약', opts: { mode: 'video', fps: 15, maxWidth: 960, bitrate: 1000 } },
  { id: 'hq', label: '고화질', opts: { mode: 'video', fps: 30, maxWidth: 1920, bitrate: 6000 } },
  { id: 'jpeg', label: '이미지', opts: { mode: 'jpeg', fps: 2, maxWidth: 1280, bitrate: 0 } },
];
const KEYS: Array<{ label: string; key: string; code: string }> = [
  { label: 'Esc', key: 'Escape', code: 'Escape' }, { label: 'Tab', key: 'Tab', code: 'Tab' },
  { label: '←', key: 'ArrowLeft', code: 'ArrowLeft' }, { label: '↑', key: 'ArrowUp', code: 'ArrowUp' }, { label: '↓', key: 'ArrowDown', code: 'ArrowDown' }, { label: '→', key: 'ArrowRight', code: 'ArrowRight' },
  { label: '⌫', key: 'Backspace', code: 'Backspace' }, { label: '⏎', key: 'Enter', code: 'Enter' },
];
const sourceKey = (s: RemoteScreenSource | null) => (!s ? '' : s.kind === 'window' ? `w:${s.id}` : s.kind === 'console' ? `c:${s.streamId}` : `d:${s.id}`);

/** Route `/m/screen/:targetId` (from the drawer's 원격 제어 → a PC, or a result card's "지금 화면 보기"). */
export function RemoteScreenScreen() {
  const { targetId: raw } = useParams();
  useParent(useOpener('/'));
  const targetId = Number(raw) || null;
  const [target, setTarget] = useState<Target | null>(null);
  const [chosen, setChosen] = useState<RemoteScreenSource | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [quality, setQuality] = useState('std');
  const [sticky, setSticky] = useState<StickyMods>({});
  const stickyRef = useRef<StickyMods>({});
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const sources = useScreenSources(targetId, true, chosen);
  const { windows, consoles, displays, perWindow, refresh, source, parse } = sources;
  const q = QUALITY.find((x) => x.id === quality) ?? QUALITY[0];
  const watching = source?.kind === 'window' || source?.kind === 'display';
  const opts: ScreenOptions = { ...q.opts, window: source?.kind === 'window' ? source.id : null, display: source?.kind === 'display' ? source.id : 1 };
  const { canvasRef, keysRef, state, setControl, input } = useRemoteScreen({ targetId, live: streaming && watching, opts, url: screenSocketUrl, sticky: () => stickyRef.current });

  useEffect(() => { stickyRef.current = sticky; }, [sticky]);
  useEffect(() => { aidevApi.targets().then((r) => setTarget((r.targets as unknown as Target[]).find((t) => t.id === targetId) ?? null)).catch(() => setTarget(null)); }, [targetId]);
  useEffect(() => { if (state.error) void refresh(); }, [state.error, refresh]);


  const snapshot = useCallback(async () => {
    if (!targetId || !canvasRef.current || !source || source.kind === 'console') return;
    setSnapNote('가져오는 중…');
    try {
      const r = await aidevApi.screenshot(targetId, { ...(source.kind === 'window' ? { window: source.id } : { display: source.id }), maxWidth: 1280 });
      const bmp = await createImageBitmap(await (await fetch(`data:${r.mime};base64,${r.image}`)).blob());
      const c = canvasRef.current; c.width = bmp.width; c.height = bmp.height; c.getContext('2d')?.drawImage(bmp, 0, 0); bmp.close();
      setSnapNote(null);
    } catch (e) { setSnapNote(e instanceof Error ? e.message : '화면을 가져오지 못했습니다'); }
  }, [targetId, source, canvasRef]);
  // paused (the default on a phone): one picture of the chosen window right away
  useEffect(() => { if (!streaming && watching) void snapshot(); }, [streaming, watching, snapshot]);

  const pressKey = (k: { key: string; code: string }) => { input({ t: 'key', key: k.key, code: k.code, mods: sticky }); setSticky({}); };
  const toggle = (m: keyof StickyMods) => setSticky((s) => ({ ...s, [m]: !s[m] }));
  const win = source?.kind === 'window' ? windows.find((w) => w.id === source.id) ?? null : null;
  const subtitle = !watching ? (source?.kind === 'console' ? '콘솔' : '프로그램을 고르세요') : streaming ? `${state.codec ?? '…'} · ${state.fps}fps · ${(state.kbps / 1000).toFixed(1)}Mbps` : '정지됨 — 마지막 화면';

  return (
    <div className="flex h-[100dvh] flex-col bg-black">
      <TopBar title={win ? win.app || '프로그램' : target ? `${target.name}` : '원격 화면'} subtitle={subtitle} back
        right={watching ? <button type="button" onClick={() => setStreaming((v) => !v)} className={`m-touch rounded-full px-3 py-1.5 text-[13px] ${streaming ? 'bg-surface text-ink' : 'bg-accent text-accent-ink'}`}>{streaming ? '정지' : '스트리밍'}</button> : undefined} />
      <div className="flex items-center gap-2 border-b border-line bg-bg px-3 py-2 text-[13px]">
        <select aria-label="프로그램" value={sourceKey(source)} onChange={(e) => setChosen(parse(e.target.value))} className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1">
          {!source ? <option value="">{sources.loading ? '불러오는 중…' : '프로그램 없음'}</option> : null}
          {windows.some((w) => isWholeScreen(w.id)) ? <optgroup label="전체 화면">{windows.filter((w) => isWholeScreen(w.id)).map((w) => <option key={w.id} value={`w:${w.id}`}>{w.title || '화면'} · {w.width}×{w.height}</option>)}</optgroup> : null}
          {windows.some((w) => !isWholeScreen(w.id)) ? <optgroup label="프로그램 창">{windows.filter((w) => !isWholeScreen(w.id)).map((w) => <option key={w.id} value={`w:${w.id}`}>{w.focused ? '● ' : ''}{w.app || '앱'}{w.title && w.title !== w.app ? ` — ${w.title}` : ''}</option>)}</optgroup> : null}
          {consoles.length ? <optgroup label="콘솔">{consoles.map((c) => <option key={c.streamId} value={`c:${c.streamId}`}>{c.pty ? '⌨ ' : ''}{c.cmd}</option>)}</optgroup> : null}
          {!perWindow ? <optgroup label="디스플레이">{(displays.length ? displays : [{ id: 1 }]).map((d) => <option key={d.id} value={`d:${d.id}`}>디스플레이 {d.id}</option>)}</optgroup> : null}
        </select>
        <button type="button" aria-label="목록 새로 고침" onClick={() => { void refresh(); }} className="m-touch rounded-lg border border-line px-2 py-1">↻</button>
        {watching ? <select aria-label="화질" value={quality} onChange={(e) => setQuality(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1">{QUALITY.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select> : null}
      </div>
      {watching ? (
        <div className="flex items-center gap-2 border-b border-line bg-bg px-3 py-2 text-[13px]">
          {!streaming ? <button type="button" onClick={() => { void snapshot(); }} className="m-touch rounded-lg border border-line px-3 py-1">새로 찍기</button> : null}
          <button type="button" disabled={!streaming || !state.controlAvailable} onClick={() => setControl(!state.control)} className={`m-touch ml-auto rounded-lg px-3 py-1 disabled:opacity-40 ${state.control ? 'bg-danger text-white' : 'border border-line'}`}>{state.control ? '제어 중' : '제어'}</button>
        </div>
      ) : null}
      {(watching && (state.error || snapNote || state.note)) || sources.error ? <div className="bg-bg px-3 py-1.5 text-[12px] text-danger">{(watching ? state.error ?? snapNote ?? state.note : null) ?? sources.error}</div> : null}
      {watching && !state.controlAvailable && streaming && state.status === 'live' ? <div className="bg-bg px-3 py-1.5 text-[12px] text-muted">이 PC는 원격 제어가 꺼져 있습니다 (PC에서 <code>aidev-runner consent control on</code>).</div> : null}
      {source?.kind === 'console' && targetId ? (
        <div className="min-h-0 flex-1"><RemoteConsole key={`${targetId}:${source.streamId}`} targetId={targetId} streamId={source.streamId} keyBar fontSize={12} /></div>
      ) : (
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <canvas ref={canvasRef} className={`max-h-full max-w-full ${state.control ? 'outline outline-2 outline-danger' : ''}`} style={{ touchAction: 'none' }} />
          <textarea ref={keysRef} aria-label="원격 키보드 입력" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="absolute left-0 top-0 h-px w-px opacity-0" />
          {!source && !sources.loading ? <div className="absolute px-6 text-center text-[13px] text-muted">{target && !target.capabilities?.screen ? '이 PC에서 화면 보기가 꺼져 있고 실행 중인 콘솔도 없습니다.' : '보이는 프로그램 창이나 실행 중인 콘솔이 없습니다.'}</div> : null}
        </div>
      )}
      {watching && state.control ? (
        <div className="flex flex-wrap gap-1.5 border-t border-line bg-bg px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)] text-[13px]">
          <button type="button" onClick={() => keysRef.current?.focus()} className="m-touch rounded-lg bg-accent px-3 py-1.5 text-accent-ink">⌨ 키보드</button>
          {(['ctrl', 'alt', 'meta', 'shift'] as const).map((m) => <button key={m} type="button" aria-pressed={Boolean(sticky[m])} onClick={() => toggle(m)} className={`m-touch rounded-lg px-2.5 py-1.5 ${sticky[m] ? 'bg-ink text-bg' : 'border border-line'}`}>{m === 'meta' ? '⌘' : m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : '⇧'}</button>)}
          {KEYS.map((k) => <button key={k.code} type="button" onClick={() => pressKey(k)} className="m-touch rounded-lg border border-line px-2.5 py-1.5">{k.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}
