import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, WebSocketProvider, useAuth } from '@/modules/chat-core';
import { ChatScreen } from '@m/screens/ChatScreen';
import { LoginScreen } from '@m/screens/LoginScreen';
import { SessionsScreen } from '@m/screens/SessionsScreen';
import { SettingsScreen } from '@m/screens/SettingsScreen';
import { RemoteScreenScreen } from '@m/screens/RemoteScreenScreen';
import { Splash } from '@m/components/Splash';
import { ApprovalSheet } from '@m/components/ApprovalSheet';

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
  return <WebSocketProvider>{children}<ApprovalSheet /></WebSocketProvider>;
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
