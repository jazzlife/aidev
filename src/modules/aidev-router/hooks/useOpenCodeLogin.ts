import { useCallback, useEffect, useState } from 'react';

import { aidevApi } from '@/modules/aidev-router/api';

/**
 * What OpenCode can be signed in to with an API key, as its own provider ids. OpenCode Go (the subscription) and
 * OpenCode Zen (pay as you go) are different providers with keys from the same page; OpenCode's terminal login lists
 * Zen first as "OpenCode (recommended)" and Go only under a search for "go".
 */
export const OPENCODE_KEY_PROVIDERS: ReadonlyArray<{ id: string; label: string; note: string; keyUrl: string }> = [
  { id: 'opencode-go', label: 'OpenCode Go (구독)', note: 'Go 요금제의 모델(opencode-go/…)을 씁니다.', keyUrl: 'https://opencode.ai/auth' },
  { id: 'opencode', label: 'OpenCode Zen (종량제)', note: '쓴 만큼 내는 OpenCode 게이트웨이 모델(opencode/…)을 씁니다.', keyUrl: 'https://opencode.ai/auth' },
  { id: 'openai', label: 'OpenAI API', note: 'OpenAI API 크레딧으로 GPT 모델(openai/…)을 씁니다. ChatGPT 구독과는 별개입니다.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', label: 'Google Gemini API', note: 'Gemini API 키로 Gemini 모델(google/…)을 씁니다.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'anthropic', label: 'Anthropic API', note: 'Anthropic API 크레딧으로 Claude 모델(anthropic/…)을 씁니다. Claude 구독과는 별개입니다.', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter', note: 'OpenRouter 키로 그곳의 모델(openrouter/…)을 씁니다.', keyUrl: 'https://openrouter.ai/keys' },
];

/** The choice value of "another provider, id typed by hand". */
export const OPENCODE_OTHER_PROVIDER = '__other__';

/** A provider's label for people (its id when it is not one of the listed ones). */
export const openCodeProviderLabel = (id: string) => OPENCODE_KEY_PROVIDERS.find((provider) => provider.id === id)?.label ?? id;

/**
 * Drives the in-app OpenCode sign-in: pick a provider, send its API key to the runtime, which stores it as OpenCode's
 * credential. View-free so the workbench panel and the mobile sheet share it; the key is held only until it is sent.
 */
export function useOpenCodeLogin(onDone?: () => void) {
  // the provider row picked (OPENCODE_OTHER_PROVIDER: an id typed by hand) and that id
  const [choice, setChoice] = useState(OPENCODE_KEY_PROVIDERS[0].id);
  const [otherId, setOtherId] = useState('');
  const [key, setKey] = useState('');
  // providers this runtime's OpenCode already holds a credential for; null until loaded
  const [connected, setConnected] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the provider just stored, for the confirmation line
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { aidevApi.openCodeLoginProviders().then((result) => setConnected(result.providers)).catch(() => setConnected([])); }, []);

  const picked = OPENCODE_KEY_PROVIDERS.find((provider) => provider.id === choice) ?? null;
  const providerId = picked ? picked.id : otherId.trim().toLowerCase();
  const choose = useCallback((next: string) => { setChoice(next); setSaved(null); setError(null); }, []);
  const save = useCallback(async () => {
    if (!providerId || !key.trim() || saving) return;
    setSaving(true); setError(null); setSaved(null);
    try {
      const result = await aidevApi.openCodeLoginKey(providerId, key.trim());
      setConnected(result.providers); setSaved(result.provider); setKey('');
      // the gateway routes by its own cached sign-in state: it learns of the new one now
      void aidevApi.engines(true).catch(() => undefined);
      onDone?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, [key, onDone, providerId, saving]);

  return { choice, choose, otherId, setOtherId, key, setKey, connected, saving, error, saved, picked, providerId, canSave: Boolean(providerId && key.trim()) && !saving, save };
}
