import { useCallback, useEffect, useRef, useState } from 'react';

import { bindRemoteInput, type StickyMods } from '@/modules/remote-screen/input';
import { RemoteScreenSession, type InputEvent, type ScreenOptions, type ScreenState } from '@/modules/remote-screen/session';

const IDLE: ScreenState = { status: 'closed', codec: null, note: null, error: null, controlAvailable: false, control: false, width: 0, height: 0, fps: 0, kbps: 0 };

/**
 * Used by the workbench ScreenPane and the mobile remote screen: streams a PC's screen into `canvasRef`
 * while `live` is true (paused = the last picture stays), and forwards input while control is on.
 */
export function useRemoteScreen(p: { targetId: number | null; live: boolean; opts: ScreenOptions; url: (targetId: number, opts: ScreenOptions) => string; sticky?: () => StickyMods }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keysRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<RemoteScreenSession | null>(null);
  const [state, setState] = useState<ScreenState>(IDLE);
  const optsRef = useRef(p.opts);
  const urlRef = useRef(p.url);
  const stickyRef = useRef(p.sticky);
  // latest values for the effects below (declared first, so they run first)
  useEffect(() => { optsRef.current = p.opts; urlRef.current = p.url; stickyRef.current = p.sticky; });

  // one session per target while live; option changes move the viewer without reconnecting
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!p.live || !p.targetId || !canvas) { setState((s) => ({ ...s, status: 'closed', control: false })); return undefined; }
    const targetId = p.targetId;
    const session = new RemoteScreenSession((o) => urlRef.current(targetId, o), canvas, optsRef.current, setState);
    sessionRef.current = session;
    return () => { session.close(); sessionRef.current = null; };
  }, [p.live, p.targetId]);

  const optsKey = JSON.stringify(p.opts);
  const firstOpts = useRef(true);
  useEffect(() => {
    if (firstOpts.current) { firstOpts.current = false; return; }
    sessionRef.current?.setOptions(optsRef.current);
  }, [optsKey]);

  useEffect(() => {
    const canvas = canvasRef.current; const keys = keysRef.current;
    if (!canvas || !keys || !state.control) return undefined;
    const send = (ev: InputEvent) => sessionRef.current?.input(ev);
    const unbind = bindRemoteInput(canvas, keys, send, () => stickyRef.current?.() ?? {});
    if (!window.matchMedia?.('(pointer: coarse)').matches) keys.focus({ preventScroll: true });
    return unbind;
  }, [state.control]);

  const setControl = useCallback((on: boolean) => sessionRef.current?.setControl(on), []);
  const input = useCallback((ev: InputEvent) => sessionRef.current?.input(ev), []);
  return { canvasRef, keysRef, state, setControl, input };
}
