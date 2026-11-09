import { useCallback, useEffect, useRef } from 'react';

import { aidevApi } from '@/modules/aidev-router/api';
import { useAidevRouting, type AidevSendDecoration } from '@/modules/aidev-router/hooks/useAidevRouting';
import { heldQueuedTurns, hydrateChatDrafts, readQueuedMessages, writeQueuedMessages, type StoredQueuedMessage } from '@/shared/chatDrafts';
import type { QueuedTurnHold } from '@/shared/types';

/**
 * Held commands (2026-11-09, user decision): a command that needs a specialist the catalog lacks waits in its chat's
 * queue (`hold`) while the gateway designs that specialist, and then runs on it. The server's queue dispatch skips a
 * held turn (the turns behind it still go). The app releases it: routed to the new agent once the design is
 * `created`, to the generalist when it ended without one or takes longer than HOLD_MAX_MS. "범용 에이전트로 즉시 실행"
 * runs it at once on the generalist; the new specialist then takes over from the chat's next command, not that one.
 */
const HOLD_POLL_MS = 8_000;
/** A design normally takes 3–5 minutes (server 2026-11); past this the command goes to the generalist. */
export const HOLD_MAX_MS = 10 * 60_000;
/** The agent a released command runs on when its specialist did not come. */
export const GENERALIST = 'generalist';

/**
 * Used by the workbench composer and the mobile chat: the specialist a routed send should wait for — the gateway is
 * designing it for this command — or null to send now. Never for the app's own re-sends (a released hold, a retry).
 */
export function designHoldFor(decoration: AidevSendDecoration | null): string | null {
  const create = decoration?.route.create;
  return create?.design && create.proposal && !decoration?.appResend ? create.proposal.name : null;
}

/** Used by both apps' queue cards: the label a held turn shows while its specialist is designed. */
export function holdLabel(hold: QueuedTurnHold): string {
  return `전문 agent ${hold.design} 설계 중 — 끝나면 이 명령을 ${hold.design}이(가) 실행합니다`;
}

type HeldTurn = StoredQueuedMessage & { id: string; hold: QueuedTurnHold };

/**
 * Used by the workbench chat and the mobile app: `release` routes one held turn to `agent` and puts it back in its
 * queue as an ordinary turn carrying that routing, for the server to send when the chat is free. With `watch`, also
 * the one page-wide watcher that releases every held turn whose design ended (any chat, not just the open one).
 */
export function useDesignHolds({ watch = false }: { watch?: boolean } = {}) {
  const { beforeSend } = useAidevRouting();
  // turns being released by this page: a slow route must not release the same turn twice
  const releasingRef = useRef(new Set<string>());

  const release = useCallback(async (scope: string, turn: HeldTurn, agent: string) => {
    if (releasingRef.current.has(turn.id)) return;
    releasingRef.current.add(turn.id);
    try {
      const decoration = await beforeSend(turn.content || '(첨부)', {
        sessionId: scope, provider: turn.hold.provider, isNewSession: false, projectHint: turn.hold.projectHint ?? null,
        projectPath: turn.hold.projectPath ?? null, userPinnedModel: false, forceAgent: agent,
      });
      // read again after routing: the turn may have been sent, edited or dropped meanwhile
      const queue = readQueuedMessages(scope);
      const index = queue.findIndex((candidate) => candidate.id === turn.id && candidate.hold);
      if (index < 0) return;
      const { hold: _released, ...rest } = queue[index];
      const routed = decoration
        ? { aidev: decoration.aidev, ...(decoration.model ? { model: decoration.model } : {}), ...(decoration.effort ? { effort: decoration.effort } : {}) }
        : {};
      writeQueuedMessages(scope, queue.map((candidate, position) => (position === index ? { ...rest, options: { ...(rest.options ?? {}), ...routed } } : candidate)));
    } finally {
      releasingRef.current.delete(turn.id);
    }
  }, [beforeSend]);

  const releaseRef = useRef(release);
  useEffect(() => { releaseRef.current = release; });
  useEffect(() => {
    if (!watch || !claimWatcher()) return undefined;
    let stopped = false;
    const tick = async () => {
      if (!heldQueuedTurns().length) return;
      // the queues as the server has them now: a held turn may have been run or dropped on another device
      await hydrateChatDrafts().catch(() => undefined);
      const held = heldQueuedTurns();
      const byDesign = new Map<string, Array<{ scope: string; turn: HeldTurn }>>();
      for (const entry of held) byDesign.set(entry.turn.hold.design, [...(byDesign.get(entry.turn.hold.design) ?? []), entry]);
      for (const [design, entries] of byDesign) {
        const status = await aidevApi.designStatus(design).catch(() => null);
        if (stopped || !status) continue;
        for (const { scope, turn } of entries) {
          const late = Date.now() - turn.hold.since > HOLD_MAX_MS;
          if (status.status === 'created' && status.agent) { void releaseRef.current(scope, turn, status.agent); continue; }
          if (status.status === 'designing' && !late) continue;
          // ended without a specialist (or the gateway lost track, or it takes too long): the generalist runs it now
          void releaseRef.current(scope, turn, GENERALIST);
          if (status.status !== 'failed') {
            const why = status.status === 'designing' ? '설계가 10분 안에 끝나지 않아' : status.status === 'none' ? '설계자가 새 agent가 필요 없다고 판단해' : '설계 상태를 확인할 수 없어';
            void aidevApi.notifyEvent({ code: 'agent.design_failed', session_id: scope, session_name: '전문 agent 생성', detail: `${why} 보류했던 명령을 범용 에이전트로 실행합니다 (${design})` }).catch(() => undefined);
          }
        }
      }
    };
    const timer = window.setInterval(() => { void tick(); }, HOLD_POLL_MS);
    // held turns from before a reload or from another device are in the server's copy
    void hydrateChatDrafts().catch(() => undefined).then(tick);
    return () => { stopped = true; window.clearInterval(timer); releaseWatcher(); };
  }, [watch]);

  return { release };
}

// One watcher per page (each app mounts it once at its root; this guards a second mount): two would route a turn twice.
let watching = false;
function claimWatcher(): boolean {
  if (watching) return false;
  watching = true;
  return true;
}
function releaseWatcher() {
  watching = false;
}

/** Mounted once at each app's root (workbench App, mobile Gate): releases held commands whose design ended. */
export function DesignHoldWatcher() {
  useDesignHolds({ watch: true });
  return null;
}
