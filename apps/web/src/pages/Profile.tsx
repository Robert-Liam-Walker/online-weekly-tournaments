import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";
import { Tournament } from "../types";
import { isKnownRegion, regionDate, regionTimeShort } from "../lib/regions";
import InGameName from "../components/InGameName";

interface UserProfile {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  subscriptionStatus: string;
  subscriptionEndsAt?: string;
  createdAt: string;
}

function whenLabel(t: Tournament): string {
  if (isKnownRegion(t.region)) {
    return `${regionDate(t.scheduledAt, t.region)} · ${regionTimeShort(t.scheduledAt, t.region)}`;
  }
  return new Date(t.scheduledAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Profile() {
  const { isSubscribed } = useAuthStore();
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState("");

  const { data: profile, isLoading } = useQuery<UserProfile>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me").then((r) => r.data),
  });
  const { data: tournaments = [] } = useQuery<Tournament[]>({
    queryKey: ["tournaments"],
    queryFn: () => api.get("/tournaments").then((r) => r.data),
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

  // The next tournament: soonest still-open/upcoming event, else one in progress.
  const bySoonest = (a: Tournament, b: Tournament) =>
    new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  const next =
    [...tournaments]
      .filter((t) => t.status === "REGISTRATION" || t.status === "UPCOMING")
      .sort(bySoonest)[0] ?? tournaments.find((t) => t.status === "ACTIVE");

  const statusColors: Record<string, string> = {
    ACTIVE: "bg-green-900 text-green-300",
    FREE: "bg-gray-700 text-gray-300",
    PAST_DUE: "bg-yellow-900 text-yellow-300",
    CANCELED: "bg-red-900 text-red-300",
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-6">Profile</h1>

      {/* Account */}
      <div className="bg-gray-800 rounded-xl p-6 mb-4">
        <h2 className="text-white font-semibold mb-4">Profile</h2>
        <dl className="space-y-3">
          <Row label="Username" value={profile.username} />
          <Row label="Email" value={profile.email} />
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

      {/* Next tournament */}
      <div className="bg-gray-800 rounded-xl p-6 mb-4">
        <h2 className="text-white font-semibold mb-3">Next tournament</h2>
        {next ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Link to="/tournament" className="text-white font-semibold hover:text-yellow-300">
                {next.name}
              </Link>
              <p className="text-gray-400 text-sm">{whenLabel(next)}</p>
            </div>
            <Link
              to="/tournament"
              className="text-blue-400 hover:text-blue-300 text-sm underline shrink-0"
            >
              View bracket
            </Link>
          </div>
        ) : (
          <p className="text-gray-400 text-sm">
            No tournament scheduled yet — a new nightly bracket opens every evening.
          </p>
        )}
      </div>

      {/* In-game name (the ABCD12 identity shown in Dolphin + brackets) */}
      <InGameName current={profile.displayName} />

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
          // Free-only release: Stripe dormant, no upgrade CTA. The $5/mo
          // subscription (ranked mode + more) ships as step 2.
          <p className="text-gray-400 text-sm">
            Subscriptions are coming soon. Nightly tournaments are free for
            everyone while we launch.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0">
      <dt className="text-gray-400 text-sm">{label}</dt>
      <dd className="text-gray-200 text-sm">{value}</dd>
    </div>
  );
}
