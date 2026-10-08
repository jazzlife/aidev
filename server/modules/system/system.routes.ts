import express from 'express';

import { createApiSuccessResponse } from '@/shared/utils.js';

import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  /** PROJECTS_HOME: what the apps print as `~` and where the folder browser starts. */
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

  // Lets the clients collapse project paths under the projects home to `~` and start folder browsing there.
  router.get('/workspaces-root', (_request, response) => {
    response.json(createApiSuccessResponse({ root: workspacesRoot }));
  });

  return router;
}
