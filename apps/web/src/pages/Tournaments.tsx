import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tournament } from "../types";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { useAuthStore } from "../hooks/useAuth";
import {
  REGIONS,
  REGION_ORDER,
  TournamentRegion,
  isKnownRegion,
  regionDate,
  regionTime,
  viewerTime,
} from "../lib/regions";

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(0)}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusPill({ status }: { status: Tournament["status"] }) {
  return (
    <span
      className={`text-xs px-2 py-1 rounded-full font-medium ${
        status === "REGISTRATION"
          ? "bg-blue-900 text-blue-300"
          : status === "ACTIVE"
            ? "bg-yellow-900 text-yellow-300"
            : "bg-gray-700 text-gray-400"
      }`}
    >
      {status === "REGISTRATION" ? "Open" : status === "ACTIVE" ? "Live" : status}
    </span>
  );
}

/** Register button / registered / checked-in / full / bracket link state. */
function NightlyCardActions({ t, onRegister, registering }: {
  t: Tournament;
  onRegister: (t: Tournament) => void;
  registering: boolean;
}) {
  const live = t.status === "ACTIVE";
  const detailLink = (label: string) => (
    <Link to={`/tournaments/${t.id}`} className="text-blue-400 hover:text-blue-300 text-sm underline">
      {label}
    </Link>
  );

  if (t.viewerCheckedIn) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-green-400 text-sm font-medium">✓ Checked in</span>
        {detailLink(live ? "View Bracket" : "Event page")}
      </div>
    );
  }

  if (t.viewerRegistered) {
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-green-400 text-sm font-medium">✓ Registered</span>
          {detailLink(live ? "View Bracket" : "Check in")}
        </div>
        {t.status === "REGISTRATION" && (
          <p className="text-gray-500 text-xs mt-1.5">
            Check in on the event page from 30 min before start.
          </p>
        )}
      </div>
    );
  }

  if (live) {
    return <div className="flex justify-end">{detailLink("View Bracket")}</div>;
  }

  const entrantCount = t._count?.entries ?? 0;
  const full = entrantCount >= t.maxEntrants;

  if (t.status === "REGISTRATION" && !full && t.entryFee === 0) {
    return (
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => onRegister(t)}
          disabled={registering}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50"
        >
          {registering ? "..." : "Register Free"}
        </button>
        {detailLink("Details")}
      </div>
    );
  }

  if (t.status === "REGISTRATION" && full) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-yellow-300/90 text-sm font-medium">Bracket full</span>
        {detailLink("Details")}
      </div>
    );
  }

  return <div className="flex justify-end">{detailLink("Details")}</div>;
}

/** Hero card for one region's weekly event: dual-timezone display rule —
 *  always the REGION's local time, plus the viewer's local time when it
 *  differs (suppressed when the wall clocks match). */
function NightlyCard({ t, region, onRegister, registering }: {
  t: Tournament;
  region: TournamentRegion;
  onRegister: (t: Tournament) => void;
  registering: boolean;
}) {
  const entrantCount = t._count?.entries ?? 0;
  const full = entrantCount >= t.maxEntrants;
  const localLine = viewerTime(t.scheduledAt, region);

  return (
    <div
      className={`bg-gray-800 rounded-xl p-5 border flex flex-col gap-3 ${
        t.status === "ACTIVE" ? "border-yellow-700" : "border-gray-700"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-gray-400 font-semibold text-xs uppercase tracking-wider">
          {REGIONS[region].label}
        </span>
        <StatusPill status={t.status} />
      </div>

      <div>
        <Link
          to={`/tournaments/${t.id}`}
          className="text-white font-bold text-lg leading-snug hover:text-yellow-300"
        >
          {t.name}
        </Link>
        <p className="text-gray-500 text-xs mt-0.5">{regionDate(t.scheduledAt, region)}</p>
      </div>

      <div>
        <p className="text-white text-sm font-medium">{regionTime(t.scheduledAt, region)}</p>
        {localLine && <p className="text-gray-400 text-sm">{localLine}</p>}
      </div>

      <p className={`text-sm ${full ? "text-yellow-300/90" : "text-gray-400"}`}>
        {entrantCount}/{t.maxEntrants} entrants
      </p>

      <div className="mt-auto pt-1">
        <NightlyCardActions t={t} onRegister={onRegister} registering={registering} />
      </div>
    </div>
  );
}

function TournamentCard({ t, onRegister, registering }: {
  t: Tournament;
  onRegister: (t: Tournament) => void;
  registering: boolean;
}) {
  const isPaid = t.entryFee > 0;
  const entrantCount = t._count?.entries ?? 0;

  return (
    <div className={`bg-gray-800 rounded-xl p-5 border ${isPaid ? "border-yellow-800" : "border-gray-700"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Link to={`/tournaments/${t.id}`} className="text-white font-bold text-lg hover:text-yellow-300">{t.name}</Link>
            {isPaid ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-900 text-yellow-300 font-medium">
                {dollars(t.entryFee)} Entry
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-900 text-green-300 font-medium">
                Free
              </span>
            )}
          </div>

          {t.description && (
            <p className="text-gray-400 text-sm mb-2">{t.description}</p>
          )}

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-gray-400 mb-2">
            {isKnownRegion(t.region) && (
              <>
                <span>{REGIONS[t.region].label}</span>
                <span>·</span>
              </>
            )}
            <span>{formatDate(t.scheduledAt)}</span>
            <span>·</span>
            <span>{t.format === "DOUBLE_ELIM" ? "Double Elim" : "Single Elim"}</span>
            <span>·</span>
            <span>{t.seriesFormat === "BO5" ? "Best of 5" : "Best of 3"}</span>
            <span>·</span>
            <span>{entrantCount}/{t.maxEntrants} players</span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <StatusPill status={t.status} />

          {t.status === "REGISTRATION" && (
            t.viewerRegistered ? (
              <span className="text-green-400 text-sm font-medium">
                {t.viewerCheckedIn ? "✓ Checked in" : "✓ Registered"}
              </span>
            ) : !isPaid ? (
              <button
                onClick={() => onRegister(t)}
                disabled={registering}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50"
              >
                {registering ? "..." : "Register Free"}
              </button>
            ) : (
              // Stripe is dormant for the free-only release: legacy paid rows
              // never expose a checkout entry point.
              <span className="text-gray-500 text-xs text-right">
                Paid entry returns with subscriptions
              </span>
            )
          )}

          {(t.status === "ACTIVE" || t.status === "COMPLETED") && (
            <Link to={`/tournaments/${t.id}`} className="text-blue-400 hover:text-blue-300 text-sm underline">
              View Bracket
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function SuccessBanner() {
  const [params] = useSearchParams();
  if (!params.get("tournament_id")) return null;
  return (
    <div className="bg-green-900/40 border border-green-700 rounded-xl p-4 mb-6">
      <p className="text-green-300 font-medium">You're registered! See you Friday.</p>
    </div>
  );
}

export default function Tournaments() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [registeringId, setRegisteringId] = useState<string | null>(null);

  // Logged-out visitors can browse + view brackets; registering needs an account.
  const handleRegister = (t: Tournament) => {
    if (!user) {
      navigate("/login");
      return;
    }
    register.mutate(t);
  };

  const { data: tournaments = [], isLoading } = useQuery<Tournament[]>({
    queryKey: ["tournaments"],
    queryFn: () => api.get("/tournaments").then((r) => r.data),
  });

  // Any tournament state change refreshes the list (entrant counts, status)
  useEffect(() => {
    const socket = getSocket();
    const onUpdate = () => queryClient.invalidateQueries({ queryKey: ["tournaments"] });
    socket.on("tournament:update", onUpdate);
    return () => { socket.off("tournament:update", onUpdate); };
  }, [queryClient]);

  const register = useMutation({
    mutationFn: async (t: Tournament) => {
      const { data } = await api.post(`/tournaments/${t.id}/register`);
      return data;
    },
    onMutate: (t) => setRegisteringId(t.id),
    onSettled: () => setRegisteringId(null),
    onSuccess: (data) => {
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        queryClient.invalidateQueries({ queryKey: ["tournaments"] });
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Registration failed";
      alert(msg);
    },
  });

  // Tonight's grid: the next not-yet-finished event per known region.
  // Rows without a recognized region (older data, or the API change not
  // deployed yet) never reach the hero grid — they stay in the list below.
  const weekly = useMemo(() => {
    const next = new Map<TournamentRegion, Tournament>();
    const candidates = tournaments
      .filter(
        (t) =>
          isKnownRegion(t.region) &&
          (t.status === "UPCOMING" || t.status === "REGISTRATION" || t.status === "ACTIVE")
      )
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
    for (const t of candidates) {
      const region = t.region as TournamentRegion;
      if (!next.has(region)) next.set(region, t);
    }
    return REGION_ORDER.flatMap((region) => {
      const t = next.get(region);
      return t ? [{ region, t }] : [];
    });
  }, [tournaments]);

  const nightlyIds = new Set(weekly.map(({ t }) => t.id));
  const rest = tournaments.filter((t) => !nightlyIds.has(t.id));

  if (isLoading) {
    return <div className="p-8 text-center text-gray-400">Loading tournaments...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-1">Online Weekly Tournament Series</h1>
      <p className="text-gray-400 mb-6">
        A free 16-player bracket every Friday at 8 PM Eastern.
      </p>

      <SuccessBanner />

      {/* Tonight's regional events */}
      {weekly.length > 0 && (
        <section className="mb-10">
          <h2 className="text-green-400 font-semibold text-sm uppercase tracking-wider mb-3">
            This Friday — Free, Open to All
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {weekly.map(({ region, t }) => (
              <NightlyCard
                key={t.id}
                t={t}
                region={region}
                onRegister={handleRegister}
                registering={registeringId === t.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* Everything else: past nightlies, region-less legacy rows, admin tests */}
      {rest.length > 0 && (
        <section className="mb-8">
          <h2 className="text-gray-400 font-semibold text-sm uppercase tracking-wider mb-3">
            {weekly.length > 0 ? "Other Tournaments" : "Tournaments"}
          </h2>
          <div className="space-y-4">
            {rest.map((t) => (
              <TournamentCard
                key={t.id}
                t={t}
                onRegister={handleRegister}
                registering={registeringId === t.id}
              />
            ))}
          </div>
        </section>
      )}

      {tournaments.length === 0 && (
        <p className="text-gray-500 text-center py-16">No tournaments scheduled yet.</p>
      )}
    </div>
  );
}
