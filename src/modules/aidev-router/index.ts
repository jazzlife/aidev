/**
 * aidev-router — send-time routing (agent / engine / model) against the Nado AI Dev gateway.
 * Non-visual core shared by the workbench and the mobile app; UI components live in each app.
 */
export { aidevApi } from '@/modules/aidev-router/api';
export type { RouteResult, RouteScope, RouteTarget, DecideResult, EnginesResult, CatalogAgent, AgentDetail, UnreadSession, CreateQueueEntry, Engine, RouteRequest, RemoteRun, RemoteApproval, UiCommand } from '@/modules/aidev-router/api';
export { useRemoteApprovals, focusRemoteRun, REMOTE_RUN_FOCUS_EVENT } from '@/modules/aidev-router/hooks/useRemoteApprovals';
export { useUiCommands } from '@/modules/aidev-router/hooks/useUiCommands';
export { announceRunComplete, changedFilesSince, RUN_COMPLETE_EVENT } from '@/modules/aidev-router/runEvents';
export { routingStore, useRoutingState } from '@/modules/aidev-router/store';
export type { RoutingMode, RoutingOverrides, RoutingState } from '@/modules/aidev-router/store';
export { useAidevRouting, shouldAskClarify } from '@/modules/aidev-router/hooks/useAidevRouting';
// §3.1 clarify card for the workbench composer (the mobile app has its own).
export { ClarifyPrompt } from '@/modules/aidev-router/ClarifyPrompt';
export { usePrejudge } from '@/modules/aidev-router/hooks/usePrejudge';
export type { AidevSendDecoration, BeforeSendContext } from '@/modules/aidev-router/hooks/useAidevRouting';
export { useAidevDecide } from '@/modules/aidev-router/hooks/useAidevDecide';
// D-04: domains offered for background creation (workbench catalog + mobile conversation list).
export { useCreateProposals, COMPOSE_EVENT } from '@/modules/aidev-router/hooks/useCreateProposals';
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
// 2026-10-09: the way back from a usage-limit handoff once the engine it left is usable again.
export { useReturnFromHandoff, rememberHandoff, handoffOrigin, returnTarget } from '@/modules/aidev-router/hooks/useReturnFromHandoff';
export type { HandoffOrigin, ReturnFromHandoff } from '@/modules/aidev-router/hooks/useReturnFromHandoff';
export { ReturnCard } from '@/modules/aidev-router/ReturnCard';
// 2026-10-09: account usage limits per engine, for the drawers of both apps.
export { useUsageLimits, usageLimitView, formatTimeLeft } from '@/modules/aidev-router/hooks/useUsageLimits';
export type { UsageLimitView, UsageWindowView } from '@/modules/aidev-router/hooks/useUsageLimits';
export { UsageLimitPanel } from '@/modules/aidev-router/UsageLimitPanel';
// 2026-10-09: the order engines are used in (workbench settings + mobile settings).
export { useEnginePriority, PRIORITY_CHOICES, priorityKey } from '@/modules/aidev-router/hooks/useEnginePriority';
export { EnginePriorityDefaults } from '@/modules/aidev-router/EnginePriorityDefaults';
export type { NextAction } from '@/modules/aidev-router/api';
// E-04: knowledge re-check and review (workbench catalog + mobile settings).
export { useKnowledgeRefresh, knowledgeLabel, refreshSummary } from '@/modules/aidev-router/hooks/useKnowledgeRefresh';
export type { KnowledgeItem, KnowledgeProposal, KnowledgeRefreshJob } from '@/modules/aidev-router/api';
// Effort ceiling per engine (workbench router bar + mobile settings).
export { useEffortCap, EFFORT_LABEL } from '@/modules/aidev-router/hooks/useEffortCap';
export { useChatEffortCap } from '@/modules/aidev-router/hooks/useChatEffortCap';
export { EffortCapDefaults } from '@/modules/aidev-router/EffortCapDefaults';
// Model floor per engine (workbench settings/router bar + mobile settings/routing sheet) — 2026-10-07.
export { useModelFloor, MODEL_LABEL } from '@/modules/aidev-router/hooks/useModelFloor';
export { useChatModelFloor } from '@/modules/aidev-router/hooks/useChatModelFloor';
// Independent verification of a finished run (worker ≠ verifier): the verdict card, both apps.
export { VerificationCard } from '@/modules/aidev-router/VerificationCard';
export type { RunVerification } from '@/modules/aidev-router/api';
// F-08: the PC a chat's remote work goes to (router bar chip + mobile router sheet).
export { useTargetChoice, targetChipView, TARGET_SOURCE_LABEL } from '@/modules/aidev-router/hooks/useTargetChoice';
export type { RouteDevice, RouteTargetOption, RouteTargetSource } from '@/modules/aidev-router/api';
