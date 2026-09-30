import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

/**
 * Debug Adapter Protocol client over one byte stream (F-09): `Content-Length` framing, requests with
 * their responses, events, and the adapter's reverse requests (`startDebugging`, `runInTerminal`).
 * The stream is a runner tunnel to a DAP server on the user's PC (runner `dap.start`), or any Duplex in
 * tests. Used by debug-hub.ts.
 *   emits 'event' (DapMessage), 'reverse' (DapMessage, reply(success, body?, message?)), 'close' (reason)
 */
export type DapMessage = { seq: number; type: 'request' | 'response' | 'event'; command?: string; event?: string; request_seq?: number; success?: boolean; message?: string; body?: Record<string, unknown>; arguments?: Record<string, unknown> };

export class DapError extends Error {
  constructor(public command: string, message: string, public body?: Record<string, unknown>) { super(message); }
}

const MAX_MESSAGE = 16 * 1024 * 1024;

export class DapConnection extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private seq = 1;
  private pending = new Map<number, { command: string; resolve: (body: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  closed: string | null = null;

  constructor(private stream: Duplex, public readonly name: string) {
    super();
    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.on('close', () => this.shut('connection closed'));
    stream.on('end', () => this.shut('connection ended'));
    stream.on('error', (error: Error) => this.shut(error.message));
  }

  private shut(reason: string) {
    if (this.closed) return;
    this.closed = reason;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new DapError(p.command, `debug adapter ${this.name}: ${reason}`)); }
    this.pending.clear();
    this.emit('close', reason);
  }

  private onData(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) { if (this.buf.length > 8192) this.fail('bad header'); return; }
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, head).toString('latin1'));
      if (!m) return this.fail('missing Content-Length');
      const len = Number(m[1]);
      if (len > MAX_MESSAGE) return this.fail('message too large');
      if (this.buf.length < head + 4 + len) return;
      const body = this.buf.subarray(head + 4, head + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(head + 4 + len);
      let msg: DapMessage;
      try { msg = JSON.parse(body) as DapMessage; } catch { continue; }
      this.dispatch(msg);
    }
  }

  private fail(reason: string) { this.stream.destroy(); this.shut(`protocol error: ${reason}`); }

  private dispatch(msg: DapMessage) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq ?? -1);
      if (!p) return;
      this.pending.delete(msg.request_seq!); clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.body ?? {});
      else p.reject(new DapError(p.command, dapErrorText(msg), msg.body));
    } else if (msg.type === 'event') {
      this.emit('event', msg);
    } else if (msg.type === 'request') {
      const reply = (success: boolean, body?: Record<string, unknown>, message?: string) => this.send({ type: 'response', request_seq: msg.seq, command: msg.command, success, body, message });
      if (!this.emit('reverse', msg, reply)) reply(false, undefined, `${msg.command} is not supported`);
    }
  }

  private send(msg: Omit<DapMessage, 'seq'>) {
    if (this.closed) return;
    const text = JSON.stringify({ seq: this.seq++, ...msg });
    this.stream.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  }

  /** A request; resolves with the response body, rejects with DapError (success:false, closed, timeout). */
  request<T extends Record<string, unknown> = Record<string, unknown>>(command: string, args?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new DapError(command, `debug adapter ${this.name}: ${this.closed}`));
    const seq = this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new DapError(command, `${command}: no answer in ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(seq, { command, resolve: resolve as (b: Record<string, unknown>) => void, reject, timer });
      this.send({ type: 'request', command, arguments: args });
    });
  }

  close() { this.stream.destroy(); this.shut('closed by the platform'); }
}

/** The adapter's own words for a failed request (`body.error.format` with its variables, or `message`). */
export function dapErrorText(msg: { message?: string; body?: Record<string, unknown> }) {
  const err = msg.body?.error as { format?: string; variables?: Record<string, string> } | undefined;
  if (err?.format) return err.format.replace(/\{(\w+)\}/g, (_, k: string) => err.variables?.[k] ?? `{${k}}`);
  return msg.message || 'request failed';
}
