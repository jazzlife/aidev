import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';

import { api } from '@/shared/api';

/**
 * A console program on a remote PC (F-07c): the output of a command running there through the runner,
 * live in a terminal — the program's own text stream (sharper and far lighter than video of a terminal
 * window). Interactive (pty) runs take the keyboard; `keyBar` adds Esc/Tab/Ctrl-C/arrows for phones.
 * xterm is loaded on first use, so screens that never open a console do not carry it.
 */
type StreamInfo = { streamId: number; pty: boolean; running: boolean; code: number | null; signal: string | null };
const KEYS: Array<{ label: string; data: string }> = [
  { label: 'Esc', data: '\x1b' }, { label: 'Tab', data: '\t' }, { label: 'Ctrl-C', data: '\x03' }, { label: 'Ctrl-D', data: '\x04' },
  { label: '←', data: '\x1b[D' }, { label: '↑', data: '\x1b[A' }, { label: '↓', data: '\x1b[B' }, { label: '→', data: '\x1b[C' }, { label: '⏎', data: '\r' },
];

/** Used by the workbench ScreenPane and the mobile remote screen when the chosen source is a console. */
export function RemoteConsole({ targetId, streamId, keyBar = false, fontSize = 13 }: { targetId: number; streamId: number; keyBar?: boolean; fontSize?: number }) {
  const box = useRef<HTMLDivElement | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const info = useRef<StreamInfo | null>(null);
  const [status, setStatus] = useState<string>('연결 중…');
  const [interactive, setInteractive] = useState(false);

  const write = (data: string) => {
    const st = info.current;
    if (st?.pty && st.running && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ op: 'write', streamId, data }));
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    let disposed = false;
    let term: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    info.current = null;
    void (async () => {
      const [{ Terminal: Term }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]);
      if (disposed) return;
      const t = new Term({ fontSize, fontFamily: 'Menlo, Monaco, "Courier New", monospace', scrollback: 10000, convertEol: true, cursorBlink: true, theme: { background: '#1e1e1e', foreground: '#d4d4d4' } });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      term = t;
      const sendSize = () => {
        const st = info.current;
        if (st?.pty && st.running && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ op: 'resize', streamId, cols: t.cols, rows: t.rows }));
      };
      t.onData((data) => write(data));
      observer = new ResizeObserver(() => { try { fit.fit(); } catch { return; } sendSize(); });
      observer.observe(el);

      const connect = () => {
        const ws = new WebSocket(api.targets.streamUrl(targetId));
        ws.binaryType = 'arraybuffer';
        socket.current = ws;
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            if (event.data.byteLength >= 4 && new DataView(event.data).getUint32(0) === streamId) t.write(new Uint8Array(event.data, 4));
            return;
          }
          const msg = JSON.parse(String(event.data)) as { type: string; streams?: StreamInfo[]; stream?: StreamInfo; message?: string };
          if (msg.type === 'hello') {
            const st = msg.streams?.find((s) => s.streamId === streamId) ?? null;
            if (!st) { setStatus('이 명령은 더 이상 실행 중이 아닙니다'); return; }
            info.current = st;
            t.reset();
            t.options.convertEol = !st.pty;   // a pty sends its own \r\n
            setInteractive(st.pty && st.running);
            setStatus(st.running ? (st.pty ? '실행 중 · 키보드 입력 가능' : '실행 중 · 출력만') : '종료됨');
            ws.send(JSON.stringify({ op: 'attach', streamId }));   // the gateway replays the last 256 KB first
            sendSize();
          } else if (msg.type === 'exit' && msg.stream?.streamId === streamId) {
            info.current = msg.stream;
            setInteractive(false);
            setStatus(msg.stream.signal ? `중단 (${msg.stream.signal})` : `종료 (${msg.stream.code ?? '?'})`);
            t.write('\r\n\x1b[2m── 종료 ──\x1b[0m\r\n');
          } else if (msg.type === 'offline') {
            setStatus('원격 PC가 오프라인입니다');
          } else if (msg.type === 'error') {
            setStatus(msg.message ?? '오류');
          }
        };
        ws.onclose = () => { if (!disposed) retry = setTimeout(connect, 2000); };
      };
      connect();
      if (!window.matchMedia?.('(pointer: coarse)').matches) t.focus();
    })();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      observer?.disconnect();
      socket.current?.close();
      socket.current = null;
      term?.dispose();
    };
    // write() reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, streamId, fontSize]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[#1e1e1e]">
      <div className="shrink-0 px-2 py-1 text-[11px] text-neutral-400">{status}</div>
      <div ref={box} className="min-h-0 flex-1 px-1" />
      {keyBar && interactive ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-neutral-700 px-2 pb-[calc(env(safe-area-inset-bottom)+8px)] pt-2 text-[13px] text-neutral-100">
          {KEYS.map((k) => <button key={k.label} type="button" onClick={() => write(k.data)} className="rounded-lg border border-neutral-600 px-2.5 py-1.5">{k.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}
