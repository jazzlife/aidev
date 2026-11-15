import type Database from 'better-sqlite3';

import type { AiAnalyzeFailure } from '@/shared/types.js';

/**
 * Where an analysis lives between its request and its result, keyed by the caller's `requestId` (contract §3.1).
 *
 * The table is created here, on first use, and nowhere else: it is not part of the runtime's schema or migrations,
 * so a problem with it can only fail an analysis — never the runtime's startup or another module's tables.
 * Rows are this runtime's alone (one runtime = one account), so a `requestId` is scoped to the account.
 * The input file is never stored: only the request's fingerprint and the answer.
 */
const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ai_analyze_requests (
    request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
    result TEXT,
    failure TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ai_analyze_requests_created ON ai_analyze_requests(created_at);
`;

type Row = {
  request_id: string;
  job_id: string;
  fingerprint: string;
  status: 'running' | 'done' | 'error';
  result: string | null;
  failure: string | null;
  created_at: number;
  finished_at: number | null;
};

/** One stored analysis as the service reads it. */
type StoredAnalysis = {
  requestId: string;
  jobId: string;
  fingerprint: string;
  status: Row['status'];
  result: Record<string, unknown> | null;
  failure: AiAnalyzeFailure | null;
  createdAt: number;
};

const parse = <T>(text: string | null): T | null => {
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
};
const toStored = (row: Row | undefined): StoredAnalysis | null => (row ? {
  requestId: row.request_id,
  jobId: row.job_id,
  fingerprint: row.fingerprint,
  status: row.status,
  result: parse<Record<string, unknown>>(row.result),
  failure: parse<AiAnalyzeFailure>(row.failure),
  createdAt: row.created_at,
} : null);

/**
 * The analysis store over a SQLite connection (the runtime's own in production, an in-memory one in tests).
 * Used by the ai-analyze module's composition root and its service.
 */
export function createAnalysisResultsStore(getDb: () => Database.Database) {
  let ready: Database.Database | null = null;
  const db = () => {
    const connection = getDb();
    if (ready !== connection) { connection.exec(TABLE_SQL); ready = connection; }
    return connection;
  };
  return {
    byRequestId(requestId: string): StoredAnalysis | null {
      return toStored(db().prepare('SELECT * FROM ai_analyze_requests WHERE request_id = ?').get(requestId) as Row | undefined);
    },
    byJobId(jobId: string): StoredAnalysis | null {
      return toStored(db().prepare('SELECT * FROM ai_analyze_requests WHERE job_id = ?').get(jobId) as Row | undefined);
    },
    /** A new analysis, running. The caller removed any earlier row of the same requestId first. */
    insertRunning(input: { requestId: string; jobId: string; fingerprint: string; createdAt: number }): void {
      db().prepare("INSERT INTO ai_analyze_requests (request_id, job_id, fingerprint, status, created_at) VALUES (?, ?, ?, 'running', ?)")
        .run(input.requestId, input.jobId, input.fingerprint, input.createdAt);
    },
    finish(jobId: string, result: Record<string, unknown>, finishedAt: number): void {
      db().prepare("UPDATE ai_analyze_requests SET status = 'done', result = ?, finished_at = ? WHERE job_id = ?").run(JSON.stringify(result), finishedAt, jobId);
    },
    fail(jobId: string, failure: AiAnalyzeFailure, finishedAt: number): void {
      db().prepare("UPDATE ai_analyze_requests SET status = 'error', failure = ?, finished_at = ? WHERE job_id = ?").run(JSON.stringify(failure), finishedAt, jobId);
    },
    remove(requestId: string): void {
      db().prepare('DELETE FROM ai_analyze_requests WHERE request_id = ?').run(requestId);
    },
    /** Drops every analysis created before `before` (epoch ms). */
    purge(before: number): void {
      db().prepare('DELETE FROM ai_analyze_requests WHERE created_at < ?').run(before);
    },
  };
}
