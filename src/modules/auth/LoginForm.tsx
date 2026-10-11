import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, User } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
  /** the new password a new or reset account chooses before it signs in */
  newPassword: string;
  confirmPassword: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
  newPassword: '',
  confirmPassword: '',
};

/**
 * Login form component.
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials. A new or reset account (gateway /admin)
 * is asked for a new password after its initial one, and signs in with that.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { error: sessionError, login, changePassword } = useAuth();

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // the password was right but the account must choose a new one: the form asks for it instead
  const [mustChange, setMustChange] = useState(false);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      if (mustChange) {
        if (formState.newPassword.length < 8) { setErrorMessage(t('login.changePassword.tooShort')); return; }
        if (formState.newPassword !== formState.confirmPassword) { setErrorMessage(t('login.changePassword.mismatch')); return; }
      }

      setIsSubmitting(true);
      const result = mustChange
        ? await changePassword(formState.username.trim(), formState.password, formState.newPassword)
        : await login(formState.username.trim(), formState.password);
      if (!result.success) {
        if (result.passwordChangeRequired) setMustChange(true);
        else setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [changePassword, formState, login, mustChange, t],
  );

  return (
    <AuthScreenLayout
      title={mustChange ? t('login.changePassword.title') : t('login.title')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {mustChange ? (
          <>
            <p className="text-sm text-muted-foreground">{t('login.changePassword.notice')}</p>
            <AuthInputField
              id="new-password"
              label={t('login.changePassword.newPassword')}
              value={formState.newPassword}
              onChange={(value) => updateField('newPassword', value)}
              placeholder={t('login.changePassword.placeholder')}
              isDisabled={isSubmitting}
              type="password"
              autoComplete="new-password"
              icon={Lock}
            />
            <AuthInputField
              id="confirm-password"
              label={t('login.changePassword.confirmPassword')}
              value={formState.confirmPassword}
              onChange={(value) => updateField('confirmPassword', value)}
              placeholder={t('login.changePassword.placeholder')}
              isDisabled={isSubmitting}
              type="password"
              autoComplete="new-password"
              icon={Lock}
            />
          </>
        ) : (
          <>
            <AuthInputField
              id="username"
              label={t('login.username')}
              value={formState.username}
              onChange={(value) => updateField('username', value)}
              placeholder={t('login.placeholders.username')}
              isDisabled={isSubmitting}
              autoComplete="username"
              icon={User}
            />

            <AuthInputField
              id="password"
              label={t('login.password')}
              value={formState.password}
              onChange={(value) => updateField('password', value)}
              placeholder={t('login.placeholders.password')}
              isDisabled={isSubmitting}
              type="password"
              autoComplete="current-password"
              icon={Lock}
            />
          </>
        )}

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {mustChange ? t('login.changePassword.loading') : t('login.loading')}
            </>
          ) : (
            mustChange ? t('login.changePassword.submit') : t('login.submit')
          )}
        </button>
        {mustChange ? (
          <button type="button" onClick={() => { setMustChange(false); setErrorMessage(''); setFormState(initialState); }} className="w-full text-center text-sm text-muted-foreground underline">
            {t('login.changePassword.back')}
          </button>
        ) : null}
      </form>
    </AuthScreenLayout>
  );
}
