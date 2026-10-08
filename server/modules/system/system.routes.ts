import express from 'express';

import { createApiSuccessResponse } from '@/shared/utils.js';

import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  workspacesRoot: string,
): express.Router {
  const router = express.Router();

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  // Lets the client collapse project paths under the workspace root to `~` for display.
  router.get('/workspaces-root', (_request, response) => {
    response.json(createApiSuccessResponse({ root: workspacesRoot }));
  });

  return router;
}
