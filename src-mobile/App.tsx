import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, WebSocketProvider, useAuth } from '@/modules/chat-core';
import { LoginScreen } from '@m/screens/LoginScreen';
import { SessionsScreen } from '@m/screens/SessionsScreen';
import { Splash } from '@m/components/Splash';
import { ApprovalSheet } from '@m/components/ApprovalSheet';

// C-06 (Lighthouse mobile 4G: LCP 2.7 s, 82% of the main chunk unused on the first screen): only the entry screens
// (login, conversation list) ship in the main chunk; every other screen loads when it is opened.
const ChatScreen = lazy(() => import('@m/screens/ChatScreen').then((m) => ({ default: m.ChatScreen })));
const SettingsScreen = lazy(() => import('@m/screens/SettingsScreen').then((m) => ({ default: m.SettingsScreen })));
const PreviewScreen = lazy(() => import('@m/screens/PreviewScreen').then((m) => ({ default: m.PreviewScreen })));
const DebugScreen = lazy(() => import('@m/screens/DebugScreen').then((m) => ({ default: m.DebugScreen })));
const RemoteScreenScreen = lazy(() => import('@m/screens/RemoteScreenScreen').then((m) => ({ default: m.RemoteScreenScreen })));
const CatalogScreen = lazy(() => import('@m/screens/CatalogScreen').then((m) => ({ default: m.CatalogScreen })));

/** Route names mirror the workbench (/session/:id) so deep links and notifications work in both apps. */
function Gate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return <Splash />;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  // agent commands waiting for approval surface on every signed-in screen
  return <WebSocketProvider><Suspense fallback={<Splash />}>{children}</Suspense><ApprovalSheet /></WebSocketProvider>;
}

export default function App() {
  return (
    <BrowserRouter basename="/m">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/" element={<Gate><SessionsScreen /></Gate>} />
          <Route path="/session/:sessionId" element={<Gate><ChatScreen /></Gate>} />
          <Route path="/new" element={<Gate><ChatScreen /></Gate>} />
          <Route path="/settings" element={<Gate><SettingsScreen /></Gate>} />
          <Route path="/screen/:targetId" element={<Gate><RemoteScreenScreen /></Gate>} />
          <Route path="/preview" element={<Gate><PreviewScreen /></Gate>} />
          <Route path="/debug" element={<Gate><DebugScreen /></Gate>} />
          <Route path="/catalog" element={<Gate><CatalogScreen /></Gate>} />
          <Route path="/catalog/:agentId" element={<Gate><CatalogScreen /></Gate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
