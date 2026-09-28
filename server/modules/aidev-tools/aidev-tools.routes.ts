import express, { type Request, type Response } from 'express';

import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { lessonCuratorService } from '@/modules/aidev-tools/lesson-curator.service.js';
import { claudeLoginService } from '@/modules/aidev-tools/claude-login.service.js';
import { handoffService } from '@/modules/aidev-tools/handoff.service.js';
import { knowledgeCheckService } from '@/modules/aidev-tools/knowledge-check.service.js';

/**
 * Gateway → runtime calls made on behalf of the user (mounted at /api/aidev-tools behind
 * authenticateToken). The gateway reaches these through the same proxy path as the browser.
 */
const router = express.Router();

router.post('/curate', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'session_id is required.' });
    return;
  }
  const result = await lessonCuratorService.curate({
    sessionId,
    runId: typeof body.run_id === 'number' ? body.run_id : null,
    agent: typeof body.agent === 'string' ? body.agent : null,
    engine: body.engine === 'codex' ? 'codex' : body.engine === 'claude' ? 'claude' : null,
    command: typeof body.command === 'string' ? body.command : null,
    signals: body.signals && typeof body.signals === 'object' ? body.signals as Record<string, unknown> : {},
  });
  res.json(createApiSuccessResponse(result));
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
  const engine = body.engine === 'codex' ? 'codex' : 'claude';
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

export default router;
