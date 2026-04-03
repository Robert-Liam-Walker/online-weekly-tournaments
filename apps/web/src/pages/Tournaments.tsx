import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tournament } from "../types";
import { api } from "../lib/api";

const PRIZE_SPLIT = { first: 50, second: 25, third: 10, platform: 15 };

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

function PrizeBreakdown({ prizePool }: { prizePool: number }) {
  if (prizePool === 0) return <p className="text-gray-500 text-xs">Prize pool grows as players enter</p>;
  return (
    <div className="flex gap-3 text-xs mt-1">
      <span className="text-yellow-300">🥇 {dollars(Math.floor(prizePool * PRIZE_SPLIT.first / 100))}</span>
      <span className="text-gray-300">🥈 {dollars(Math.floor(prizePool * PRIZE_SPLIT.second / 100))}</span>
      <span className="text-gray-400">🥉 {dollars(Math.floor(prizePool * PRIZE_SPLIT.third / 100))}</span>
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
            <h2 className="text-white font-bold text-lg">{t.name}</h2>
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
            <span>{formatDate(t.scheduledAt)}</span>
            <span>·</span>
            <span>{t.format === "DOUBLE_ELIM" ? "Double Elim" : "Single Elim"}</span>
            <span>·</span>
            <span>{t.seriesFormat === "BO5" ? "Best of 5" : "Best of 3"}</span>
            <span>·</span>
            <span>{entrantCount}/{t.maxEntrants} players</span>
          </div>

          {isPaid && <PrizeBreakdown prizePool={t.prizePool} />}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${
            t.status === "REGISTRATION" ? "bg-blue-900 text-blue-300"
            : t.status === "ACTIVE" ? "bg-yellow-900 text-yellow-300"
            : t.status === "COMPLETED" ? "bg-gray-700 text-gray-400"
            : "bg-gray-700 text-gray-400"
          }`}>
            {t.status === "REGISTRATION" ? "Open" : t.status === "ACTIVE" ? "Live" : t.status}
          </span>

          {t.status === "REGISTRATION" && (
            <button
              onClick={() => onRegister(t)}
              disabled={registering}
              className={`px-4 py-2 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 ${
                isPaid
                  ? "bg-yellow-600 hover:bg-yellow-500 text-white"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
              }`}
            >
              {registering ? "..." : isPaid ? `Enter — ${dollars(t.entryFee)}` : "Register Free"}
            </button>
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
      <p className="text-green-300 font-medium">You're registered! See you Saturday.</p>
    </div>
  );
}

export default function Tournaments() {
  const queryClient = useQueryClient();
  const [registeringId, setRegisteringId] = useState<string | null>(null);

  const { data: tournaments = [], isLoading } = useQuery<Tournament[]>({
    queryKey: ["tournaments"],
    queryFn: () => api.get("/tournaments").then((r) => r.data),
  });

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

  const free = tournaments.filter((t) => t.entryFee === 0);
  const paid = tournaments.filter((t) => t.entryFee > 0);

  if (isLoading) {
    return <div className="p-8 text-center text-gray-400">Loading tournaments...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-1">Weekly Tournaments</h1>
      <p className="text-gray-400 mb-6">
        Two tournaments every Saturday — one free, one paid with a prize pool.
      </p>

      <SuccessBanner />

      {/* Paid */}
      {paid.length > 0 && (
        <section className="mb-8">
          <h2 className="text-yellow-400 font-semibold text-sm uppercase tracking-wider mb-3">
            Paid — Prize Pool
          </h2>
          <div className="space-y-4">
            {paid.map((t) => (
              <TournamentCard
                key={t.id}
                t={t}
                onRegister={(t) => register.mutate(t)}
                registering={registeringId === t.id}
              />
            ))}
          </div>
          <p className="text-gray-600 text-xs mt-3">
            Prize split: 50% 1st · 25% 2nd · 10% 3rd · 15% platform fee.
            Payouts processed manually within 48h of tournament completion.
          </p>
        </section>
      )}

      {/* Free */}
      {free.length > 0 && (
        <section className="mb-8">
          <h2 className="text-green-400 font-semibold text-sm uppercase tracking-wider mb-3">
            Free — Open to All
          </h2>
          <div className="space-y-4">
            {free.map((t) => (
              <TournamentCard
                key={t.id}
                t={t}
                onRegister={(t) => register.mutate(t)}
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
