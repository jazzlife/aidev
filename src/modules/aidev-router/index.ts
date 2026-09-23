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
