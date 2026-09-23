import express from 'express';

import { aidevToolsService } from '@/modules/aidev-tools/aidev-tools.service.js';

/**
 * Local HTTP endpoint used only by the aidev-tools stdio MCP process
 * (aidev-tools-mcp.ts). Protected by a per-runtime token; not user facing.
 */
const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

router.use((req, res, next) => {
  const expected = aidevToolsService.getMcpToken();
  const token = readBearerToken(req.headers.authorization);
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid aidev-tools MCP token.' });
    return;
  }
  next();
});

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const asStringMap = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry).slice(0, 600)]));
};

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = asRecord(req.body);
    let result: unknown;
    switch (req.params.toolName) {
      case 'aidev_decide':
        result = await aidevToolsService.decide({
          kind: String(input.kind || ''),
          question: typeof input.question === 'string' ? input.question : undefined,
          state: asRecord(input.state),
          options: asStringMap(input.options),
          levels: Array.isArray(input.levels) ? input.levels.map(String) : undefined,
        });
        break;
      case 'remote_targets':
        result = await aidevToolsService.listTargets();
        break;
      case 'remote_rpc': {
        const targetId = Number(input.targetId);
        if (!Number.isInteger(targetId)) {
          throw new Error('targetId must be an integer.');
        }
        result = await aidevToolsService.targetRpc(targetId, String(input.method || ''), asRecord(input.params));
        break;
      }
      default:
        res.status(404).json({ success: false, error: `Unknown tool: ${req.params.toolName}` });
        return;
    }
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'aidev-tools request failed' });
  }
});

export default router;
