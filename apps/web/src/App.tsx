import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Tournaments from "./pages/Tournaments";
import TournamentDetail from "./pages/TournamentDetail";
import WeeklyTournament from "./pages/WeeklyTournament";
import Device from "./pages/Device";
import Login from "./pages/Login";
import Series from "./pages/Series";
import Subscribe from "./pages/Subscribe";
import Download from "./pages/Download";
import About from "./pages/About";
import Gameplay from "./pages/Gameplay";
import Profile from "./pages/Profile";
import Admin from "./pages/Admin";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import RequireAuth from "./components/RequireAuth";
import RandallIcon from "./components/RandallIcon";
import Messenger from "./components/Messenger";
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
      <RandallIcon size={22} />
      <span className="text-white font-bold text-lg mr-4 ml-1.5">Online Weekly Tournament Series</span>
      <NavLink to="/tournament" className={linkClass}>Tournament</NavLink>
      <NavLink to="/download" className={linkClass}>Download</NavLink>
      <NavLink to="/gameplay" className={linkClass}>How to Play</NavLink>
      <NavLink to="/about" className={linkClass}>About</NavLink>
      {user?.role === "ADMIN" && (
        <NavLink to="/admin" className={linkClass}>Admin</NavLink>
      )}
      <div className="ml-auto flex items-center gap-3">
        {user ? (
          <>
            <span className="text-gray-400 text-sm font-medium">{user.username}</span>
            {/* Free-only release: Stripe dormant. /subscribe stays reachable by
                URL (coming-soon note) but is hidden from the nav until the
                subscription tier ships. */}
            <NavLink to="/profile" className={linkClass}>Profile</NavLink>
            <button
              onClick={() => { clearAuth(); navigate("/login"); }}
              className="text-gray-500 hover:text-gray-300 text-sm px-3 py-2"
            >
              Sign out
            </button>
          </>
        ) : (
          <NavLink to="/login" className={linkClass}>Log in</NavLink>
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
      <Messenger />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* No sign-in wall: every visitor (signed in or not) lands on the
              single weekly tournament at /tournament. The bracket is public;
              auth-only actions prompt login. Download shares the same header
              so visitors can move between the two. */}
          <Route path="/" element={<Navigate to="/tournament" replace />} />
          <Route path="/tournament" element={<Layout><WeeklyTournament /></Layout>} />
          {/* Secondary: view a specific event by id (admin tools, deep links). */}
          <Route path="/tournaments/:id" element={<Layout><TournamentDetail /></Layout>} />
          <Route path="/download" element={<Layout><Download /></Layout>} />
          <Route path="/gameplay" element={<Layout><Gameplay /></Layout>} />
          <Route path="/about" element={<Layout><About /></Layout>} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Layout>
                  <Routes>
                    <Route path="/device" element={<Device />} />
                    <Route path="/tournaments/success" element={<Tournaments />} />
                    <Route path="/series/:id" element={<Series />} />
                    <Route path="/subscribe" element={<Subscribe />} />
                    <Route path="/subscribe/success" element={<Subscribe />} />
                    <Route path="/profile" element={<Profile />} />
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
