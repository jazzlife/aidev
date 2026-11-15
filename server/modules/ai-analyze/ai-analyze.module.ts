import { aidevToolsService } from '@/modules/aidev-tools/index.js';
import { getConnection } from '@/modules/database/index.js';
import { createAnalysisResultsStore } from '@/modules/ai-analyze/analysis-results.store.js';
import { createAiAnalyzeRouter } from '@/modules/ai-analyze/ai-analyze.routes.js';
import { createAiAnalyzeService } from '@/modules/ai-analyze/ai-analyze.service.js';
import { runClaudeAnalysisTurn } from '@/modules/ai-analyze/claude-analysis.js';

// Composition root: the runtime's own database, the account's Claude subscription, the account's model settings.
const aiAnalyzeService = createAiAnalyzeService({
  store: createAnalysisResultsStore(getConnection),
  runTurn: runClaudeAnalysisTurn,
  pickModel: (effortHint) => aidevToolsService.pickAnalysisModel(effortHint),
});

// aiAnalyzeRoutes: used by the server entrypoint to mount the AI analysis contract v1 at /api/ai-analyze.
export const aiAnalyzeRoutes = createAiAnalyzeRouter({ service: aiAnalyzeService });
