import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// No ripgrep at all (the release volume installs dependencies with --ignore-scripts, so the
// @vscode/ripgrep binary is missing, and the runtime image has no `rg`): search must still work.
process.env.PATH = '/nonexistent-bin';

test('conversation search without any ripgrep binary scans transcripts in Node (match split across read chunks)', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-fallback.jsonl');
    // ~256 KB of other messages first, so "Release planning" straddles the first read chunk
    const filler = Array.from({ length: 2000 }, (_, i) => JSON.stringify({
      type: 'event_msg', timestamp: '2026-08-12T08:00:00.000Z',
      payload: { type: 'agent_message', message: `filler message number ${i} ${'x'.repeat(100)}` },
    })).join('\n');
    const lines = filler.slice(0, filler.lastIndexOf('\n', 200 * 1024));
    const prefix = `${lines}\n{"type":"event_msg","timestamp":"2026-08-12T09:00:00.000Z","payload":{"type":"user_message","kind":"plain","message":"`;
    // put "Release planning" 4 bytes before the 256 KiB read-chunk boundary (all ASCII: bytes = chars)
    const message = `${'z'.repeat(256 * 1024 - 4 - prefix.length)} Release planning also appears in this conversation.`;
    const body = `${lines}\n${JSON.stringify({ type: 'event_msg', timestamp: '2026-08-12T09:00:00.000Z', payload: { type: 'user_message', kind: 'plain', message } })}\n`;
    assert.equal(body.indexOf('Release planning'), 256 * 1024 - 3);
    await writeFile(transcriptPath, body);
    sessionsDb.createSession('fallback-session', 'codex', workspacePath, 'Unrelated session', undefined, undefined, transcriptPath);

    const response = await fetch(`${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`);
    const eventStream = await response.text();

    assert.equal(response.status, 200);
    assert.equal(eventStream.indexOf('event: error'), -1, eventStream.slice(0, 300));
    assert.ok(eventStream.indexOf('event: result') >= 0, 'transcript match reported');
    assert.ok(eventStream.includes('fallback-session'));
    assert.ok(eventStream.indexOf('event: done') > eventStream.indexOf('event: result'));

    const miss = await (await fetch(`${baseUrl}/api/providers/search/sessions?q=zebra%20quantum&limit=50`)).text();
    assert.equal(miss.indexOf('event: error'), -1);
    assert.equal(miss.indexOf('event: result'), -1);
  });
});
