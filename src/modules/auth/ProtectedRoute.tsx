import { Suspense, lazy, type ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

// Onboarding is a one-time flow with a large import graph; loading it lazily keeps it out of the
// initial bundle of every app that only needs the auth session (e.g. the mobile app). Marked pure so
// an app that never renders ProtectedRoute (the mobile app) drops it, and with it the onboarding
// chunk — the whole workbench chat, mermaid, CodeMirror and katex.
const Onboarding = /* @__PURE__ */ lazy(() => import('@/modules/onboarding').then((module) => ({ default: module.Onboarding })));

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Suspense fallback={<AuthLoadingScreen />}><Onboarding onComplete={refreshOnboardingStatus} /></Suspense>;
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Suspense fallback={<AuthLoadingScreen />}><Onboarding onComplete={refreshOnboardingStatus} /></Suspense>;
  }

  return <>{children}</>;
}
