import { getConnection } from '@/modules/database/connection.js';

/**
 * One chat scope's unsent state: the text still in the composer, plus the
 * message queued behind an in-flight turn. Both are optional — a scope can
 * hold only a draft, only a queued message, or both.
 */
export type SessionDraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  updatedAt: string;
};

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  updated_at: string;
};

/**
 * A server-owned queue of turns for one session together with the exact stored
 * value used to claim its head once. `queuedMessage` is the parsed column: an
 * array of turns, or a single turn written by an older client.
 */
export type QueuedSessionMessageRecord = {
  userId: number;
  sessionId: string;
  queuedMessage: unknown;
  claimToken: string;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
};

/**
 * Ids of the queued turns the server has already taken off the head of each
 * queue, keyed by user and scope. A client saves its whole queue (with every
 * keystroke of the draft, and with every queue edit) from the copy it last
 * loaded, which can still hold a head the server sent since; dropping these
 * ids on save keeps a sent turn from being queued — and sent — again. Held in
 * memory: the window it covers is the few seconds before the client reloads.
 */
const sentQueuedTurnIds = new Map<string, Set<string>>();
const SENT_IDS_KEPT_PER_SCOPE = 50;

const sentIdsKey = (userId: number, scope: string) => `${userId}\u0000${scope}`;

const queuedTurnId = (turn: unknown): string | null => {
  const id = (turn as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : null;
};

function rememberSentTurn(userId: number, scope: string, turn: unknown): void {
  const id = queuedTurnId(turn);
  if (!id) {
    return;
  }
  const key = sentIdsKey(userId, scope);
  const ids = sentQueuedTurnIds.get(key) ?? new Set<string>();
  ids.add(id);
  // Sets keep insertion order: the oldest ids go first.
  for (const oldest of ids) {
    if (ids.size <= SENT_IDS_KEPT_PER_SCOPE) break;
    ids.delete(oldest);
  }
  sentQueuedTurnIds.set(key, ids);
}

function forgetSentTurn(userId: number, scope: string, turn: unknown): void {
  const id = queuedTurnId(turn);
  if (id) {
    sentQueuedTurnIds.get(sentIdsKey(userId, scope))?.delete(id);
  }
}

/** The client's queue without the turns already sent from it; null when none are left. */
function withoutSentTurns(userId: number, scope: string, queuedMessage: unknown | null): unknown | null {
  const ids = sentQueuedTurnIds.get(sentIdsKey(userId, scope));
  if (queuedMessage === null || !ids?.size) {
    return queuedMessage;
  }
  const turns = Array.isArray(queuedMessage) ? queuedMessage : [queuedMessage];
  const waiting = turns.filter((turn) => !ids.has(queuedTurnId(turn) ?? ''));
  if (waiting.length === turns.length) {
    return queuedMessage;
  }
  return waiting.length > 0 ? waiting : null;
}

/** The turn at the head of a stored queue (an array, or an older client's single turn). */
const queueHead = (queuedMessage: unknown): unknown => (Array.isArray(queuedMessage) ? queuedMessage[0] : queuedMessage);

/** A queued message that no longer parses is treated as absent, not fatal. */
function parseQueuedMessage(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessage: parseQueuedMessage(row.queued_message),
    updatedAt: row.updated_at,
  };
}

export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, updated_at
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /** Lists persisted queued turns whose scopes are real chat sessions. */
  listQueuedMessages(): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL`
      )
      .all() as QueuedMessageRow[];

    return rows.map((row) => ({
      userId: row.user_id,
      sessionId: row.draft_scope,
      queuedMessage: parseQueuedMessage(row.queued_message),
      claimToken: row.queued_message,
    }));
  },

  /**
   * Atomically takes the head of a session's queue, only if the queue has not
   * been edited since listing: the column becomes `remaining` (the turns still
   * waiting, or NULL when the head was the last one).
   */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord, remaining: unknown[] | null): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      )
      .run(
        remaining && remaining.length > 0 ? JSON.stringify(remaining) : null,
        candidate.userId,
        candidate.sessionId,
        candidate.claimToken,
      );
    if (result.changes === 0) {
      return false;
    }
    rememberSentTurn(candidate.userId, candidate.sessionId, queueHead(candidate.queuedMessage));
    return true;
  },

  /**
   * Restores a claim lost to the narrow race where another run starts first.
   * `remaining` must be what the claim left in the column, so a queue the user
   * changed meanwhile is never overwritten.
   */
  restoreQueuedMessage(candidate: QueuedSessionMessageRecord, remaining: unknown[] | null): void {
    forgetSentTurn(candidate.userId, candidate.sessionId, queueHead(candidate.queuedMessage));
    getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message IS ?`
      )
      .run(
        candidate.claimToken,
        candidate.userId,
        candidate.sessionId,
        remaining && remaining.length > 0 ? JSON.stringify(remaining) : null,
      );
  },

  /**
   * A queued turn the user sent early (it went out as its own `chat.send`):
   * taken out of the stored queue and remembered as sent, so a copy of the
   * queue saved from before — by this tab or another device — cannot queue it
   * again. Compare-and-swap like a claim, so a queue edited meanwhile is
   * left to the next save, which drops the turn too.
   */
  takeQueuedTurn(userId: number, scope: string, turnId: string): void {
    rememberSentTurn(userId, scope, { id: turnId });
    const row = getConnection()
      .prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .get(userId, scope) as { queued_message: string | null } | undefined;
    if (!row?.queued_message) {
      return;
    }
    const current = parseQueuedMessage(row.queued_message);
    const waiting = withoutSentTurns(userId, scope, current);
    if (waiting === current) {
      return;
    }
    getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      )
      .run(waiting === null ? null : JSON.stringify(waiting), userId, scope, row.queued_message);
    this.deleteEmptyDraft(userId, scope);
  },

  /** Removes the placeholder row left after its last queued turn is claimed. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's draft, or deletes the row when nothing is left to keep.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into. Queued turns the
   * server already sent are dropped from the saved queue (see sentQueuedTurnIds).
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: { text: string; queuedMessage: unknown | null }
  ): void {
    const db = getConnection();
    const queuedMessage = withoutSentTurns(userId, scope, draft.queuedMessage);

    if (!draft.text && queuedMessage === null) {
      db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .run(userId, scope);
      return;
    }

    db.prepare(
      `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, draft_scope) DO UPDATE SET
         draft_text = excluded.draft_text,
         queued_message = excluded.queued_message,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      scope,
      draft.text,
      queuedMessage === null ? null : JSON.stringify(queuedMessage)
    );
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .run(userId, scope);
  },
};
