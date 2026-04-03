import { BrowserRouter, Routes, Route, NavLink, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Arena from "./pages/Arena";
import Tournaments from "./pages/Tournaments";
import Login from "./pages/Login";
import RequireAuth from "./components/RequireAuth";
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
      <span className="text-white font-bold text-lg mr-4">FoxTrot</span>
      <NavLink to="/arena" className={linkClass}>Arena</NavLink>
      <NavLink to="/tournaments" className={linkClass}>Tournaments</NavLink>
      <NavLink to="/friends" className={linkClass}>Friends</NavLink>
      <div className="ml-auto flex items-center gap-3">
        {user && (
          <span className="text-gray-400 text-sm font-mono">{user.connectCode}</span>
        )}
        <NavLink to="/subscribe" className={linkClass}>Subscribe</NavLink>
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
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Layout>
                  <Routes>
                    <Route path="/" element={<Arena />} />
                    <Route path="/arena" element={<Arena />} />
                    <Route path="/tournaments" element={<Tournaments />} />
                    <Route
                      path="/friends"
                      element={<div className="p-8 text-center text-gray-400">Friends — coming soon</div>}
                    />
                    <Route
                      path="/subscribe"
                      element={<div className="p-8 text-center text-gray-400">Subscribe — coming soon</div>}
                    />
                    <Route
                      path="/settings"
                      element={<div className="p-8 text-center text-gray-400">Settings — coming soon</div>}
                    />
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
