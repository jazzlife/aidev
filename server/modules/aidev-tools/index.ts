/**
 * aidev-tools — runtime integration with the Nado AI Dev platform gateway
 * (Laya decisions, remote targets) and the MCP server the providers inject.
 */

// aidevToolsService: used by the Claude/Codex runtime providers (MCP server config) and the MCP bridge routes.
export { aidevToolsService, sanitizeAidevOptions, composeAgentInstructions } from './aidev-tools.service.js';
export type { AidevTurnOptions } from './aidev-tools.service.js';
// aidevToolsMcpRoutes: mounted by server/index.ts at /api/aidev-tools-mcp (local token protected).
export { default as aidevToolsMcpRoutes } from './aidev-tools-mcp.routes.js';
// aidevToolsRoutes: mounted by server/index.ts at /api/aidev-tools (user-authenticated; called by the gateway for lesson curation).
export { default as aidevToolsRoutes } from './aidev-tools.routes.js';
