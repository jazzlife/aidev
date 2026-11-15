import express from 'express';

import type { AiAnalyzeReply } from '@/shared/types.js';

type AiAnalyzeRouterDependencies = {
  service: {
    submit(body: unknown): AiAnalyzeReply;
    poll(jobId: string): AiAnalyzeReply;
  };
};

/**
 * The AI analysis contract v1 on this runtime (mounted at /api/ai-analyze behind authenticateToken). The gateway
 * reaches it from `/ai/v1/*` after resolving the caller's NadoVibe key or session to this runtime's account.
 * Used by the ai-analyze module's composition root.
 */
export function createAiAnalyzeRouter(dependencies: AiAnalyzeRouterDependencies): express.Router {
  const router = express.Router();
  const send = (res: express.Response, reply: AiAnalyzeReply) => res.status(reply.status).set('cache-control', 'no-store').json(reply.body);
  // an unexpected error (the database, a bug) still answers in the contract's envelope, never as an HTML page
  const guarded = (res: express.Response, reply: () => AiAnalyzeReply) => {
    try { send(res, reply()); }
    catch (error) {
      console.error('[ai-analyze] request failed:', error instanceof Error ? error.message : error);
      send(res, { status: 502, body: { ok: false, error: { code: 'upstream_error', message: 'AI 분석 엔진 내부 오류다. 잠시 후 같은 requestId 로 다시 보내라' } } });
    }
  };

  router.post('/v1/analyze', (req, res) => guarded(res, () => dependencies.service.submit(req.body)));
  router.get('/v1/analyze/:jobId', (req, res) => guarded(res, () => dependencies.service.poll(String(req.params.jobId))));
  router.use((req, res) => send(res, { status: 404, body: { ok: false, error: { code: 'not_found', message: `${req.method} ${req.path} 은(는) AI 분석 계약 v1 에 없다` } } }));
  return router;
}
