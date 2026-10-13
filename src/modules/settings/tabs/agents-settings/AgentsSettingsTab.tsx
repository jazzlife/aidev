import { useEffect, useMemo, useState } from 'react';

import type { AgentCategory, AgentContextByProvider, AgentProvider, AgentSettingsProject, ClaudePermissionsState, CodexPermissionMode, CursorPermissionsState, ProviderAuthStatus } from '@/shared/types';
import AgentCategoryContentSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryTabsSection';
import AgentSelectorSection from '@/modules/settings/tabs/agents-settings/sections/AgentSelectorSection';
import { isPolicyProvider, ProviderPolicySettings } from '@/modules/aidev-router';
import { AIDEV_ENGINES } from '@/shared/constants';

type ProviderAuthStatusByProvider = Record<AgentProvider, ProviderAuthStatus>;

type AgentsSettingsTabProps = {
  providerAuthStatus: ProviderAuthStatusByProvider;
  onProviderLogin: (provider: AgentProvider) => void;
  onProviderLogout: (provider: AgentProvider) => Promise<ProviderAuthStatus>;
  claudePermissions: ClaudePermissionsState;
  onClaudePermissionsChange: (value: ClaudePermissionsState) => void;
  cursorPermissions: CursorPermissionsState;
  onCursorPermissionsChange: (value: CursorPermissionsState) => void;
  codexPermissionMode: CodexPermissionMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  projects: AgentSettingsProject[];
};

/** Rendered by Settings for the "agents" tab, hosting per-provider account, permission, MCP and skill settings. */
export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  onProviderLogout,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const visibleCategories = useMemo<AgentCategory[]>(() => (
    selectedAgent === 'opencode'
      // no permissions tab yet: OpenCode has no panel there (it showed an empty page); it comes with the engine UI (G4)
      ? ['account', 'mcp']
      // providers routing picks between also get their model/effort range (provider policy)
      : ['account', 'permissions', 'mcp', 'skills', ...(isPolicyProvider(selectedAgent) ? ['routing' as const] : [])]
  ), [selectedAgent]);

  // the providers the platform offers (Cursor is hidden; its settings stay reachable only through old sessions)
  const visibleAgents = useMemo<AgentProvider[]>(() => [...AIDEV_ENGINES], []);

  const agentContextById = useMemo<AgentContextByProvider>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
      onLogout: () => onProviderLogout('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
      onLogout: () => onProviderLogout('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
      onLogout: () => onProviderLogout('codex'),
    },
    opencode: {
      authStatus: providerAuthStatus.opencode,
      onLogin: () => onProviderLogin('opencode'),
      onLogout: () => onProviderLogout('opencode'),
    },
  }), [
    onProviderLogin,
    onProviderLogout,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.opencode,
  ]);

  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      setSelectedCategory(visibleCategories[0] ?? 'account');
    }
  }, [selectedCategory, visibleCategories]);

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <div className="shrink-0 space-y-3 px-4 pb-3 pt-2 md:px-6"><ProviderPolicySettings /></div>
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          categories={visibleCategories}
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <AgentCategoryContentSection
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          agentContextById={agentContextById}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
