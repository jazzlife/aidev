import { useEffect, useState } from 'react';

import { api, readUserPreference, type LLMProvider, type PermissionMode } from '@/modules/chat-core';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';

/**
 * What a chat send carries besides its text (C-12.2), built like the workbench's `buildSendOptions`: the conversation's
 * permission mode and the provider's saved allow/deny rules (server-synced, shared with the workbench). Model and
 * effort come from the router.
 */

export type ProviderCaps = {
  provider: string;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsMessageEditing?: boolean;
  supportsSessionForking?: boolean;
  supportsTokenUsage?: boolean;
};

/** The workbench's fallback while `/api/providers/capabilities` loads or when it fails. */
const FALLBACK_MODES: Record<string, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

export const MODE_LABELS: Record<string, { label: string; short: string; description: string }> = {
  default: { label: '기본', short: '기본', description: '도구를 쓸 때마다 묻습니다' },
  auto: { label: '자동 판단', short: '자동', description: '안전한 작업은 묻지 않습니다' },
  acceptEdits: { label: '편집 자동 허용', short: '편집 허용', description: '파일 수정은 묻지 않습니다' },
  bypassPermissions: { label: '모두 허용', short: '모두 허용', description: '아무것도 묻지 않습니다' },
  plan: { label: '계획', short: '계획', description: '실행 전에 계획을 먼저 세웁니다' },
};

let capsRequest: Promise<Record<string, ProviderCaps>> | null = null;

function loadCaps() {
  capsRequest ??= api.providers.capabilities().then(async (response) => {
    const body = await response.json() as { success?: boolean; data?: { providers?: ProviderCaps[] } };
    const map: Record<string, ProviderCaps> = {};
    for (const caps of body.data?.providers ?? []) map[caps.provider] = caps;
    return map;
  }).catch(() => { capsRequest = null; return {}; });
  return capsRequest;
}

/** Used by the conversation sheet and the chat: each engine's capabilities (null until loaded). */
export function useCapsMap() {
  const [caps, setCaps] = useState<Record<string, ProviderCaps> | null>(null);
  useEffect(() => { let alive = true; void loadCaps().then((map) => { if (alive) setCaps(map); }); return () => { alive = false; }; }, []);
  return caps;
}

export function permissionModesFor(caps: Record<string, ProviderCaps> | null, provider: string): string[] {
  const listed = caps?.[provider]?.permissionModes;
  return listed?.length ? listed : FALLBACK_MODES[provider] ?? ['default'];
}

function defaultModeFor(caps: Record<string, ProviderCaps> | null, provider: string): string {
  const modes = permissionModesFor(caps, provider);
  const preferred = caps?.[provider]?.defaultPermissionMode;
  return preferred && modes.includes(preferred) ? preferred : modes[0] ?? 'default';
}

// ---- the permission mode, per conversation ----------------------------------------------------------
const NEW_CHAT = 'new';
const modeKey = (sessionId: string | null) => `m.permissionMode.${sessionId ?? NEW_CHAT}`;

function readMode(sessionId: string | null) {
  try { return localStorage.getItem(modeKey(sessionId)); } catch { return null; }
}

/** A brand-new conversation takes the mode chosen in its draft. */
export function adoptDraftPermissionMode(sessionId: string) {
  try {
    const draft = localStorage.getItem(modeKey(null));
    if (draft) { localStorage.setItem(modeKey(sessionId), draft); localStorage.removeItem(modeKey(null)); }
  } catch { /* storage off */ }
}

/** Used by ChatScreen: the conversation's mode (valid for its engine) and a setter that remembers it. */
export function usePermissionMode(sessionId: string | null, provider: string, caps: Record<string, ProviderCaps> | null) {
  const [stored, setStored] = useState<string | null>(() => readMode(sessionId));
  useEffect(() => { setStored(readMode(sessionId)); }, [sessionId]);
  const modes = permissionModesFor(caps, provider);
  const mode = stored && modes.includes(stored) ? stored : defaultModeFor(caps, provider);
  const choose = (next: string) => {
    try { localStorage.setItem(modeKey(sessionId), next); } catch { /* storage off */ }
    setStored(next);
  };
  return { mode, modes, choose };
}

export type SendOptions = {
  permissionMode: string;
  toolsSettings: { allowedTools: string[]; disallowedTools: string[]; skipPermissions: boolean };
  skipPermissions: boolean;
};

/** The workbench's `buildSendOptions` without model and effort (the router sets those). */
export function buildSendOptions(provider: LLMProvider, permissionMode: string): SendOptions {
  const key = PROVIDER_PERMISSION_PREFERENCE_KEYS[provider] ?? PROVIDER_PERMISSION_PREFERENCE_KEYS.claude;
  const stored = readUserPreference<Partial<SendOptions['toolsSettings']>>(key, {});
  const toolsSettings = {
    allowedTools: Array.isArray(stored.allowedTools) ? stored.allowedTools : [],
    disallowedTools: Array.isArray(stored.disallowedTools) ? stored.disallowedTools : [],
    skipPermissions: Boolean(stored.skipPermissions),
  };
  return { permissionMode, toolsSettings, skipPermissions: toolsSettings.skipPermissions };
}

// ---- attachments ---------------------------------------------------------------------------------------
/** The server's limits (`/api/assets/files`). */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type UploadedAttachment = { path?: string; name?: string; mimeType?: string; size?: number };

/** Stores the files on the runtime; the send then names them in `options.attachments`. */
export async function uploadAttachments(files: File[]): Promise<UploadedAttachment[]> {
  if (!files.length) return [];
  const form = new FormData();
  for (const file of files) form.append('files', file);
  const response = await api.assets.uploadFiles(form);
  const body = await response.json().catch(() => null) as { attachments?: UploadedAttachment[]; error?: string } | null;
  if (!response.ok) throw new Error(body?.error || `첨부를 올리지 못했습니다 (${response.status})`);
  if (!Array.isArray(body?.attachments) || body.attachments.length !== files.length) throw new Error('첨부 일부를 올리지 못했습니다');
  return body.attachments;
}

/** Why a picked file cannot go (null when it can). */
export function attachmentProblem(files: File[], adding: File): string | null {
  if (files.length >= MAX_ATTACHMENTS) return `첨부는 ${MAX_ATTACHMENTS}개까지입니다`;
  if (adding.size > MAX_ATTACHMENT_BYTES) return `${adding.name}: 10MB를 넘습니다`;
  return null;
}
