import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'interrupt-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/**
 * A gateway whose provider runs stay in flight until the test ends and whose
 * aborts settle only when the test says so — a provider that takes its time to
 * stop (Codex and OpenCode wait up to 10s for the turn to settle).
 */
async function withSlowAbortGateway(
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    commands: string[];
    pendingAborts: Array<() => void>;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-interrupt-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const commands: string[] = [];
  const pendingAborts: Array<() => void> = [];
  const heldRuns: Array<() => void> = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'codex', tempDirectory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, command: string) => {
          commands.push(command);
          await new Promise<void>((resolve) => { heldRuns.push(resolve); });
        },
        abort: () => new Promise<boolean>((resolve) => { pendingAborts.push(() => resolve(true)); }),
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      },
    });
    await runTest({ socket, commands, pendingAborts });
  } finally {
    for (const release of heldRuns) {
      release();
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

function send(socket: ReturnType<typeof createFakeSocket>, content: string, interrupt = false): void {
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId: SESSION_ID,
    content,
    ...(interrupt ? { interrupt: true } : {}),
  }));
}

test('a cut-in that lands while an earlier cut-in is still stopping the turn runs too, instead of being refused', async () => {
  await withSlowAbortGateway(async ({ socket, commands, pendingAborts }) => {
    send(socket, 'the running turn');
    await settle();

    send(socket, 'first cut-in', true);
    await settle();
    send(socket, 'second cut-in', true);
    await settle();
    // Both are waiting on the provider to stop the running turn.
    assert.equal(pendingAborts.length, 2);

    pendingAborts[0]();
    await settle();
    assert.deepEqual(commands, ['the running turn', 'first cut-in']);

    // The second cut-in finds the first one's run in the way and stops that as well.
    pendingAborts[1]();
    await settle();
    assert.equal(pendingAborts.length, 3);
    pendingAborts[2]();
    await settle();

    assert.deepEqual(commands, ['the running turn', 'first cut-in', 'second cut-in']);
    assert.deepEqual(socket.frames.filter((frame) => frame.kind === 'protocol_error'), []);
    // Every run that was cut ended as superseded, so no client flashed idle between them.
    const completes = socket.frames.filter((frame) => frame.kind === 'complete');
    assert.deepEqual(completes.map((frame) => frame.superseded), [true, true]);
    assert.equal(socket.frames.filter((frame) => frame.kind === 'run_started').length, 3);
  });
});

test('a plain send into a busy session is still refused, so the composer queues it', async () => {
  await withSlowAbortGateway(async ({ socket, commands }) => {
    send(socket, 'the running turn');
    await settle();
    send(socket, 'not a cut-in');
    await settle();

    assert.deepEqual(commands, ['the running turn']);
    assert.equal(socket.frames.at(-1)?.code, 'RUN_IN_PROGRESS');
  });
});
