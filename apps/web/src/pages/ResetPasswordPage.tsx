import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

// Landing page for the emailed reset link (/reset-password?token=...).
// Trades the single-use token for a new password.
export default function ResetPasswordPage() {
  // Read once on mount — the token never changes for the life of the page.
  const [token] = useState(
    () => new URLSearchParams(window.location.search).get("token") ?? ""
  );
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(e.currentTarget);

    try {
      await api.post("/auth/reset-password", {
        token,
        newPassword: form.get("password"),
      });
      setDone(true);
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
        <h1 className="text-4xl font-bold text-white text-center mb-2">Nightly Tournaments</h1>
        <p className="text-gray-400 text-center mb-8">Choose a new password</p>

        <div className="bg-gray-900 rounded-xl p-8">
          {!token ? (
            <div>
              <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2">
                This reset link is missing its token. Use the link from your email, or
                request a new one.
              </p>
              <p className="text-center text-sm text-gray-500 mt-6">
                <Link to="/forgot-password" className="text-blue-400 hover:text-blue-300">
                  Request a new reset link
                </Link>
              </p>
            </div>
          ) : done ? (
            <div className="bg-green-900/40 border border-green-700 rounded-xl p-4">
              <p className="text-green-300 font-medium">✓ Password updated</p>
              <p className="text-gray-400 text-sm mt-1">
                Your password has been changed.{" "}
                <Link to="/login" className="text-blue-400 hover:text-blue-300">
                  Sign in
                </Link>{" "}
                with the new one.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">New password</label>
                <input
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  className="w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
                  placeholder="••••••••"
                />
                <p className="text-xs text-gray-500 mt-1">At least 8 characters.</p>
              </div>

              {error && (
                <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2">
                  {error}{" "}
                  {error.toLowerCase().includes("expired") && (
                    <Link
                      to="/forgot-password"
                      className="text-blue-400 hover:text-blue-300"
                    >
                      Request a new link
                    </Link>
                  )}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors"
              >
                {loading ? "..." : "Set new password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
