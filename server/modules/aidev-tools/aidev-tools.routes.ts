import express, { type Request, type Response } from 'express';

import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import type { AidevSideEngine } from '@/shared/index.js';
import { lessonCuratorService } from '@/modules/aidev-tools/lesson-curator.service.js';
import { claudeLoginService } from '@/modules/aidev-tools/claude-login.service.js';
import { handoffService } from '@/modules/aidev-tools/handoff.service.js';
import { knowledgeCheckService } from '@/modules/aidev-tools/knowledge-check.service.js';
import { runVerifierService } from '@/modules/aidev-tools/run-verifier.service.js';
import { remoteSync } from '@/modules/aidev-tools/remote-sync.service.js';
import { specialistJudgeService } from '@/modules/aidev-tools/specialist-judge.service.js';
import { agentDesignerService } from '@/modules/aidev-tools/agent-designer.service.js';
import { openCodeLoginService } from '@/modules/aidev-tools/opencode-login.service.js';

/**
 * Gateway → runtime calls made on behalf of the user (mounted at /api/aidev-tools behind
 * authenticateToken). The gateway reaches these through the same proxy path as the browser.
 */
const router = express.Router();

const SIDE_ENGINES: readonly AidevSideEngine[] = ['claude', 'codex', 'opencode'];
/** The specialist judge answers in seconds on a long-lived Claude/Codex turn; OpenCode has no such transport (§9 Q4). */
const JUDGE_ENGINES = ['claude', 'codex'] as const;
const isSideEngine = (value: unknown): value is AidevSideEngine => SIDE_ENGINES.includes(value as AidevSideEngine);
/**
 * The engines a side turn may run on, as the gateway sent them (the account's usable engines, D-05), kept to the ones
 * this kind of turn runs on (`supported`: every side engine, or the judge's two). Absent = an older gateway: the turn's
 * own default. Present but with none of them (an OpenCode-only account asking for the judge) = `none`: the route
 * refuses instead of treating the empty list as "every engine", which used to run the turn on Claude for an account
 * that may not use it. Exported for this router's test.
 */
export function sideEngines<E extends AidevSideEngine = AidevSideEngine>(value: unknown, supported: readonly E[] = SIDE_ENGINES as readonly E[]): { engines: E[] | undefined; none: boolean } {
  if (!Array.isArray(value)) return { engines: undefined, none: false };
  const engines = (value as unknown[]).filter((engine): engine is E => supported.includes(engine as E));
  return { engines, none: engines.length === 0 };
}
const NO_SIDE_ENGINE = 'none of the account\'s engines can run this side turn in the runtime';

/** Gateway → runtime: is one of the existing agents a true specialist for this command? (routing) */
router.post('/specialist-judge', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  const candidates = Array.isArray(body.candidates)
    ? (body.candidates as unknown[]).filter((c): c is { name: string; description: string } => Boolean(c) && typeof (c as { name?: unknown }).name === 'string' && typeof (c as { description?: unknown }).description === 'string')
    : [];
  if (!command || !candidates.length) {
    res.status(400).json({ success: false, error: 'command and candidates are required.' });
    return;
  }
  try {
    const { engines, none } = sideEngines(body.engines, JUDGE_ENGINES);
    if (none) { res.status(409).json({ success: false, error: NO_SIDE_ENGINE }); return; }
    res.json(createApiSuccessResponse(await specialistJudgeService.judge({ command, candidates, project: typeof body.project === 'string' ? body.project : null, engines, current: typeof body.current === 'string' ? body.current : null, ask: body.ask !== false })));
  } catch (error) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : 'judge failed' });
  }
}));

/** Workbench "프로젝트 동기화" (F-04): copy a project of this runtime to one of the user's machines. */
router.post('/remote-sync', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  try {
    const result = await remoteSync({
      target: typeof body.targetId === 'number' || typeof body.targetId === 'string' ? body.targetId : undefined,
      project: typeof body.projectPath === 'string' ? body.projectPath : undefined,
      dest: typeof body.dest === 'string' ? body.dest : undefined,
      dryRun: body.dryRun === true,
    });
    res.json(createApiSuccessResponse(result));
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'sync failed' });
  }
}));

router.post('/curate', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'session_id is required.' });
    return;
  }
  const curateEngines = sideEngines(body.engines);
  if (curateEngines.none) { res.status(409).json({ success: false, error: NO_SIDE_ENGINE }); return; }
  const result = await lessonCuratorService.curate({
    sessionId,
    runId: typeof body.run_id === 'number' ? body.run_id : null,
    agent: typeof body.agent === 'string' ? body.agent : null,
    engine: isSideEngine(body.engine) ? body.engine : null,
    engines: curateEngines.engines,
    // the gateway's order (work priority / provider policy); absent = the session's engine first
    candidates: Array.isArray(body.candidates) ? (body.candidates as unknown[]).flatMap((entry) => {
      const c = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      return isSideEngine(c.engine) ? [{ engine: c.engine, model: typeof c.model === 'string' ? c.model.slice(0, 100) : null }] : [];
    }) : null,
    command: typeof body.command === 'string' ? body.command : null,
    signals: body.signals && typeof body.signals === 'object' ? body.signals as Record<string, unknown> : {},
  });
  res.json(createApiSuccessResponse(result));
}));

// Independent verification of a finished run (worker ≠ verifier): the gateway asks after a clean D2+ exit.
router.post('/verify', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'session_id is required.' });
    return;
  }
  const floor = body.model_floor && typeof body.model_floor === 'object' ? body.model_floor as Record<string, unknown> : {};
  const verifierAgent = body.verifier_agent && typeof body.verifier_agent === 'object' ? body.verifier_agent as Record<string, unknown> : null;
  const result = await runVerifierService.verify({
    sessionId,
    runId: typeof body.run_id === 'number' ? body.run_id : null,
    agent: typeof body.agent === 'string' ? body.agent : null,
    engine: isSideEngine(body.engine) ? body.engine : null,
    workerModel: typeof body.worker_model === 'string' ? body.worker_model : null,
    engines: sideEngines(body.engines).engines ?? ['claude', 'codex'],
    command: typeof body.command === 'string' ? body.command : null,
    depth: typeof body.depth === 'number' ? body.depth : null,
    modelFloor: { ...(typeof floor.claude === 'string' ? { claude: floor.claude } : {}), ...(typeof floor.codex === 'string' ? { codex: floor.codex } : {}) },
    verifierAgent: verifierAgent && typeof verifierAgent.name === 'string' && typeof verifierAgent.prompt === 'string' ? { name: verifierAgent.name, prompt: verifierAgent.prompt } : null,
    // the gateway's verifier order (verification priority / provider policy); absent = this runtime's own order
    candidates: Array.isArray(body.candidates) ? (body.candidates as unknown[]).flatMap((entry) => {
      const c = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      if (!isSideEngine(c.engine)) return [];
      return [{ engine: c.engine, model: typeof c.model === 'string' ? c.model.slice(0, 100) : null, effort: typeof c.effort === 'string' ? c.effort.slice(0, 20) : null }];
    }) : null,
  });
  res.json(createApiSuccessResponse(result));
}));

// Background agent design: an ongoing chat's command needed a specialist the catalog lacks (the generalist answers it).
router.post('/design-agent', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
  const command = text(body.command, 32000); const prompt = text(body.prompt, 20000);
  if (!command || !prompt) {
    res.status(400).json({ success: false, error: 'command and prompt are required.' });
    return;
  }
  const raw = body.proposal && typeof body.proposal === 'object' ? body.proposal as Record<string, unknown> : null;
  const proposal = raw && typeof raw.name === 'string' && typeof raw.domain === 'string'
    ? { name: raw.name, domain: raw.domain, description: typeof raw.description === 'string' ? raw.description : '', technologies: Array.isArray(raw.technologies) ? (raw.technologies as unknown[]).map(String) : [] }
    : null;
  const maxTurns = typeof body.max_turns === 'number' && body.max_turns > 0 ? Math.min(body.max_turns, 40) : 20;
  // an engine this runtime cannot design on is refused, not quietly swapped for Claude
  if (body.engine !== undefined && !isSideEngine(body.engine)) { res.status(400).json({ success: false, error: `engine ${String(body.engine)} cannot run this side turn` }); return; }
  try {
    res.json(createApiSuccessResponse(await agentDesignerService.design({
      command, proposal, catalog: text(body.catalog, 20000) ?? '', prompt, maxTurns,
      tools: Array.isArray(body.tools) ? (body.tools as unknown[]).map(String) : ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
      engine: isSideEngine(body.engine) ? body.engine : 'claude', model: text(body.model, 100), sessionId: text(body.session_id, 200),
    })));
  } catch (error) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : 'design failed' });
  }
}));

// Engine handoff brief for a failed run moving to the other engine (E-03).
router.post('/handoff', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'session_id is required.' });
    return;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : null);
  res.json(createApiSuccessResponse(await handoffService.build({ sessionId, fromEngine: str(body.from_engine), toEngine: str(body.to_engine), reason: str(body.reason) })));
}));

// Knowledge refresh (E-04): the gateway's weekly job re-checks one stored item per call.
router.post('/knowledge-check', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
  const title = text(body.title, 200); const content = text(body.body, 60000);
  if (!title || !content) {
    res.status(400).json({ success: false, error: 'title and body are required.' });
    return;
  }
  if (body.engine !== undefined && !isSideEngine(body.engine)) { res.status(400).json({ success: false, error: `engine ${String(body.engine)} cannot run this side turn` }); return; }
  const engine = isSideEngine(body.engine) ? body.engine : 'claude';
  res.json(createApiSuccessResponse(await knowledgeCheckService.check({ title, body: content, sourceUrl: text(body.source_url, 2000), sourceDate: text(body.source_date, 40), agent: text(body.agent, 100), engine, model: text(body.model, 100), prompt: text(body.prompt, 20000) })));
}));

// ---- in-app Claude subscription login (workbench and mobile app) -----------------------------
const readBody = (req: Request) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

router.get('/claude-login', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await claudeLoginService.status()));
}));

router.post('/claude-login/start', asyncHandler(async (_req: Request, res: Response) => {
  try {
    res.json(createApiSuccessResponse(await claudeLoginService.start()));
  } catch (error) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}));

router.post('/claude-login/code', asyncHandler(async (req: Request, res: Response) => {
  const body = readBody(req);
  const loginId = typeof body.login_id === 'string' ? body.login_id : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!loginId || !code) {
    res.status(400).json({ success: false, error: 'login_id and code are required.' });
    return;
  }
  try {
    res.json(createApiSuccessResponse(await claudeLoginService.submitCode(loginId, code)));
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}));

router.post('/claude-login/cancel', asyncHandler(async (req: Request, res: Response) => {
  const loginId = readBody(req).login_id;
  if (typeof loginId === 'string') claudeLoginService.cancel(loginId);
  res.json(createApiSuccessResponse({ ok: true }));
}));

// ---- in-app OpenCode login with an API key (workbench) -------------------------------------------
router.get('/opencode-login', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse({ providers: openCodeLoginService.providers() }));
}));

router.post('/opencode-login', asyncHandler(async (req: Request, res: Response) => {
  const body = readBody(req);
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const key = typeof body.key === 'string' ? body.key : '';
  if (!provider || !key) {
    res.status(400).json({ success: false, error: 'provider and key are required.' });
    return;
  }
  try {
    res.json(createApiSuccessResponse(await openCodeLoginService.saveApiKey(provider, key)));
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}));

export default router;
