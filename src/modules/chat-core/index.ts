/**
 * chat-core — the non-visual chat protocol and state machine shared by both UI apps
 * (IMPLEMENTATION-PLAN §3.11). Nothing here renders. The implementation still lives in
 * `src/modules/chat` (upstream layout kept for merges); this barrel is the contract the
 * mobile app codes against so screen code never reaches into the workbench chat module.
 *
 * Protocol summary (websocket, see WebSocketContext):
 *   chat.subscribe {sessions:[{sessionId,lastSeq}]}  → chat_subscribed, replayed events
 *   chat.send {sessionId, content, options}          → stream_delta*, stream_end, tool_use/tool_result, complete
 *   chat.abort {sessionId}
 *   chat.permission-response {requestId, allow, ...}  ← permission_request
 */
// Deliberate deep imports: the chat barrel also exports ChatInterface, whose import graph is the
// whole workbench (CodeMirror, mermaid, katex …). Pointing at the implementation files keeps the
// mobile bundle free of it. This barrel is the only place allowed to do this.
export { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
export type { SessionStore, SessionSlot, SessionStatus } from '@/modules/chat/hooks/useSessionStore';
export { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
export { parseToolPayload, summarizeDiff, calculateDiff } from '@/modules/chat/utils/messageTransforms';
export { splitStreamingMarkdown } from '@/modules/chat/utils/streamingMarkdown';
export { normalizeInlineCodeFences, stripProposedPlanEnvelope } from '@/modules/chat/utils/chatFormatting';
export { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
export { AuthProvider, useAuth } from '@/modules/auth';
export { api, authenticatedFetch, readApiJson } from '@/shared/api';
export type { NormalizedMessage, ServerEvent, PendingPermissionRequest, LLMProvider, ProjectSession } from '@/shared/types';
// Tool permissions shared with the workbench (C-12.2): the "항상 허용" rule and the server-synced allow-list.
export { buildClaudeToolPermissionEntry, grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';
export { readUserPreference, writeUserPreference, subscribeToUserPreferences } from '@/shared/userSettings';
export type { PermissionMode, Question } from '@/shared/types';
