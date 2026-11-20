import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { AdminModerationPage } from './features/comments/AdminModerationPage';
import { DownloadsPage } from './features/downloads/DownloadsPage';
import { MeetingLobbyPage } from './features/meetings/MeetingLobbyPage';
import { MeetingRoomPage } from './features/meetings/MeetingRoomPage';
import { HomePage } from './features/player/HomePage';
import { WatchPage } from './features/player/WatchPage';
import { PlansPage } from './features/subscriptions/PlansPage';
import { SubscriptionDashboardPage } from './features/subscriptions/SubscriptionDashboardPage';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { SecurityPage } from './pages/SecurityPage';

/** `/`: signed-in users get the catalog; visitors get the public landing page. */
function Home() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="center-page">
        <div className="spinner" />
      </div>
    );
  }
  return user ? <HomePage /> : <LandingPage />;
}

export function App() {
  return (
    <Routes>
      {/* The meeting room is full-screen, outside the main chrome. */}
      <Route path="/meet/:roomCode" element={<RequireAuth><MeetingRoomPage /></RequireAuth>} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/watch/:videoId" element={<RequireAuth><WatchPage /></RequireAuth>} />
        <Route path="/plans" element={<PlansPage />} />
        <Route path="/subscription" element={<RequireAuth><SubscriptionDashboardPage /></RequireAuth>} />
        <Route path="/downloads" element={<RequireAuth><DownloadsPage /></RequireAuth>} />
        <Route path="/meet" element={<RequireAuth><MeetingLobbyPage /></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
        <Route path="/security" element={<RequireAuth><SecurityPage /></RequireAuth>} />
        <Route path="/admin/moderation" element={<RequireAuth admin><AdminModerationPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
