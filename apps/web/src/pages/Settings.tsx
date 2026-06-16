import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";
import {
  saveSlippiFolder,
  loadSlippiFolder,
  clearSlippiFolder,
} from "../lib/slippiFolder";

const supportsFileSystemAccess = "showDirectoryPicker" in window;

interface UserProfile {
  id: string;
  username: string;
  email: string;
  subscriptionStatus: string;
  subscriptionEndsAt?: string;
  createdAt: string;
}

export default function Settings() {
  const { isSubscribed } = useAuthStore();
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState("");
  const [folderName, setFolderName] = useState<string | null>(null);

  useEffect(() => {
    if (!supportsFileSystemAccess) return;
    loadSlippiFolder().then((h) => setFolderName(h?.name ?? null));
  }, []);

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
            label="Member Since"
            value={new Date(profile.createdAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          />
        </dl>
      </div>

      {/* Slippi folder */}
      {supportsFileSystemAccess && (
        <div className="bg-gray-800 rounded-xl p-6 mb-4">
          <h2 className="text-white font-semibold mb-1">Slippi Replays Folder</h2>
          <p className="text-gray-400 text-sm mb-4">
            Connect your Slippi replays folder and Nightly Tournament Service will automatically detect game results during a series — no uploads needed.
          </p>
          {folderName ? (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400" />
                <span className="text-green-300 text-sm font-medium">{folderName}</span>
              </div>
              <button
                onClick={async () => {
                  await clearSlippiFolder();
                  setFolderName(null);
                }}
                className="text-gray-500 hover:text-red-400 text-sm transition-colors ml-auto"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={async () => {
                try {
                  const handle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
                  await saveSlippiFolder(handle);
                  setFolderName(handle.name);
                } catch {
                  // User cancelled
                }
              }}
              className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
            >
              Connect Folder
            </button>
          )}
        </div>
      )}

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
