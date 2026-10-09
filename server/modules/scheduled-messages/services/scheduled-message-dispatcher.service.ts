import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;
let stopListeningForSettledRuns: (() => void) | null = null;

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

/**
 * The stored column as a queue, oldest first. Today's composer writes an array;
 * a row written before the queue held more than one turn is a single object.
 * Turns with nothing to send are dropped.
 */
function readQueuedMessages(value: unknown): unknown[] {
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item) => readQueuedMessage(item) !== null);
}

/**
 * Takes the head of a session's queue and runs it. Resolves when that turn
 * settles; the turns behind it go out one per settle through the registry's
 * run-settled hook (or the poll, whichever comes first).
 */
async function sendQueueHead(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  const queue = readQueuedMessages(candidate.queuedMessage);
  const message = readQueuedMessage(queue[0]);
  const remaining = queue.length > 1 ? queue.slice(1) : null;

  if (!sessionDraftsDb.claimQueuedMessage(candidate, remaining)) {
    return false;
  }
  if (!message) {
    // Nothing sendable was stored: the claim already cleared the column.
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return false;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next pass tries again.
  if (!result.started && result.error === 'A run was already in progress for this session.') {
    sessionDraftsDb.restoreQueuedMessage(candidate, remaining);
    return false;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
  return true;
}

/**
 * Sends the next queued turn of every idle session — or of one session when
 * `sessionId` is given (the run-settled hook). Returns how many were sent.
 */
export async function dispatchQueuedMessages(
  runtime: ProviderRuntimeGateway,
  sessionId?: string,
): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages()
    .filter((candidate) => sessionId === undefined || candidate.sessionId === sessionId);
  let sent = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if (chatRunRegistry.isProcessing(candidate.sessionId)) {
      return;
    }
    if (await sendQueueHead(candidate, runtime)) {
      sent += 1;
    }
  }));

  return sent;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // A queued turn follows the one before it at once, not on the next poll.
  // Not gated by dispatchInFlight: the claim is atomic, and the poll may be
  // sitting on a run that lasts minutes.
  stopListeningForSettledRuns = chatRunRegistry.onRunSettled((sessionId) => {
    void dispatchQueuedMessages(runtime, sessionId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScheduledMessages] Queued dispatch after run settled failed', { sessionId, error: message });
    });
  });

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  stopListeningForSettledRuns?.();
  stopListeningForSettledRuns = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
