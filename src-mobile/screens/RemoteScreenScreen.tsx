import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { aidevApi } from '@/modules/aidev-router';
import { screenSocketUrl, useRemoteScreen, type ScreenOptions, type StickyMods } from '@/modules/remote-screen';
import { TopBar } from '@m/components/TopBar';

/**
 * A PC's screen on the phone (IMPLEMENTATION-PLAN §3.12, F-07b): starts paused on one snapshot (data and
 * battery); "스트리밍" plays it live (H.264/WebCodecs, JPEG fallback). With control on: tap = click,
 * long press = right click, drag = drag, two fingers = scroll; the key bar and the phone keyboard type.
 */
type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean; control?: boolean } | null };
const QUALITY: Array<{ id: string; label: string; opts: Omit<ScreenOptions, 'display'> }> = [
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

/** Route `/m/screen/:targetId` (from settings → 원격 PC 화면). */
export function RemoteScreenScreen() {
  const { targetId: raw } = useParams();
  const targetId = Number(raw) || null;
  const [target, setTarget] = useState<Target | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [quality, setQuality] = useState('std');
  const [sticky, setSticky] = useState<StickyMods>({});
  const stickyRef = useRef<StickyMods>({});
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const q = QUALITY.find((x) => x.id === quality) ?? QUALITY[0];
  const { canvasRef, keysRef, state, setControl, input } = useRemoteScreen({ targetId, live: streaming, opts: { ...q.opts, display: 1 }, url: screenSocketUrl, sticky: () => stickyRef.current });

  useEffect(() => { stickyRef.current = sticky; }, [sticky]);
  useEffect(() => { aidevApi.targets().then((r) => setTarget((r.targets as unknown as Target[]).find((t) => t.id === targetId) ?? null)).catch(() => setTarget(null)); }, [targetId]);

  const snapshot = useCallback(async () => {
    if (!targetId || !canvasRef.current) return;
    setSnapNote('가져오는 중…');
    try {
      const r = await aidevApi.screenshot(targetId, { maxWidth: 1280 });
      const bmp = await createImageBitmap(await (await fetch(`data:${r.mime};base64,${r.image}`)).blob());
      const c = canvasRef.current; c.width = bmp.width; c.height = bmp.height; c.getContext('2d')?.drawImage(bmp, 0, 0); bmp.close();
      setSnapNote(null);
    } catch (e) { setSnapNote(e instanceof Error ? e.message : '화면을 가져오지 못했습니다'); }
  }, [targetId, canvasRef]);
  // paused on open: one picture right away
  useEffect(() => { if (!streaming) void snapshot(); }, [streaming, snapshot]);

  const pressKey = (k: { key: string; code: string }) => { input({ t: 'key', key: k.key, code: k.code, mods: sticky }); setSticky({}); };
  const toggle = (m: keyof StickyMods) => setSticky((s) => ({ ...s, [m]: !s[m] }));

  return (
    <div className="flex h-[100dvh] flex-col bg-black">
      <TopBar title={target ? `${target.name} 화면` : '원격 화면'} subtitle={streaming ? `${state.codec ?? '…'} · ${state.fps}fps · ${(state.kbps / 1000).toFixed(1)}Mbps` : '정지됨 — 마지막 화면'} back="/settings"
        right={<button type="button" onClick={() => setStreaming((v) => !v)} className={`m-touch rounded-full px-3 py-1.5 text-[13px] ${streaming ? 'bg-surface text-ink' : 'bg-accent text-accent-ink'}`}>{streaming ? '정지' : '스트리밍'}</button>} />
      <div className="flex items-center gap-2 border-b border-line bg-bg px-3 py-2 text-[13px]">
        <select aria-label="화질" value={quality} onChange={(e) => setQuality(e.target.value)} className="rounded-lg border border-line bg-surface px-2 py-1">{QUALITY.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        {!streaming ? <button type="button" onClick={() => { void snapshot(); }} className="m-touch rounded-lg border border-line px-3 py-1">새로 찍기</button> : null}
        <button type="button" disabled={!streaming || !state.controlAvailable} onClick={() => setControl(!state.control)} className={`m-touch ml-auto rounded-lg px-3 py-1 disabled:opacity-40 ${state.control ? 'bg-danger text-white' : 'border border-line'}`}>{state.control ? '제어 중' : '제어'}</button>
      </div>
      {state.error || snapNote || state.note ? <div className="bg-bg px-3 py-1.5 text-[12px] text-danger">{state.error ?? snapNote ?? state.note}</div> : null}
      {!state.controlAvailable && streaming && state.status === 'live' ? <div className="bg-bg px-3 py-1.5 text-[12px] text-muted">이 PC는 원격 제어가 꺼져 있습니다 (PC에서 <code>aidev-runner consent control on</code>).</div> : null}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <canvas ref={canvasRef} className={`max-h-full max-w-full ${state.control ? 'outline outline-2 outline-danger' : ''}`} style={{ touchAction: 'none' }} />
        <textarea ref={keysRef} aria-label="원격 키보드 입력" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="absolute left-0 top-0 h-px w-px opacity-0" />
      </div>
      {state.control ? (
        <div className="flex flex-wrap gap-1.5 border-t border-line bg-bg px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)] text-[13px]">
          <button type="button" onClick={() => keysRef.current?.focus()} className="m-touch rounded-lg bg-accent px-3 py-1.5 text-accent-ink">⌨ 키보드</button>
          {(['ctrl', 'alt', 'meta', 'shift'] as const).map((m) => <button key={m} type="button" aria-pressed={Boolean(sticky[m])} onClick={() => toggle(m)} className={`m-touch rounded-lg px-2.5 py-1.5 ${sticky[m] ? 'bg-ink text-bg' : 'border border-line'}`}>{m === 'meta' ? '⌘' : m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : '⇧'}</button>)}
          {KEYS.map((k) => <button key={k.code} type="button" onClick={() => pressKey(k)} className="m-touch rounded-lg border border-line px-2.5 py-1.5">{k.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}
