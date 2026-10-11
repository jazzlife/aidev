import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';

/** Rendered by QuickSettingsPanelView at the bottom of the drawer: who is signed in, and signing out. */
export default function QuickSettingsAccount() {
  const { t } = useTranslation('common');
  const { user, logout } = useAuth();
  const name = user?.username ?? '';

  return (
    <div className="flex items-center gap-3 border-t border-border bg-muted/40 p-4" data-testid="quick-settings-account">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold uppercase text-primary">{name.charAt(0) || '?'}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
      <button type="button" onClick={logout} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400">
        <LogOut className="h-4 w-4" />
        {t('navigation.logout')}
      </button>
    </div>
  );
}
