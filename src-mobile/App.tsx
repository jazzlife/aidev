import { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { AuthProvider, WebSocketProvider, useAuth } from '@/modules/chat-core';
import { LoginScreen } from '@m/screens/LoginScreen';
import { SessionsScreen } from '@m/screens/SessionsScreen';
import { Splash } from '@m/components/Splash';
import { ApprovalSheet } from '@m/components/ApprovalSheet';
import { BackController } from '@m/lib/nav';
import { DrawerProvider } from '@m/components/AppDrawer';
import { UiCommandBridge } from '@m/components/UiCommandBridge';
import { UpdateBanner } from '@m/components/UpdateBanner';
import { RouteProgress } from '@m/components/RouteProgress';
import { ScreenErrorBoundary } from '@m/components/Skeleton';
import { lazyScreen } from '@m/lib/lazyScreen';

// C-06 (Lighthouse mobile 4G: LCP 2.7 s, 82% of the main chunk unused on the first screen): only the entry screens
// (login, conversation list) ship in the main chunk; every other screen loads when it is opened.
const ChatScreen = lazyScreen(() => import('@m/screens/ChatScreen').then((m) => m.ChatScreen));
const SettingsScreen = lazyScreen(() => import('@m/screens/SettingsScreen').then((m) => m.SettingsScreen));
const PreviewScreen = lazyScreen(() => import('@m/screens/PreviewScreen').then((m) => m.PreviewScreen));
const DebugScreen = lazyScreen(() => import('@m/screens/DebugScreen').then((m) => m.DebugScreen));
const RemoteScreenScreen = lazyScreen(() => import('@m/screens/RemoteScreenScreen').then((m) => m.RemoteScreenScreen));
const ProjectsScreen = lazyScreen(() => import('@m/screens/ProjectsScreen').then((m) => m.ProjectsScreen));
const ProjectScreen = lazyScreen(() => import('@m/screens/ProjectScreen').then((m) => m.ProjectScreen));
const ScreenPickScreen = lazyScreen(() => import('@m/screens/ScreenPickScreen').then((m) => m.ScreenPickScreen));
const TargetsScreen = lazyScreen(() => import('@m/screens/TargetsScreen').then((m) => m.TargetsScreen));
const CatalogScreen = lazyScreen(() => import('@m/screens/CatalogScreen').then((m) => m.CatalogScreen));

/** C-12.1: the screens opened most, fetched while the phone is idle after sign-in (not on Save-Data or 2G). */
const PREFETCH = [ChatScreen, ProjectsScreen, ProjectScreen, SettingsScreen];

function usePrefetchScreens() {
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || /2g/.test(connection?.effectiveType ?? '')) return undefined;
    let cancelled = false;
    const idle = (run: () => void) => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
      if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 4000 }); else window.setTimeout(run, 1500);
    };
    const next = (index: number) => {
      const screen = PREFETCH[index];
      if (cancelled || !screen) return;
      idle(() => { if (!cancelled) void screen.preload().catch(() => undefined).then(() => next(index + 1)); });
    };
    next(0);
    return () => { cancelled = true; };
  }, []);
}

/**
 * Route names mirror the workbench (/session/:id) so deep links and notifications work in both apps. One layout route
 * for every signed-in screen (C-12.1): the socket, drawer and Suspense stay mounted between screens, and with router
 * transitions the screen on show stays until the next one is ready — the splash is only for restoring the session and
 * the first download of a cold-start deep link.
 */
function Gate() {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return <Splash />;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  // agent commands waiting for approval surface on every signed-in screen
  return (
    <WebSocketProvider>
      <DrawerProvider>
        <RouteProgress />
        <Prefetch />
        <ScreenErrorBoundary><Suspense fallback={<Splash />}><Outlet /></Suspense></ScreenErrorBoundary>
        <ApprovalSheet />
        <UiCommandBridge />
      </DrawerProvider>
    </WebSocketProvider>
  );
}

function Prefetch() {
  usePrefetchScreens();
  return null;
}

export default function App() {
  return (
    <BrowserRouter basename="/m" future={{ v7_startTransition: true }}>
      {/* back = up (parent screen), never the previous page; leaves the app at the root */}
      <BackController />
      {/* a deploy reaches an installed app: reload on return, or a tap while it is open */}
      <UpdateBanner />
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route element={<Gate />}>
            <Route path="/" element={<SessionsScreen />} />
            <Route path="/projects" element={<ProjectsScreen />} />
            <Route path="/projects/:projectId" element={<ProjectScreen />} />
            <Route path="/session/:sessionId" element={<ChatScreen />} />
            <Route path="/new" element={<ChatScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="/screen" element={<ScreenPickScreen />} />
            <Route path="/screen/:targetId" element={<RemoteScreenScreen />} />
            <Route path="/pcs" element={<TargetsScreen />} />
            <Route path="/preview" element={<PreviewScreen />} />
            <Route path="/debug" element={<DebugScreen />} />
            <Route path="/catalog" element={<CatalogScreen />} />
            <Route path="/catalog/:agentId" element={<CatalogScreen />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
