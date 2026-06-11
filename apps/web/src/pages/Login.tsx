import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";

export default function Login() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();

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
              connectCode: (form.get("connectCode") as string)?.toUpperCase(),
            };

      const { data } = await api.post(`/auth/${tab}`, payload);
      setAuth(data.user, data.token);
      navigate("/arena");
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
        <h1 className="text-4xl font-bold text-white text-center mb-2">FoxTrot</h1>
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
                  maxLength={30}
                  className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                  placeholder="ssbmplayer"
                />
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

            {tab === "register" && (
              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  Slippi Connect Code
                </label>
                <input
                  name="connectCode"
                  type="text"
                  required
                  className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-blue-500 focus:outline-none font-mono uppercase"
                  placeholder="FOXT#123"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Found in Slippi Launcher → Settings. Format: ABCD#123
                </p>
              </div>
            )}

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
        </div>
      </div>
    </div>
  );
}
