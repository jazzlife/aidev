import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * A command sent to the chat socket must reach the server even when the socket
 * is closed or dead without knowing it (a phone back from the background): it
 * waits for the next connection, and once written it is sent again after a
 * reconnect until a pong confirms it arrived.
 */

const AUTH = { user: { id: 1 }, token: 'token', isLoading: false };
vi.mock('@/modules/auth', () => ({ useAuth: () => AUTH }));
vi.mock('@/shared/authToken', () => ({ isAuthTokenExpired: () => false, expireAuthSession: () => undefined }));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  commands() { return this.sent.filter((frame) => frame.type !== 'ping'); }
  lastPingId() { return [...this.sent].reverse().find((frame) => frame.type === 'ping')?.id; }
}

const { WebSocketProvider, useWebSocket } = await import('@/shared/context/WebSocketContext');

let send: (message: unknown) => void = () => undefined;
function Capture() {
  const { sendMessage } = useWebSocket();
  useEffect(() => { send = sendMessage; }, [sendMessage]);
  return null;
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  render(<WebSocketProvider><Capture /></WebSocketProvider>);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a command sent before the socket opens is written when it does', () => {
  act(() => send({ type: 'chat.send', sessionId: 's1', content: 'hi' }));
  assert.equal(latest().sent.length, 0);

  act(() => latest().open());
  const [command] = latest().commands();
  assert.equal(command?.content, 'hi');
  assert.equal(typeof command?.frameId, 'string');
});

test('a socket that does not answer is replaced and the command sent again with the same frameId', () => {
  const first = latest();
  act(() => first.open());
  act(() => send({ type: 'chat.send', sessionId: 's1', content: 'hi' }));
  const frameId = first.commands()[0]?.frameId;

  act(() => { vi.advanceTimersByTime(8000); });
  assert.notEqual(latest(), first);

  act(() => latest().open());
  assert.deepEqual(latest().commands().map((frame) => frame.frameId), [frameId]);
});

test('a command a pong confirmed is not sent again after a reconnect', () => {
  const first = latest();
  act(() => first.open());
  act(() => send({ type: 'chat.send', sessionId: 's1', content: 'hi' }));
  act(() => first.receive({ kind: 'pong', id: first.lastPingId() }));

  act(() => { first.readyState = 3; first.onclose?.(); });
  act(() => { vi.advanceTimersByTime(3000); });
  act(() => latest().open());
  assert.notEqual(latest(), first);
  assert.deepEqual(latest().commands(), []);
});

test('a subscribe while disconnected is not queued (screens subscribe again on connect)', () => {
  act(() => send({ type: 'chat.subscribe', sessions: [] }));
  act(() => latest().open());
  assert.deepEqual(latest().commands(), []);
});

test('coming back to the app checks the socket and replaces a dead one', () => {
  const first = latest();
  act(() => first.open());
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(first.sent.at(-1)?.type, 'ping');

  act(() => { vi.advanceTimersByTime(8000); });
  assert.notEqual(latest(), first);
});
