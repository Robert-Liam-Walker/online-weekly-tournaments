import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";

export default function Login() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();
  const location = useLocation();
  // RequireAuth stashes the page the user was trying to reach (e.g. the device
  // link approval at /device?code=…). Return there after login so the
  // pre-filled code survives the login bounce; default to the arena.
  const from = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  const redirectTo = from?.pathname ? from.pathname + (from.search ?? "") : "/arena";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(e.currentTarget);

    try {
      const payload =
        tab === "login"
          ? { email: form.get("email"), password: form.get("password") }
          : {
              email: form.get("email"),
              password: form.get("password"),
              username: form.get("username"),
            };

      const { data } = await api.post(`/auth/${tab}`, payload);
      setAuth(data.user, data.token);
      navigate(redirectTo, { replace: true });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? "Something went wrong";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="text-4xl font-bold text-white text-center mb-2">Randall's Nightly Tournaments</h1>
        <p className="text-gray-400 text-center mb-8">Competitive Slippi Platform</p>

        <div className="bg-gray-900 rounded-xl p-8">
          {/* Tabs */}
          <div className="flex mb-6 bg-gray-800 rounded-lg p-1">
            {(["login", "register"] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setTab(t); setError(""); }}
                className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors capitalize ${
                  tab === t ? "bg-gray-600 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {tab === "register" && (
              <div>
                <label className="block text-sm text-gray-400 mb-1">Username</label>
                <input
                  name="username"
                  type="text"
                  required
                  minLength={3}
                  maxLength={15}
                  pattern="[A-Za-z0-9]{3,15}"
                  className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                  placeholder="ssbmplayer"
                />
                <p className="text-xs text-gray-500 mt-1">
                  3-15 letters or numbers - shown in-game and on brackets
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm text-gray-400 mb-1">Email</label>
              <input
                name="email"
                type="email"
                required
                className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Password</label>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                placeholder="••••••••"
              />
              {tab === "login" && (
                <div className="text-right mt-1.5">
                  <Link
                    to="/forgot-password"
                    className="text-xs text-gray-400 hover:text-white"
                  >
                    Forgot password?
                  </Link>
                </div>
              )}
            </div>

            {error && (
              <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors"
            >
              {loading ? "..." : tab === "login" ? "Sign In" : "Create Account"}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-4">
            New here?{" "}
            <Link to="/download" className="text-green-500 hover:text-green-400">
              Download the game
            </Link>{" "}
            and play tonight.
          </p>
        </div>
      </div>
    </div>
  );
}
