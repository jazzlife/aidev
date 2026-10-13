import type { LLMProvider } from '@/shared/types';
import { isAidevEngine } from '@/shared/utils';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * The provider the user last chose, shared by chat, the shell, the git panel and
 * the project workspace.
 *
 * It was read from localStorage in six places with four different hand-rolled
 * readers — only one of which validated the stored string — and written from
 * three modules. Nothing published a same-tab change, so the git panel's reader
 * (which listens only for the cross-tab `storage` event) never saw a switch made
 * in its own tab.
 *
 * The value now lives in `auth.db` through the preference store, which notifies
 * its subscribers synchronously — including in the tab that wrote — so the
 * choice both reaches every reader at once and follows the user between devices.
 */

const DEFAULT_PROVIDER: LLMProvider = 'claude';

/** The stored choice when it is a provider the platform offers; a stored Cursor (hidden 2026-10-13) reads as the default. */
export function readSelectedProvider(): LLMProvider {
  const stored = readUserPreference<string | null>('selectedProvider', null);
  return isAidevEngine(stored) ? stored : DEFAULT_PROVIDER;
}

/** Remembers the choice; opening an old Cursor session does not make Cursor the choice for new chats. */
export function writeSelectedProvider(provider: LLMProvider): void {
  if (!isAidevEngine(provider)) return;
  writeUserPreference('selectedProvider', provider);
}
