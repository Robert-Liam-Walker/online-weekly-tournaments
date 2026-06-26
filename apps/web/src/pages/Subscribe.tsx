import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";

// Free-only release: Stripe is fully dormant and this page is hidden from
// the nav (still reachable by URL). Flip this flag when the $5/mo
// subscription ships as step 2 — the checkout flow below is kept intact,
// just unreachable until then.
const SUBSCRIPTIONS_LIVE: boolean = false;

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
            Welcome to the Online Weekly Tournament Series. You now have full access to the weekly tournaments.
          </p>
          <Link
            to="/tournament"
            className="inline-block bg-green-600 hover:bg-green-700 text-white font-semibold px-8 py-3 rounded-lg transition-colors"
          >
            Go to Tournament
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
      <h1 className="text-3xl font-bold text-white mb-2">Subscriptions — coming soon</h1>
      <p className="text-gray-400 mb-8">
        The weekly tournaments are free for everyone while we launch.
      </p>

      <div className="bg-gray-800 rounded-xl p-6 mb-6">
        <div className="flex items-baseline gap-1 mb-6">
          <span className="text-4xl font-bold text-white">$5</span>
          <span className="text-gray-400">/month</span>
          <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-900 text-blue-300 font-medium">
            Coming soon
          </span>
        </div>

        <ul className="space-y-3 mb-8">
          {[
            "Ranked mode",
            "Join the PvP arena and challenge players",
            "Friends list and direct match requests",
            "Full match history and leaderboards",
          ].map((feature) => (
            <li key={feature} className="flex items-start gap-3 text-gray-300 text-sm">
              <span className="text-green-400 mt-0.5">✓</span>
              {feature}
            </li>
          ))}
        </ul>

        {SUBSCRIPTIONS_LIVE ? (
          <>
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
          </>
        ) : (
          <>
            <p className="text-gray-400 text-sm bg-gray-900/60 rounded-lg px-3 py-2.5">
              Checkout isn't open yet. For now, every weekly tournament is free —{" "}
              <Link to="/tournament" className="text-blue-400 hover:text-blue-300 underline">
                grab a spot in this Friday's bracket
              </Link>
              .
            </p>
            <p className="text-xs text-gray-500 text-center mt-3">
              No payment is collected anywhere on the site during the free launch.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
