import express, { type Request, type Response } from 'express';

import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { lessonCuratorService } from '@/modules/aidev-tools/lesson-curator.service.js';
import { claudeLoginService } from '@/modules/aidev-tools/claude-login.service.js';

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
