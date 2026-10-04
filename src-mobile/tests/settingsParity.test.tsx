import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** C-12.9: saved permission rules and voice in the phone's settings. */
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const store = vi.hoisted(() => ({ prefs: {} as Record<string, unknown>, listeners: new Set<() => void>() }));
const writeUserPreference = vi.hoisted(() => vi.fn((key: string, value: unknown) => { store.prefs[key] = value; for (const l of store.listeners) l(); }));
const toggle = vi.hoisted(() => vi.fn());
vi.mock('@/modules/chat-core', () => ({
  api: { voice: { health: () => json({ configured: true }) } },
  readUserPreference: (key: string, fallback: unknown) => store.prefs[key] ?? fallback,
  writeUserPreference,
  subscribeToUserPreferences: (l: () => void) => { store.listeners.add(l); return () => store.listeners.delete(l); },
  getClaudeSettings: () => {
    const saved = (store.prefs.claudePermissions ?? {}) as { allowedTools?: string[]; disallowedTools?: string[]; skipPermissions?: boolean };
    return { allowedTools: saved.allowedTools ?? [], disallowedTools: saved.disallowedTools ?? [], skipPermissions: Boolean(saved.skipPermissions), projectSortOrder: 'name' };
  },
  voicePlayer: { unlock: vi.fn(), toggle },
}));

const { PermissionRulesSection, VoiceSection } = await import('@m/components/SettingsSections');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); store.prefs = {}; store.listeners.clear(); });

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
