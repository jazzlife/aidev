/**
 * aidev-router — send-time routing (agent / engine / model) against the Nado AI Dev gateway.
 * Non-visual core shared by the workbench and the mobile app; UI components live in each app.
 */
export { aidevApi } from '@/modules/aidev-router/api';
export type { RouteResult, RouteScope, RouteTarget, DecideResult, EnginesResult, CatalogAgent, Engine, RouteRequest } from '@/modules/aidev-router/api';
export { routingStore, useRoutingState } from '@/modules/aidev-router/store';
export type { RoutingMode, RoutingOverrides, RoutingState } from '@/modules/aidev-router/store';
export { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
export type { AidevSendDecoration, BeforeSendContext } from '@/modules/aidev-router/hooks/useAidevRouting';
export { useAidevDecide } from '@/modules/aidev-router/hooks/useAidevDecide';
// Workbench-only UI (the mobile app has its own chip in src-mobile).
export { AidevRouterBar } from '@/modules/aidev-router/AidevRouterBar';
export { AgentCreateCard } from '@/modules/aidev-router/AgentCreateCard';
export { useAgentCreation } from '@/modules/aidev-router/hooks/useAgentCreation';
export { parseAgentDraft } from '@/modules/aidev-router/api';
export type { AgentDraft } from '@/modules/aidev-router/api';
export type { PendingCreate } from '@/modules/aidev-router/store';
