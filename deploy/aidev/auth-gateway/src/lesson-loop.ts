import type { openStore } from './store.js';

/**
 * Lesson verification loop (IMPLEMENTATION-PLAN §3.8, E-02). Called once when a routed run first
 * reaches success or fail, with the lessons its command carried (store.injectedLessons):
 *   success → every carried lesson +1 hit; a candidate on trial becomes verified ('auto');
 *             a verified rule with PROMOTE_HITS successes is promoted.
 *   fail    → every carried lesson +1 fail; a trial candidate failing TRIAL_FAILS times is rejected;
 *             a verified rule failing more often than it helps goes back to candidate.
 * Promotion merges the rule into the agent's prompt as a new version when the agent and the lesson
 * belong to the same owner; otherwise (a private lesson on a global agent) it is pinned: always
 * carried for that user, outside the top-k selection.
 */
type Store = ReturnType<typeof openStore>;

export const PROMOTE_HITS = 3;
const TRIAL_FAILS = 2;
const DEMOTE_FAILS = 3;
const SECTION = '## 검증된 규칙 (실행 결과로 자동 승격)';

export function applyLessonOutcome(store: Store, decisionId: number, outcome: 'success' | 'fail'): string[] {
  const log: string[] = [];
  for (const lesson of store.injectedLessons(decisionId)) {
    if (lesson.status === 'rejected') continue;
    if (outcome === 'success') {
      const hits = lesson.hits + 1;
      if (lesson.status === 'candidate' && lesson.trial) {
        store.updateLesson(lesson.id, { hits, status: 'verified', verifiedBy: 'auto' });
        log.push(`lesson ${lesson.id} verified by a successful trial run`);
      } else {
        store.updateLesson(lesson.id, { hits });
      }
      const current = store.lessonById(lesson.id)!;
      if (current.status === 'verified' && !current.promoted_to_prompt && current.hits >= PROMOTE_HITS) log.push(promote(store, current.id));
    } else {
      const fails = lesson.fails + 1;
      if (lesson.status === 'candidate' && lesson.trial && fails >= TRIAL_FAILS) {
        store.updateLesson(lesson.id, { fails, status: 'rejected' });
        log.push(`lesson ${lesson.id} rejected after ${fails} failed trial runs`);
      } else if (lesson.status === 'verified' && !lesson.promoted_version && fails >= DEMOTE_FAILS && fails > lesson.hits) {
        store.updateLesson(lesson.id, { fails, status: 'candidate', promotedToPrompt: 0 });
        log.push(`lesson ${lesson.id} back to candidate (${lesson.hits} successes / ${fails} failures)`);
      } else {
        store.updateLesson(lesson.id, { fails });
      }
    }
  }
  return log;
}

/** Merges a lesson into its agent (new version) or pins it for its owner. */
export function promote(store: Store, lessonId: number): string {
  const lesson = store.lessonById(lessonId);
  if (!lesson) throw new Error('Lesson not found');
  const agent = store.agentById(lesson.agent_id);
  if (!agent) throw new Error('Agent not found');
  if (agent.owner_id === lesson.owner_id) {
    const bullet = `- ${lesson.trigger} → ${lesson.rule}`;
    const prompt = agent.prompt.includes(SECTION) ? `${agent.prompt.trimEnd()}\n${bullet}` : `${agent.prompt.trimEnd()}\n\n${SECTION}\n${bullet}`;
    if (prompt.length <= 20000) {
      const version = store.newAgentVersion(agent.id, { prompt }, `교훈 #${lesson.id} 승격 (${lesson.hits}회 성공): ${lesson.trigger.slice(0, 120)}`);
      store.updateLesson(lesson.id, { promotedToPrompt: 1, promotedVersion: version });
      return `lesson ${lesson.id} merged into ${agent.name} v${version}`;
    }
  }
  store.updateLesson(lesson.id, { promotedToPrompt: 1 });
  return `lesson ${lesson.id} pinned for ${agent.name} (${agent.owner_id === lesson.owner_id ? 'prompt full' : 'agent owned by someone else'})`;
}
