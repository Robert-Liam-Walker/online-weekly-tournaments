import { BrowserRouter, Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Arena from "./pages/Arena";
import Tournaments from "./pages/Tournaments";
import TournamentDetail from "./pages/TournamentDetail";
import Device from "./pages/Device";
import Login from "./pages/Login";
import Friends from "./pages/Friends";
import Feed from "./pages/Feed";
import Series from "./pages/Series";
import Subscribe from "./pages/Subscribe";
import Download from "./pages/Download";
import Settings from "./pages/Settings";
import Admin from "./pages/Admin";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import RequireAuth from "./components/RequireAuth";
import ChallengeNotification from "./components/ChallengeNotification";
import FoxIcon from "./components/FoxIcon";
import RankBadge from "./components/RankBadge";
import { useAuthStore } from "./hooks/useAuth";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

function Nav() {
  const { user, clearAuth } = useAuthStore();
  const navigate = useNavigate();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 rounded text-sm font-medium transition-colors ${
      isActive ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"
    }`;

  return (
    <nav className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center gap-2">
      <FoxIcon size={22} />
      <span className="text-white font-bold text-lg mr-4 ml-1.5">Randall's Nightly Tournaments</span>
      <NavLink to="/arena" className={linkClass}>Arena</NavLink>
      <NavLink to="/tournaments" className={linkClass}>Tournaments</NavLink>
      <NavLink to="/download" className={linkClass}>Download</NavLink>
      <NavLink to="/friends" className={linkClass}>Friends</NavLink>
      <NavLink to="/feed" className={linkClass}>Feed</NavLink>
      {user?.role === "ADMIN" && (
        <NavLink to="/admin" className={linkClass}>Admin</NavLink>
      )}
      <div className="ml-auto flex items-center gap-3">
        {user && (
          <span className="flex items-center gap-2">
            <span className="text-gray-400 text-sm font-mono">{user.connectCode}</span>
            <RankBadge connectCode={user.connectCode} />
          </span>
        )}
        {/* Free-only release: Stripe dormant. The /subscribe route stays
            reachable by URL (shows a coming-soon note) but is hidden from
            the nav until the $5/mo subscription (step 2) ships. */}
        <NavLink to="/settings" className={linkClass}>Settings</NavLink>
        {user && (
          <button
            onClick={() => { clearAuth(); navigate("/login"); }}
            className="text-gray-500 hover:text-gray-300 text-sm px-3 py-2"
          >
            Sign out
          </button>
        )}
      </div>
    </nav>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <Nav />
      <main className="py-8">{children}</main>
      <ChallengeNotification />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/download" element={<Download />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Layout>
                  <Routes>
                    <Route path="/" element={<Arena />} />
                    <Route path="/arena" element={<Arena />} />
                    <Route path="/tournaments" element={<Tournaments />} />
                    <Route path="/tournaments/:id" element={<TournamentDetail />} />
                    <Route path="/device" element={<Device />} />
                    <Route path="/friends" element={<Friends />} />
                    <Route path="/feed" element={<Feed />} />
                    <Route path="/tournaments/success" element={<Tournaments />} />
                    <Route path="/series/:id" element={<Series />} />
                    <Route path="/subscribe" element={<Subscribe />} />
                    <Route path="/subscribe/success" element={<Subscribe />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/admin" element={<Admin />} />
                  </Routes>
                </Layout>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
