import express, { type Request, type Response } from 'express';

import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { lessonCuratorService } from '@/modules/aidev-tools/lesson-curator.service.js';

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

export default router;
