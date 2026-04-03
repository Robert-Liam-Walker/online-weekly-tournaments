import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";

interface UserProfile {
  id: string;
  username: string;
  email: string;
  connectCode: string;
  subscriptionStatus: string;
  subscriptionEndsAt?: string;
  createdAt: string;
}

export default function Settings() {
  const { isSubscribed } = useAuthStore();
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState("");

  const { data: profile, isLoading } = useQuery<UserProfile>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me").then((r) => r.data),
  });

  async function openBillingPortal() {
    setPortalError("");
    setPortalLoading(true);
    try {
      const { data } = await api.post("/subscriptions/portal");
      window.location.href = data.url;
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Failed to open billing portal";
      setPortalError(msg);
      setPortalLoading(false);
    }
  }

  if (isLoading) {
    return <div className="p-8 text-center text-gray-400">Loading...</div>;
  }

  if (!profile) return null;

  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-900 text-green-300",
    FREE: "bg-gray-700 text-gray-300",
    PAST_DUE: "bg-yellow-900 text-yellow-300",
    CANCELED: "bg-red-900 text-red-300",
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-6">Settings</h1>

      {/* Profile */}
      <div className="bg-gray-800 rounded-xl p-6 mb-4">
        <h2 className="text-white font-semibold mb-4">Profile</h2>
        <dl className="space-y-3">
          <Row label="Username" value={profile.username} />
          <Row label="Email" value={profile.email} />
          <Row
            label="Connect Code"
            value={<span className="font-mono text-white">{profile.connectCode}</span>}
          />
          <Row
            label="Member Since"
            value={new Date(profile.createdAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          />
        </dl>
      </div>

      {/* Subscription */}
      <div className="bg-gray-800 rounded-xl p-6">
        <h2 className="text-white font-semibold mb-4">Subscription</h2>

        <div className="flex items-center gap-3 mb-4">
          <span
            className={`text-xs px-3 py-1 rounded-full font-medium ${
              statusColors[profile.subscriptionStatus] ?? "bg-gray-700 text-gray-300"
            }`}
          >
            {profile.subscriptionStatus}
          </span>
          {profile.subscriptionEndsAt && (
            <span className="text-gray-400 text-sm">
              {profile.subscriptionStatus === "CANCELED" ? "Ends" : "Renews"}{" "}
              {new Date(profile.subscriptionEndsAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {isSubscribed() ? (
          <div>
            <p className="text-gray-400 text-sm mb-4">
              Manage your billing, update your payment method, or cancel your subscription through Stripe.
            </p>
            {portalError && (
              <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2 mb-3">
                {portalError}
              </p>
            )}
            <button
              onClick={openBillingPortal}
              disabled={portalLoading}
              className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
            >
              {portalLoading ? "Opening..." : "Manage Billing"}
            </button>
          </div>
        ) : (
          <div>
            <p className="text-gray-400 text-sm mb-4">
              Subscribe to unlock the arena, challenges, tournaments, and friends.
            </p>
            <Link
              to="/subscribe"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-lg transition-colors"
            >
              Subscribe — $5/month
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0">
      <dt className="text-gray-400 text-sm">{label}</dt>
      <dd className="text-gray-200 text-sm">{value}</dd>
    </div>
  );
}
