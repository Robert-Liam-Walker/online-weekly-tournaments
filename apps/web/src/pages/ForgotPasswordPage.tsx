/**
 * ForgotPasswordPage
 *
 * Route:    /forgot-password  (public, no auth wrapper in App.tsx)
 * Auth:     Public — no RequireAuth.
 *
 * Purpose:  Step 1 of the password-reset flow. User enters their email; the
 *           API queues a reset email if the address exists. The API always
 *           returns 200 regardless of whether the email is registered (no
 *           user enumeration), so the UI always shows the same success
 *           message after submission.
 *
 * Data dependencies:
 *   - POST /auth/forgot-password  — body: { email }; always 200 on success
 *
 * UI states:
 *   - idle: email input + submit button.
 *   - loading: button disabled, shows "...".
 *   - sent: replaces form with green "check your inbox" confirmation.
 *   - error: red error message above the submit button (network/server
 *     failures only — a valid email submission always shows sent state).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(e.currentTarget);

    try {
      await api.post("/auth/forgot-password", { email: form.get("email") });
      setSent(true);
    } catch {
      setError("Something went wrong — please try again in a few minutes.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="text-4xl font-bold text-white text-center mb-2">Randall's Nightly Tournaments</h1>
        <p className="text-gray-400 text-center mb-8">Reset your password</p>

        <div className="bg-gray-900 rounded-xl p-8">
          {sent ? (
            <div className="bg-green-900/40 border border-green-700 rounded-xl p-4">
              <p className="text-green-300 font-medium">✓ Check your inbox</p>
              <p className="text-gray-400 text-sm mt-1">
                If an account exists for that email, a reset link is on its way. The link
                expires in 60 minutes.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-gray-400 text-sm">
                Enter the email you signed up with and we&apos;ll send you a link to reset
                your password.
              </p>

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
                {loading ? "..." : "Send reset link"}
              </button>
            </form>
          )}

          <p className="text-center text-sm text-gray-500 mt-6">
            Remembered it?{" "}
            <Link to="/login" className="text-blue-400 hover:text-blue-300">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
