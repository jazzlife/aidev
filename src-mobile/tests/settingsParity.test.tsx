import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** C-12.9: saved permission rules and voice in the phone's settings. */
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const store = vi.hoisted(() => ({ prefs: {} as Record<string, unknown>, listeners: new Set<() => void>(), tokens: [] as Array<{ id: number; credential_name: string; is_active: number }> }));
const writeUserPreference = vi.hoisted(() => vi.fn((key: string, value: unknown) => { store.prefs[key] = value; for (const l of store.listeners) l(); }));
const toggle = vi.hoisted(() => vi.fn());
vi.mock('@/modules/chat-core', () => ({
  api: {
    voice: { health: () => json({ configured: true }) },
    githubOauth: { config: () => json({ configured: false, callbackUrl: '', homepageUrl: '', admin: false }), save: vi.fn(), startUrl: (r: string) => r },
    settings: { credentials: vi.fn(() => json({ credentials: store.tokens })), createCredential: vi.fn((body: { credentialName: string }) => { store.tokens.push({ id: 9, credential_name: body.credentialName, is_active: 1 }); return json({ success: true }); }), deleteCredential: vi.fn((id: string) => { store.tokens = store.tokens.filter((t) => String(t.id) !== id); return json({ success: true }); }) },
  },
  readUserPreference: (key: string, fallback: unknown) => store.prefs[key] ?? fallback,
  writeUserPreference,
  subscribeToUserPreferences: (l: () => void) => { store.listeners.add(l); return () => store.listeners.delete(l); },
  getClaudeSettings: () => {
    const saved = (store.prefs.claudePermissions ?? {}) as { allowedTools?: string[]; disallowedTools?: string[]; skipPermissions?: boolean };
    return { allowedTools: saved.allowedTools ?? [], disallowedTools: saved.disallowedTools ?? [], skipPermissions: Boolean(saved.skipPermissions), projectSortOrder: 'name' };
  },
  voicePlayer: { unlock: vi.fn(), toggle },
}));

const { GithubSection, PermissionRulesSection, VoiceSection } = await import('@m/components/SettingsSections');
const chatCore = await import('@/modules/chat-core');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); store.prefs = {}; store.listeners.clear(); store.tokens = []; });

describe('permission rules', () => {
  it('lists the saved allow and deny rules and removes one (the workbench list changes too)', () => {
    store.prefs.claudePermissions = { allowedTools: ['Bash(npm:*)', 'Read'], disallowedTools: ['Bash(rm:*)'], skipPermissions: false };
    render(<PermissionRulesSection />);
    const section = screen.getByTestId('permission-rules');
    expect(section.textContent).toContain('Bash(npm:*)');
    expect(section.textContent).toContain('Bash(rm:*)');
    fireEvent.click(screen.getByLabelText('Bash(npm:*) 규칙 지우기'));
    expect(writeUserPreference).toHaveBeenCalledWith('claudePermissions', { allowedTools: ['Read'], disallowedTools: ['Bash(rm:*)'], skipPermissions: false });
    expect(section.textContent).not.toContain('Bash(npm:*)');
  });

  it('says how rules get there when there are none', () => {
    render(<PermissionRulesSection />);
    expect(screen.getByTestId('permission-rules').textContent).toContain('"항상 허용"');
  });
});

describe('voice', () => {
  it('turns voice on in the shared UI preferences, shows the backend, and sets the read-aloud voice', async () => {
    store.prefs.uiPreferences = { voiceEnabled: false, theme: 'x' };
    render(<VoiceSection />);
    await settle();
    expect(screen.getByTestId('voice-settings').textContent).toContain('서버 음성 연결됨');
    fireEvent.click(screen.getByRole('switch', { name: '음성' }));
    expect(writeUserPreference).toHaveBeenCalledWith('uiPreferences', { voiceEnabled: true, theme: 'x' });
    await settle();
    expect(screen.getByRole('switch', { name: '음성' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('읽어 주기 목소리'), { target: { value: 'nova' } });
    expect(JSON.parse(localStorage.getItem('voiceConfig') ?? '{}').ttsVoice).toBe('nova');
    fireEvent.click(screen.getByText('들어 보기'));
    expect(toggle).toHaveBeenCalled();
  });
});

describe('GitHub account', () => {
  it('connects an account with a token and disconnects it', async () => {
    render(<GithubSection />);
    await settle();
    expect(screen.getByTestId('github-settings').textContent).toContain('연결된 계정이 없습니다');
    fireEvent.click(screen.getByText('토큰으로 연결'));
    fireEvent.change(screen.getByLabelText('GitHub 토큰'), { target: { value: 'ghp_test' } });
    fireEvent.click(screen.getByRole('button', { name: '토큰으로 연결' }));
    await settle();
    expect(chatCore.api.settings.createCredential).toHaveBeenCalledWith({ credentialName: 'GitHub', credentialType: 'github_token', credentialValue: 'ghp_test', description: 'NadoVibe에서 연결' });
    fireEvent.click(screen.getByLabelText('GitHub 연결 해제'));
    await settle();
    expect(chatCore.api.settings.deleteCredential).toHaveBeenCalledWith('9');
    expect(screen.getByTestId('github-settings').textContent).toContain('연결된 계정이 없습니다');
  });
});
