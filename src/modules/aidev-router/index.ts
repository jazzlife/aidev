/**
 * aidev-router — send-time routing (agent / engine / model) against the Nado AI Dev gateway.
 * Non-visual core shared by the workbench and the mobile app; UI components live in each app.
 */
export { aidevApi } from '@/modules/aidev-router/api';
export type { RouteResult, RouteScope, RouteTarget, DecideResult, EnginesResult, CatalogAgent, Engine, RouteRequest, RemoteRun, RemoteApproval } from '@/modules/aidev-router/api';
export { useRemoteApprovals, focusRemoteRun, REMOTE_RUN_FOCUS_EVENT } from '@/modules/aidev-router/hooks/useRemoteApprovals';
export { routingStore, useRoutingState } from '@/modules/aidev-router/store';
export type { RoutingMode, RoutingOverrides, RoutingState } from '@/modules/aidev-router/store';
export { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
export { usePrejudge } from '@/modules/aidev-router/hooks/usePrejudge';
export type { AidevSendDecoration, BeforeSendContext } from '@/modules/aidev-router/hooks/useAidevRouting';
export { useAidevDecide } from '@/modules/aidev-router/hooks/useAidevDecide';
// Workbench-only UI (the mobile app has its own chip in src-mobile).
export { AidevRouterBar } from '@/modules/aidev-router/AidevRouterBar';
export { AgentCreateCard } from '@/modules/aidev-router/AgentCreateCard';
export { useAgentCreation } from '@/modules/aidev-router/hooks/useAgentCreation';
export { parseAgentDraft } from '@/modules/aidev-router/api';
export type { AgentDraft } from '@/modules/aidev-router/api';
export type { PendingCreate } from '@/modules/aidev-router/store';
export { AgentCatalog } from '@/modules/aidev-router/AgentCatalog';
// Claude subscription login (in-app, both apps): state + flow hooks, workbench panel/dialog.
export { claudeAuth, useClaudeAuth } from '@/modules/aidev-router/hooks/useClaudeAuth';
export { useClaudeLoginFlow } from '@/modules/aidev-router/hooks/useClaudeLoginFlow';
export type { ClaudeLoginStage } from '@/modules/aidev-router/hooks/useClaudeLoginFlow';
export { ClaudeLoginPanel, ClaudeLoginDialog } from '@/modules/aidev-router/ClaudeLoginPanel';
// E-03: follow-up for a failed run (retry / stronger model / engine handoff).
export { useEscalation } from '@/modules/aidev-router/hooks/useEscalation';
export { EscalationCard } from '@/modules/aidev-router/EscalationCard';
export type { NextAction } from '@/modules/aidev-router/api';
// E-04: knowledge re-check and review (workbench catalog + mobile settings).
export { useKnowledgeRefresh, knowledgeLabel, refreshSummary } from '@/modules/aidev-router/hooks/useKnowledgeRefresh';
export type { KnowledgeItem, KnowledgeProposal, KnowledgeRefreshJob } from '@/modules/aidev-router/api';
// Effort ceiling per engine (workbench router bar + mobile settings).
export { useEffortCap, EFFORT_LABEL } from '@/modules/aidev-router/hooks/useEffortCap';
export { useChatEffortCap } from '@/modules/aidev-router/hooks/useChatEffortCap';
export { EffortCapDefaults } from '@/modules/aidev-router/EffortCapDefaults';
// F-08: the PC a chat's remote work goes to (router bar chip + mobile router sheet).
export { useTargetChoice, targetChipView, TARGET_SOURCE_LABEL } from '@/modules/aidev-router/hooks/useTargetChoice';
export type { RouteDevice, RouteTargetOption, RouteTargetSource } from '@/modules/aidev-router/api';
