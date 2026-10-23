import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * The client confirms delivery with its own ping (browsers cannot see a dead
 * socket) and sends a command again after a reconnect when it could not; the
 * gateway answers the ping at once and drops the second copy of a frame.
 */

function connect() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: { hasRuntime: () => true } as never });
  return socket;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });

test('a ping is answered with a pong carrying its id', async () => {
  const socket = connect();
  socket.emit('message', JSON.stringify({ type: 'ping', id: 7 }));
  await settle();
  assert.deepEqual(socket.frames, [{ kind: 'pong', id: 7 }]);
  connectedClients.clear();
});

test('a frame sent again with the same frameId is handled once, even on a new connection', async () => {
  const first = connect();
  first.emit('message', JSON.stringify({ type: 'test.unknown', frameId: 'f-1' }));
  await settle();
  assert.equal(first.frames.length, 1);
  assert.equal(first.frames[0]?.code, 'UNKNOWN_MESSAGE_TYPE');

  const second = connect();
  second.emit('message', JSON.stringify({ type: 'test.unknown', frameId: 'f-1' }));
  second.emit('message', JSON.stringify({ type: 'test.unknown', frameId: 'f-2' }));
  await settle();
  assert.equal(second.frames.length, 1);
  connectedClients.clear();
});
