/**
 * App.tsx — root of the React application.
 *
 * ROUTING MAP
 * ──────────────────────────────────────────────────────────────────────────
 * Public (no auth required):
 *   /              → Home (see below)
 *   /login         → Login page
 *   /forgot-password → ForgotPasswordPage
 *   /reset-password  → ResetPasswordPage
 *   /download      → Download page
 *   /terms         → Terms of Service
 *   /privacy       → Privacy Policy
 *
 * "/" split (Home component):
 *   - No token  → Landing (public marketing page, no Nav/Layout)
 *   - Has token → RequireAuth → Layout + Arena (validates token via /auth/me)
 *
 * RequireAuth-gated (catch-all "/*", renders inside Layout with Nav):
 *   /arena                → Arena (lobby)
 *   /tournaments          → Tournament list
 *   /tournaments/:id      → TournamentDetail
 *   /tournaments/success  → Tournaments (post-payment return; no dedicated page)
 *   /series/:id           → Series (match room)
 *   /device               → Device (Slippi folder setup)
 *   /friends              → Friends
 *   /feed                 → Activity feed
 *   /subscribe            → Subscribe (Stripe landing — dormant; see note)
 *   /subscribe/success    → Subscribe (post-Stripe return)
 *   /settings             → Settings
 *   /admin                → Admin (rendered for all authed users; the page
 *                           itself enforces the ADMIN role check)
 *
 * ADMIN nav link: rendered only when user.role === "ADMIN".
 *
 * STRIPE NOTE: The /subscribe route is live by URL but hidden from the Nav.
 * Stripe integration ships with step 2 (paid $5/mo tier). Until then
 * Subscribe shows a coming-soon message and the subscription flag stays FREE.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * QUERYCLIENT CONFIG
 *   retry: false — react-query will not auto-retry failed requests.
 *   All other defaults apply (staleTime: 0, gcTime: 5 min, etc.).
 *
 * LAYOUT
 *   Layout wraps authed pages with <Nav> (top bar) and <ChallengeNotification>
 *   (global fixed-position challenge toast). Public pages render without it.
 */

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
import Landing from "./pages/Landing";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import RequireAuth from "./components/RequireAuth";
import ChallengeNotification from "./components/ChallengeNotification";
import RandallIcon from "./components/RandallIcon";
import { useAuthStore } from "./hooks/useAuth";

/**
 * Shared QueryClient instance.
 * retry:false — API errors surface immediately rather than being retried.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

/**
 * Nav — top navigation bar, rendered inside all authed Layout pages.
 *
 * Shows: logo + app name, main nav links (Arena, Tournaments, Download,
 * Friends, Feed), Admin link (ADMIN role only), current username, Settings,
 * and a Sign-out button.
 *
 * The /subscribe link is intentionally absent — see Stripe note above.
 */
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
          <span className="text-gray-400 text-sm font-medium">{user.username}</span>
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

/**
 * Layout — shell for all authed pages.
 * Renders Nav at the top, page content in <main>, and the global
 * ChallengeNotification overlay (fixed-position, outside the scroll flow).
 */
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <Nav />
      <main className="py-8">{children}</main>
      <ChallengeNotification />
    </div>
  );
}

/**
 * Home — handles the "/" route split.
 *
 * Logged-out (no token in store): renders the public Landing page directly,
 * with no Nav or Layout wrapper — purely a marketing surface.
 *
 * Logged-in (token present): wraps Arena in RequireAuth + Layout, so the
 * token is verified against /auth/me before rendering. RequireAuth will
 * redirect to /login if the token turns out to be stale.
 */
function Home() {
  const token = useAuthStore((s) => s.token);
  if (!token) {
    return <Landing />;
  }
  return (
    <RequireAuth>
      <Layout>
        <Arena />
      </Layout>
    </RequireAuth>
  );
}

/** Root application component. Provides QueryClient + BrowserRouter context. */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
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
