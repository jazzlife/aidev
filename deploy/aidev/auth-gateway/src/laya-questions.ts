import { budgetState, topChoice, type LayaClient, type PredictResult, type Question } from './laya.js';

/**
 * Decision-point registry (IMPLEMENTATION-PLAN §3.10). Every place in the platform that needs to
 * discriminate or choose goes through `decide(kind, input)`; each kind declares its questions,
 * its confidence threshold and a deterministic fallback so nothing blocks when Laya is unavailable.
 * `route` (the composite send-time decision) lives in routing.ts and reuses these builders.
 */
export type DecideInput = { state: Record<string, unknown>; options?: Record<string, string>; threshold?: number };
export type DecideResult = { kind: string; answer: unknown; confidence: number; probabilities?: Record<string, number> | Record<string, Record<string, number>>; fallback: boolean; reason?: string; latency_ms: number | null; device?: string | null; raw?: Record<string, unknown> };

type KindSpec = {
  description: string;
  /** Options come from the caller (choice kinds) or are fixed. */
  choices?: string[] | 'caller';
  threshold: number;
  questions: (input: DecideInput) => Record<string, Question>;
  interpret: (result: PredictResult, input: DecideInput, spec: KindSpec) => { answer: unknown; confidence: number; probabilities?: DecideResult['probabilities'] };
  fallback: (input: DecideInput) => { answer: unknown; reason: string };
  stateBudget?: number;
};

const choiceQ = (instructions: string, criteria: Record<string, string>): Question => ({ type: 'choice', instructions, criteria });
const scoreQ = (instructions: string, criteria: string[]): Question => ({ type: 'score', instructions, criteria });
const noulQ = (instructions: string): Question => ({ type: 'noul', instructions });

const singleChoice: KindSpec['interpret'] = (r) => { const t = topChoice(r.answers.q); return { answer: t.choice, confidence: t.confidence, probabilities: r.answers.q?.probabilities }; };
const singleNoul: KindSpec['interpret'] = (r) => { const p = r.answers.q?.noul ?? 0; return { answer: p, confidence: Math.abs(p - 0.5) * 2 }; };
const singleScore: KindSpec['interpret'] = (r) => { const s = r.answers.q?.score ?? 0; return { answer: s, confidence: r.answers.q?.confidence ?? 0.5, probabilities: r.answers.q?.probabilities }; };
const callerChoices = (input: DecideInput) => {
  const options = input.options ?? {};
  if (Object.keys(options).length < 2) throw new Error('options {id: description} with at least 2 entries required');
  if (Object.keys(options).length > 20) throw new Error('at most 20 options (use shortlist first)');
  return options;
};

export const DEPTH_LEVELS = ['instant answer, lookup or a one-line change', 'local change inside one file', 'a feature touching several files', 'debugging an unknown cause, refactoring or design work', 'architecture, migration or long-running multi-step work'];
export const RISK_LEVELS = ['read-only or trivial', 'modifies files or configuration', 'destructive or hard to undo'];
export const TASK_KIND_CRITERIA: Record<string, string> = {
  bulk_read: 'reading, scanning, summarizing or analyzing a large amount of data, files, logs or documents',
  implement: 'writing new code or features',
  debug: 'finding and fixing a bug or failure',
  refactor: 'restructuring existing code without changing behavior',
  design: 'architecture, planning, API or schema design',
  ops: 'deployment, infrastructure, servers, containers, CI, environment setup',
  explain: 'explaining, answering a question, documentation',
};
export const REMOTE_ACTIONS: Record<string, string> = {
  none: 'nothing needs to run on a remote machine',
  run: 'start or run the application on the target machine',
  test: 'run the test suite or a test command on the target machine',
  debug: 'attach a debugger, set breakpoints or step through code on the target machine',
  build: 'build, compile or package on the target machine',
  screenshot: 'look at the running application screen on the target machine',
};

export const KINDS: Record<string, KindSpec> = {
  clarify: {
    description: 'Is information missing so that one question should be asked before executing?', threshold: 0.7,
    questions: () => ({ q: noulQ('Is essential information missing from this command (which file, which project, which target, expected behavior), so that the assistant should ask one clarifying question before starting?') }),
    interpret: singleNoul, fallback: () => ({ answer: 0, reason: 'proceed without asking' }),
  },
  'remote.action': {
    description: 'What must happen on the remote target machine?', threshold: 0.6, choices: Object.keys(REMOTE_ACTIONS),
    questions: () => ({ q: choiceQ('Does this developer command require running something on the user\'s remote machine, and what?', REMOTE_ACTIONS) }),
    interpret: singleChoice, fallback: () => ({ answer: 'none', reason: 'agent decides via tools' }),
  },
  'target.select': {
    description: 'Which registered remote machine should run this?', threshold: 0.6, choices: 'caller',
    questions: (input) => ({ q: choiceQ('Which of the user\'s registered machines is the right place to run this command? Consider platform, installed tools and tags.', callerChoices(input)) }),
    interpret: singleChoice, fallback: (input) => ({ answer: Object.keys(input.options ?? {})[0] ?? null, reason: 'default target' }),
  },
  'remote.approve': {
    description: 'Risk of a command about to run on the user\'s machine (0 safe … 2 destructive).', threshold: 1.5,
    questions: () => ({ q: scoreQ('How risky is executing this shell command on the user\'s own computer?', ['safe: builds, tests, reads, starts a dev server', 'modifies project files or configuration', 'destructive: deletes data, installs system software, changes system settings, touches files outside the project']) }),
    interpret: singleScore, fallback: () => ({ answer: 2, reason: 'require approval' }),
  },
  'inject.select': {
    description: 'Which lessons/knowledge items are relevant to this command?', threshold: 0, choices: 'caller',
    questions: (input) => ({ q: choiceQ('Which of these notes is most relevant to the command?', callerChoices(input)) }),
    interpret: (r, input) => {
      const probs = r.answers.q?.probabilities ?? {};
      const k = Number(input.state.k ?? 3);
      const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
      return { answer: ranked, confidence: topChoice(r.answers.q).confidence, probabilities: probs };
    },
    fallback: (input) => ({ answer: Object.keys(input.options ?? {}).slice(0, Number(input.state.k ?? 3)), reason: 'most recent' }),
  },
  'selfcheck.pass': {
    description: 'Does a new agent\'s self-check output satisfy the expected result?', threshold: 0.7,
    questions: () => ({ q: noulQ('Given the task, the expected result and the actual output, does the actual output satisfy the expectation?') }),
    interpret: singleNoul, fallback: () => ({ answer: null, reason: 'ask user to confirm' }),
  },
  'outcome.classify': {
    description: 'Did the run succeed, fail, or is it unknown?', threshold: 0.6, choices: ['success', 'fail', 'unknown'],
    questions: () => ({ q: choiceQ('Based on this summary of an AI coding run, did it accomplish what the user asked?', { success: 'the task was completed and verified', fail: 'the task failed, errored, was abandoned or the user was unhappy', unknown: 'cannot tell from the summary' }) }),
    interpret: singleChoice, fallback: () => ({ answer: 'unknown', reason: 'no signal' }),
  },
  escalate: {
    description: 'After a failure, what next?', threshold: 0.5, choices: ['retry_same', 'escalate_tier', 'switch_engine', 'ask_user'],
    questions: (input) => {
      const criteria: Record<string, string> = { retry_same: 'retry with the same model, the failure looks transient', escalate_tier: 'retry with a stronger model / deeper reasoning', ask_user: 'the user must decide or provide information' };
      if (input.state.other_engine_available) criteria.switch_engine = 'try the other AI engine, this one seems to struggle with the task';
      return { q: choiceQ('An AI coding run failed. Given the failure summary, what is the best next step?', criteria) };
    },
    interpret: singleChoice, fallback: (input) => ({ answer: input.state.other_engine_available ? 'escalate_tier' : 'escalate_tier', reason: 'default escalation' }),
  },
  'lesson.accept': {
    description: 'Is a lesson candidate a generalizable rule?', threshold: 0.6,
    questions: () => ({ q: noulQ('Is this lesson a generalizable rule that would help in future similar tasks (not a one-off typo, not specific to one file or environment, not obvious common sense)?') }),
    interpret: singleNoul, fallback: () => ({ answer: 0, reason: 'keep as candidate' }),
  },
  'knowledge.stale': {
    description: 'Does a newly fetched source supersede the stored knowledge item?', threshold: 0.7,
    questions: () => ({ q: noulQ('Does the new source content change or contradict the stored knowledge item so that the item should be replaced?') }),
    interpret: singleNoul, fallback: () => ({ answer: null, reason: 'human review queue' }),
  },
  handoff: {
    description: 'Can a new session continue from this summary alone?', threshold: 0.6,
    questions: () => ({ q: noulQ('Is this summary sufficient for a fresh AI session to continue the work without the original conversation?') }),
    interpret: singleNoul, fallback: () => ({ answer: null, reason: 'ask user to confirm summary' }),
  },
  'ui.focus': {
    description: 'Which workbench pane should come to the front after this event?', threshold: 0.6, choices: ['chat', 'editor', 'diff', 'terminal', 'run_output', 'preview', 'screen', 'debug', 'none'],
    questions: () => ({ q: choiceQ('An event just happened in an AI coding session. Which IDE pane should be brought to the front for the user?', { chat: 'the assistant message needs reading', editor: 'a source file should be looked at', diff: 'code changes should be reviewed', terminal: 'terminal output matters', run_output: 'output of a remote run or test matters', preview: 'the running web app should be looked at', screen: 'the remote machine screen should be looked at', debug: 'a debugger stopped at a breakpoint', none: 'do not change focus' }) }),
    interpret: singleChoice, fallback: () => ({ answer: 'none', reason: 'keep focus' }),
  },
  'ui.artifact': {
    description: 'Which changed file should be opened for the user?', threshold: 0.5, choices: 'caller',
    questions: (input) => ({ q: choiceQ('Which of these changed files is the most useful one to open for the user to review first?', callerChoices(input)) }),
    interpret: singleChoice, fallback: (input) => ({ answer: Object.keys(input.options ?? {})[0] ?? null, reason: 'first changed file' }),
  },
  'notify.level': {
    description: 'How loudly to notify a mobile user about a background event (0 quiet, 1 badge, 2 push).', threshold: 0,
    questions: () => ({ q: scoreQ('How important is it to notify the user about this background event right now?', ['not important, can wait silently', 'worth a badge or in-app hint', 'needs attention now (approval, failure, done with results)']) }),
    interpret: singleScore, fallback: () => ({ answer: 1, reason: 'badge' }),
  },
  'device.select': {
    description: 'Which attached device (adb/sdb) should be used?', threshold: 0.6, choices: 'caller',
    questions: (input) => ({ q: choiceQ('Which attached device should be used for this command?', callerChoices(input)) }),
    interpret: singleChoice, fallback: (input) => ({ answer: Object.keys(input.options ?? {})[0] ?? null, reason: 'first device' }),
  },
  'agent.pick': {
    description: 'Generic choice for agents (MCP aidev_decide): pick among caller-supplied candidates.', threshold: 0.5, choices: 'caller',
    questions: (input) => ({ q: choiceQ(String(input.state.question ?? 'Which option is best for the situation described?'), callerChoices(input)) }),
    interpret: singleChoice, fallback: (input) => ({ answer: Object.keys(input.options ?? {})[0] ?? null, reason: 'first candidate' }),
  },
  'agent.score': {
    description: 'Generic score for agents (MCP aidev_decide): rate a situation on caller-supplied levels.', threshold: 0,
    questions: (input) => {
      const levels = Array.isArray(input.state.levels) ? (input.state.levels as unknown[]).map(String).slice(0, 7) : ['low', 'medium', 'high'];
      return { q: scoreQ(String(input.state.question ?? 'Rate the situation.'), levels) };
    },
    interpret: singleScore, fallback: () => ({ answer: null, reason: 'no score' }),
  },
  'agent.yesno': {
    description: 'Generic yes/no for agents (MCP aidev_decide).', threshold: 0.6,
    questions: (input) => ({ q: noulQ(String(input.state.question ?? 'Is the statement true for the situation described?')) }),
    interpret: singleNoul, fallback: () => ({ answer: null, reason: 'undecided' }),
  },
};

export function listKinds() {
  return Object.entries(KINDS).map(([kind, spec]) => ({ kind, description: spec.description, threshold: spec.threshold, choices: spec.choices ?? null }));
}

/** Run one registered decision. Never throws for Laya failures — returns the fallback with `fallback: true`. */
export async function decide(laya: LayaClient, kind: string, input: DecideInput): Promise<DecideResult> {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown decision kind: ${kind}`);
  const state = budgetState(input.state ?? {}, spec.stateBudget ?? 1024);
  const questions = spec.questions({ ...input, state });
  const threshold = input.threshold ?? spec.threshold;
  try {
    const result = await laya.predict(state, questions);
    const out = spec.interpret(result, { ...input, state }, spec);
    // Low confidence on a choice/noul kind → fallback answer, but keep Laya's probabilities for logging.
    const lowConfidence = spec.choices ? out.confidence < threshold : false;
    if (lowConfidence) {
      const fb = spec.fallback(input);
      return { kind, answer: fb.answer, confidence: out.confidence, probabilities: out.probabilities, fallback: true, reason: `low confidence (${out.confidence.toFixed(2)} < ${threshold}): ${fb.reason}`, latency_ms: result.latency_ms ?? null, device: result.device ?? null, raw: result.answers };
    }
    return { kind, answer: out.answer, confidence: out.confidence, probabilities: out.probabilities, fallback: false, latency_ms: result.latency_ms ?? null, device: result.device ?? null, raw: result.answers };
  } catch (error) {
    const fb = spec.fallback(input);
    return { kind, answer: fb.answer, confidence: 0, fallback: true, reason: `laya unavailable: ${error instanceof Error ? error.message : String(error)}; ${fb.reason}`, latency_ms: null };
  }
}
