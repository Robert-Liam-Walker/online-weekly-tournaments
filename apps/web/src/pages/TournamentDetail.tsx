import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";
import { TournamentDetail as TournamentDetailType } from "../types";

// Mirrors the in-game bracket view: winners rounds as columns with grand
// finals topping the row, losers bracket below; winner green, loser red,
// ready white, undecided dimmed. Polls so results reported from inside
// Melee appear here within seconds.

const CHECKIN_OPENS_MINUTES_BEFORE = 30;

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    REGISTRATION: "bg-blue-900 text-blue-300",
    ACTIVE: "bg-green-900 text-green-300",
    COMPLETED: "bg-gray-700 text-gray-300",
    CANCELED: "bg-red-900 text-red-300",
    UPCOMING: "bg-gray-700 text-gray-300",
  };
  return styles[status] ?? "bg-gray-700 text-gray-300";
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

type BracketSet = {
  key: string;
  p1: string;
  p2: string;
  state: 0 | 1 | 2 | 3; // ready, p1 won, p2 won, upcoming
};

/** Same filtering rules as the in-game view (Dolphin's BracketWorker) */
function buildBracketSets(t: TournamentDetailType): BracketSet[] {
  const names = new Map(t.entries.map((e) => [e.userId, e.user.username]));
  const sets: BracketSet[] = [];
  for (const m of t.matches) {
    const p1Null = m.player1Id == null;
    const p2Null = m.player2Id == null;
    const done = m.winnerId != null;
    if (done && (p1Null || p2Null)) continue; // bye auto-completion
    if ((p1Null || p2Null) && m.matchKey === "GFR") continue;
    sets.push({
      key: m.matchKey,
      p1: p1Null ? "TBD" : (names.get(m.player1Id!) ?? "?"),
      p2: p2Null ? "TBD" : (names.get(m.player2Id!) ?? "?"),
      state: done ? (m.winnerId === m.player1Id ? 1 : 2) : p1Null || p2Null ? 3 : 0,
    });
  }
  return sets;
}

function playerClass(set: BracketSet, which: 1 | 2) {
  if (set.state === 3) return "text-gray-500";
  if (set.state === 0) return "text-white";
  const won = set.state === which;
  return won ? "text-green-400 font-semibold" : "text-red-400";
}

function SetCard({ set }: { set: BracketSet }) {
  return (
    <div
      className={`rounded-lg border px-3 py-1.5 text-sm min-w-[7.5rem] ${
        set.state === 0 ? "border-yellow-700 bg-gray-800" : "border-gray-700 bg-gray-800/60"
      }`}
      title={set.key}
    >
      <div className={playerClass(set, 1)}>{set.p1}</div>
      <div className={playerClass(set, 2)}>{set.p2}</div>
    </div>
  );
}

function BracketColumns({ sets, side }: { sets: BracketSet[]; side: "W" | "L" }) {
  const rounds = [...new Set(sets.filter((s) => s.key[0] === side).map((s) => s.key[1]))].sort();
  if (rounds.length === 0) return null;
  return (
    <>
      {rounds.map((r) => (
        <div key={side + r} className="flex flex-col justify-around gap-2">
          {sets
            .filter((s) => s.key[0] === side && s.key[1] === r)
            .map((s) => (
              <SetCard key={s.key} set={s} />
            ))}
        </div>
      ))}
    </>
  );
}

export default function TournamentDetail() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const { data: t, isLoading } = useQuery<TournamentDetailType>({
    queryKey: ["tournament", id],
    queryFn: async () => (await api.get(`/tournaments/${id}`)).data,
    refetchInterval: 5000, // live mirror of what the game sees
  });

  const register = useMutation({
    mutationFn: async () => (await api.post(`/tournaments/${id}/register`)).data,
    onSuccess: (data) => {
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
      else queryClient.invalidateQueries({ queryKey: ["tournament", id] });
    },
  });

  const checkin = useMutation({
    mutationFn: async () => (await api.post(`/tournaments/${id}/checkin`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tournament", id] }),
  });

  if (isLoading || !t) {
    return <p className="text-gray-400 p-6">Loading tournament…</p>;
  }

  const myEntry = user ? t.entries.find((e) => e.userId === user.id) : undefined;
  const checkinOpensAt =
    new Date(t.scheduledAt).getTime() - CHECKIN_OPENS_MINUTES_BEFORE * 60_000;
  const checkinOpen = t.status === "REGISTRATION" && Date.now() >= checkinOpensAt;
  const sets = buildBracketSets(t);
  const gfSets = sets.filter((s) => s.key[0] === "G");

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <Link to="/tournaments" className="text-gray-400 text-sm hover:text-white">
          ← Tournaments
        </Link>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <h1 className="text-2xl font-bold text-white">{t.name}</h1>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge(t.status)}`}>
            {t.status}
          </span>
        </div>
        <p className="text-gray-400 text-sm mt-1">{formatDate(t.scheduledAt)}</p>
        {t.description && <p className="text-gray-400 text-sm mt-1">{t.description}</p>}
        <p className="text-gray-500 text-xs mt-2">
          Playable from inside Melee: FoxTrot Dolphin → Online Play → Find Tournament
        </p>
      </div>

      {t.status === "REGISTRATION" && (
        <div className="flex items-center gap-3 flex-wrap">
          {!myEntry ? (
            <button
              onClick={() => register.mutate()}
              disabled={register.isPending}
              className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {register.isPending ? "Registering…" : t.entryFee > 0 ? "Register (paid)" : "Register"}
            </button>
          ) : !myEntry.checkedInAt ? (
            <button
              onClick={() => checkin.mutate()}
              disabled={!checkinOpen || checkin.isPending}
              className="bg-yellow-700 hover:bg-yellow-600 text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {checkinOpen ? (checkin.isPending ? "Checking in…" : "Check in") : "Check-in opens 30 min before start"}
            </button>
          ) : (
            <span className="text-green-400 text-sm font-medium">✓ Checked in</span>
          )}
          {(register.isError || checkin.isError) && (
            <span className="text-red-400 text-sm">
              {((register.error ?? checkin.error) as any)?.response?.data?.error ?? "Something went wrong"}
            </span>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-[16rem_1fr] gap-6">
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 h-fit">
          <h2 className="text-white font-semibold mb-3">
            Entrants ({t.entries.length}/{t.maxEntrants})
          </h2>
          <ul className="space-y-1.5">
            {[...t.entries]
              .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99))
              .map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-sm">
                  <span className="text-gray-500 w-5 text-right">{e.seed ?? "–"}</span>
                  <span className={e.userId === user?.id ? "text-yellow-300" : "text-gray-200"}>
                    {e.user.username}
                  </span>
                  {e.placement === 1 && <span>🏆</span>}
                  {e.placement != null && e.placement > 1 && (
                    <span className="text-gray-400 text-xs">#{e.placement}</span>
                  )}
                  {e.checkedInAt && t.status === "REGISTRATION" && (
                    <span className="text-green-500 text-xs">✓</span>
                  )}
                </li>
              ))}
            {t.entries.length === 0 && <li className="text-gray-500 text-sm">No entrants yet</li>}
          </ul>
        </div>

        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 overflow-x-auto">
          <h2 className="text-white font-semibold mb-3">Bracket</h2>
          {sets.length === 0 ? (
            <p className="text-gray-500 text-sm">The bracket generates when the tournament starts.</p>
          ) : (
            <div className="space-y-6 min-w-fit">
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Winners</p>
                <div className="flex gap-4 items-stretch">
                  <BracketColumns sets={sets} side="W" />
                  {gfSets.length > 0 && (
                    <div className="flex flex-col justify-start gap-2">
                      <p className="text-yellow-500/80 text-[10px] uppercase tracking-wide -mb-1">
                        Grand finals
                      </p>
                      {gfSets.map((s) => (
                        <SetCard key={s.key} set={s} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Losers</p>
                <div className="flex gap-4 items-stretch">
                  <BracketColumns sets={sets} side="L" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
