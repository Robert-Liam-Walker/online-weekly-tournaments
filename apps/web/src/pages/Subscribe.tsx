import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";

export default function Subscribe() {
  const { isSubscribed } = useAuthStore();
  const [searchParams] = useSearchParams();
  const success = searchParams.get("session_id") !== null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startCheckout() {
    setError("");
    setLoading(true);
    try {
      const { data } = await api.post("/subscriptions/create-checkout");
      window.location.href = data.url;
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Failed to start checkout";
      setError(msg);
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="max-w-lg mx-auto p-6 text-center">
        <div className="bg-green-900/30 border border-green-700 rounded-xl p-10">
          <div className="text-5xl mb-4">🎮</div>
          <h1 className="text-3xl font-bold text-white mb-3">You're subscribed!</h1>
          <p className="text-gray-400 mb-6">
            Welcome to FoxTrot. You now have full access to the arena, challenges, tournaments, and friends list.
          </p>
          <Link
            to="/arena"
            className="inline-block bg-green-600 hover:bg-green-700 text-white font-semibold px-8 py-3 rounded-lg transition-colors"
          >
            Go to Arena
          </Link>
        </div>
      </div>
    );
  }

  if (isSubscribed()) {
    return (
      <div className="max-w-lg mx-auto p-6 text-center">
        <div className="bg-gray-800 rounded-xl p-10">
          <h1 className="text-2xl font-bold text-white mb-3">Already Subscribed</h1>
          <p className="text-gray-400 mb-6">
            Your subscription is active. Manage billing from Settings.
          </p>
          <Link
            to="/settings"
            className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors"
          >
            Go to Settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-2">Subscribe to FoxTrot</h1>
      <p className="text-gray-400 mb-8">
        Unlock the full competitive experience.
      </p>

      <div className="bg-gray-800 rounded-xl p-6 mb-6">
        <div className="flex items-baseline gap-1 mb-6">
          <span className="text-4xl font-bold text-white">$5</span>
          <span className="text-gray-400">/month</span>
        </div>

        <ul className="space-y-3 mb-8">
          {[
            "Join the PvP arena and challenge players",
            "Accept and play ranked matches",
            "Register for tournaments",
            "Friends list and direct match requests",
            "Full match history and leaderboards (coming soon)",
          ].map((feature) => (
            <li key={feature} className="flex items-start gap-3 text-gray-300 text-sm">
              <span className="text-green-400 mt-0.5">✓</span>
              {feature}
            </li>
          ))}
        </ul>

        {error && (
          <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2 mb-4">{error}</p>
        )}

        <button
          onClick={startCheckout}
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors"
        >
          {loading ? "Redirecting to Stripe..." : "Subscribe — $5/month"}
        </button>

        <p className="text-xs text-gray-500 text-center mt-3">
          Payments processed securely by Stripe. Cancel anytime.
        </p>
      </div>
    </div>
  );
}
