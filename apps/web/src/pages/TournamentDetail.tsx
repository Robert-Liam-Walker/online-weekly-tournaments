import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { isKnownRegion, regionDate, regionTime, regionTimeShort, viewerTime } from "../lib/regions";
import { useAuthStore } from "../hooks/useAuth";
import {
  PreviewBracketMatch,
  ReplayVerification,
  TournamentDetail as TournamentDetailType,
  TournamentMatchDetail,
  TournamentReplay,
} from "../types";

// Mirrors the in-game bracket view: winners rounds as columns with grand
// finals topping the row, losers bracket below; winner green, loser red,
// ready white, undecided dimmed. Results reported from inside Melee arrive
// via the "tournament:update" socket event (slow polling kept as fallback).

const CHECKIN_OPENS_MINUTES_BEFORE = 30;
// A ready match with no result after this long is considered stuck and gets
// an admin override control.
const STUCK_MATCH_AFTER_MS = 10 * 60_000;

function apiError(err: unknown, fallback: string) {
  const msg = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof msg === "string" ? msg : fallback;
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

/** Convert the pre-start full bracket (TBD slots) into renderable sets.
 *  Nothing is decided yet: a fully-populated matchup reads as "ready" (white),
 *  any TBD slot reads as upcoming (dimmed). Mirrors the in-bracket GFR rule:
 *  the reset slot is hidden until both finalists exist. */
function previewToSets(preview: PreviewBracketMatch[]): BracketSet[] {
  const sets: BracketSet[] = [];
  for (const m of preview) {
    const p1Null = m.player1 == null;
    const p2Null = m.player2 == null;
    if (m.matchKey === "GFR" && (p1Null || p2Null)) continue;
    sets.push({
      key: m.matchKey,
      p1: m.player1?.username ?? "TBD",
      p2: m.player2?.username ?? "TBD",
      state: !p1Null && !p2Null ? 0 : 3,
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
      className={`rounded-md border px-2 py-1 text-xs leading-tight ${
        set.state === 0 ? "border-yellow-700 bg-gray-800" : "border-gray-700 bg-gray-800/60"
      }`}
      title={`${set.key}: ${set.p1} vs ${set.p2}`}
    >
      <div className={`${playerClass(set, 1)} truncate`}>{set.p1}</div>
      <div className={`${playerClass(set, 2)} truncate`}>{set.p2}</div>
    </div>
  );
}

// Each round is an equal-width flex column (flex-1 + min-w-0) so the whole
// bracket scales to the container — no horizontal scrolling. Long names
// truncate inside their card rather than forcing the row wider.
function BracketColumns({ sets, side }: { sets: BracketSet[]; side: "W" | "L" }) {
  const rounds = [...new Set(sets.filter((s) => s.key[0] === side).map((s) => s.key[1]))].sort();
  if (rounds.length === 0) return null;
  return (
    <>
      {rounds.map((r) => (
        <div key={side + r} className="flex-1 min-w-0 flex flex-col justify-around gap-1.5">
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

// ---------- Admin controls (rendered only for role === "ADMIN") ----------

/** Resolve a stuck set: both players known, ready for 10+ min, no result. */
function OverrideControl({
  tournamentId,
  match,
  names,
}: {
  tournamentId: string;
  match: TournamentMatchDetail;
  names: Map<string, string>;
}) {
  const queryClient = useQueryClient();
  const [winnerId, setWinnerId] = useState("");

  const override = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/tournaments/${tournamentId}/matches/${match.matchKey}/override`, {
          winnerId,
        })
      ).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tournament", tournamentId] }),
    onError: (err: unknown) => alert(apiError(err, "Override failed")),
  });

  const p1 = match.player1Id!;
  const p2 = match.player2Id!;

  return (
    <li className="flex items-center gap-3 flex-wrap bg-gray-900/60 rounded-lg px-3 py-2">
      <span className="text-gray-400 text-xs font-mono w-12 shrink-0">{match.matchKey}</span>
      <span className="text-gray-200 text-sm">
        {names.get(p1) ?? "?"} <span className="text-gray-500">vs</span> {names.get(p2) ?? "?"}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <select
          value={winnerId}
          onChange={(e) => setWinnerId(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-yellow-600"
        >
          <option value="">Winner…</option>
          <option value={p1}>{names.get(p1) ?? p1}</option>
          <option value={p2}>{names.get(p2) ?? p2}</option>
        </select>
        <button
          onClick={() => override.mutate()}
          disabled={!winnerId || override.isPending}
          className="bg-red-800 hover:bg-red-700 text-white text-xs font-semibold px-3 py-1.5 rounded disabled:opacity-50"
        >
          {override.isPending ? "Applying…" : "Apply"}
        </button>
      </div>
    </li>
  );
}

const verificationBadge: Record<ReplayVerification, string> = {
  PENDING: "bg-yellow-900 text-yellow-300",
  VERIFIED: "bg-green-900 text-green-300",
  MISMATCH: "bg-red-900 text-red-300",
  MANUAL_REVIEW: "bg-orange-900 text-orange-300",
};

const RESOLUTIONS: ReplayVerification[] = ["VERIFIED", "MISMATCH", "MANUAL_REVIEW"];

const resolveButtonStyle: Record<string, string> = {
  VERIFIED: "border-green-800 text-green-400 hover:bg-green-900/40",
  MISMATCH: "border-red-800 text-red-400 hover:bg-red-900/40",
  MANUAL_REVIEW: "border-orange-800 text-orange-400 hover:bg-orange-900/40",
};

/** Replays whose parsed result didn't auto-verify (PENDING/MISMATCH/…). */
function ReplayReviewsPanel({ tournamentId }: { tournamentId: string }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ replays: TournamentReplay[] }>({
    queryKey: ["replay-reviews", tournamentId],
    queryFn: async () => (await api.get(`/replays/reviews/${tournamentId}`)).data,
  });

  const resolve = useMutation({
    mutationFn: async (vars: { replayId: string; verification: ReplayVerification }) =>
      (
        await api.patch(`/replays/${vars.replayId}/resolve`, {
          verification: vars.verification,
        })
      ).data,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["replay-reviews", tournamentId] }),
    onError: (err: unknown) => alert(apiError(err, "Resolve failed")),
  });

  const replays = data?.replays ?? [];

  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <h3 className="text-white font-semibold mb-1">Replay reviews</h3>
      <p className="text-gray-500 text-xs mb-3">
        Uploaded replays whose parsed result did not auto-verify. Resolving as VERIFIED clears
        the replay from this queue.
      </p>
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : replays.length === 0 ? (
        <p className="text-gray-500 text-sm">Nothing to review.</p>
      ) : (
        <ul className="space-y-2">
          {replays.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-3 flex-wrap bg-gray-900/60 rounded-lg px-3 py-2"
            >
              <span className="text-gray-400 text-xs font-mono w-12 shrink-0">{r.matchKey}</span>
              <div className="min-w-0">
                <p className="text-gray-200 text-sm truncate" title={r.fileName}>
                  {r.fileName}
                </p>
                <p className="text-gray-500 text-xs">
                  Parsed winner: {r.parsedWinnerName ?? "unknown"}
                </p>
              </div>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${verificationBadge[r.verification]}`}
              >
                {r.verification.replace("_", " ")}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                {RESOLUTIONS.map((v) => (
                  <button
                    key={v}
                    onClick={() => resolve.mutate({ replayId: r.id, verification: v })}
                    disabled={resolve.isPending || r.verification === v}
                    className={`border rounded px-2 py-1 text-[10px] font-semibold disabled:opacity-40 ${resolveButtonStyle[v]}`}
                  >
                    {v.replace("_", " ")}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function TournamentDetail({ id: idProp }: { id?: string } = {}) {
  // Rendered both at /tournament (id resolved by the parent, passed as a prop)
  // and — for legacy/deep links — at /tournaments/:id via the route param.
  const params = useParams<{ id: string }>();
  const id = idProp ?? params.id;
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const { data: t, isLoading } = useQuery<TournamentDetailType>({
    queryKey: ["tournament", id],
    queryFn: async () => (await api.get(`/tournaments/${id}`)).data,
    refetchInterval: 30000, // fallback only — socket pushes drive updates
  });

  // Push-based updates: refetch when the API signals a change to this event
  useEffect(() => {
    if (!id) return;
    const socket = getSocket();
    const onUpdate = (payload: { tournamentId: string; kind: string }) => {
      if (payload.tournamentId === id) {
        queryClient.invalidateQueries({ queryKey: ["tournament", id] });
      }
    };
    socket.on("tournament:update", onUpdate);
    return () => { socket.off("tournament:update", onUpdate); };
  }, [id, queryClient]);

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

  // Admin: disqualify an entrant (server is authoritative — requireAdmin).
  const dq = useMutation({
    mutationFn: async (entrantUserId: string) =>
      (await api.post(`/tournaments/${id}/entries/${entrantUserId}/dq`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tournament", id] }),
    onError: (err: unknown) => alert(apiError(err, "DQ failed")),
  });

  if (isLoading || !t) {
    return <p className="text-gray-400 p-6">Loading tournament…</p>;
  }

  // Defensive: role may be missing from older /auth/me payloads → not admin.
  const isAdmin = user?.role === "ADMIN";
  // Older rows have no region (or an unrecognized one) → plain local date.
  const region = isKnownRegion(t.region) ? t.region : null;
  const viewerLocalLine = region ? viewerTime(t.scheduledAt, region) : null;
  const myEntry = user ? t.entries.find((e) => e.userId === user.id) : undefined;
  const checkinOpensAt =
    new Date(t.scheduledAt).getTime() - CHECKIN_OPENS_MINUTES_BEFORE * 60_000;
  const checkinOpen = t.status === "REGISTRATION" && Date.now() >= checkinOpensAt;
  // Before the bracket is generated the API sends the full skeleton with TBD
  // slots (fullBracket); once it's live the persisted matches drive the view.
  const sets =
    t.fullBracket && t.fullBracket.length > 0
      ? previewToSets(t.fullBracket)
      : buildBracketSets(t);
  const gfSets = sets.filter((s) => s.key[0] === "G");
  const entrantNames = new Map(t.entries.map((e) => [e.userId, e.user.username]));
  const stuckMatches =
    isAdmin && t.status === "ACTIVE"
      ? t.matches.filter(
          (m) =>
            m.player1Id != null &&
            m.player2Id != null &&
            m.winnerId == null &&
            m.readyAt != null &&
            Date.now() - new Date(m.readyAt).getTime() > STUCK_MATCH_AFTER_MS
        )
      : [];

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-white">{t.name}</h1>
          {region && (
            <span className="text-gray-200 text-sm font-semibold">
              {regionTimeShort(t.scheduledAt, region)}
            </span>
          )}
        </div>
        {region ? (
          // Dual-timezone rule: always the region's local time; the viewer's
          // own time appended only when their wall clock differs.
          <p className="text-gray-400 text-sm mt-1">
            {regionDate(t.scheduledAt, region)} · {regionTime(t.scheduledAt, region)}
            {viewerLocalLine && <span className="text-gray-500"> · {viewerLocalLine}</span>}
          </p>
        ) : (
          <p className="text-gray-400 text-sm mt-1">{formatDate(t.scheduledAt)}</p>
        )}
        {t.description && <p className="text-gray-400 text-sm mt-1">{t.description}</p>}
        <p className="text-gray-500 text-xs mt-2">
          Playable from inside Melee. Download the .zip → Unzip → Run Dolphin → Online Play
          → Press A to Register. You'll be matched up with your opponent at 8PM sharp!
        </p>
      </div>

      {t.status === "REGISTRATION" && !user && (
        <Link
          to="/login"
          className="inline-block bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg"
        >
          Log in to register
        </Link>
      )}

      {t.status === "REGISTRATION" && user && (
        <div className="flex items-center gap-3 flex-wrap">
          {!myEntry ? (
            t.entryFee === 0 ? (
              <button
                onClick={() => register.mutate()}
                disabled={register.isPending}
                className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {register.isPending ? "Registering…" : "Register"}
              </button>
            ) : (
              // Free-only release: Stripe is dormant, so legacy paid rows
              // expose no checkout entry point.
              <span className="text-gray-500 text-sm">
                Paid entry returns with subscriptions.
              </span>
            )
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
                  <span
                    className={
                      e.dqAt
                        ? "text-gray-500 line-through"
                        : e.userId === user?.id
                          ? "text-yellow-300"
                          : "text-gray-200"
                    }
                  >
                    {e.user.username}
                  </span>
                  {e.dqAt && (
                    <span className="text-red-500 text-[10px] font-semibold">DQ</span>
                  )}
                  {e.placement === 1 && <span>🏆</span>}
                  {e.placement != null && e.placement > 1 && (
                    <span className="text-gray-400 text-xs">#{e.placement}</span>
                  )}
                  {e.checkedInAt && t.status === "REGISTRATION" && (
                    <span className="text-green-500 text-xs">✓</span>
                  )}
                  {isAdmin &&
                    !e.dqAt &&
                    (t.status === "REGISTRATION" || t.status === "ACTIVE") && (
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `Disqualify ${e.user.username}? Mid-bracket, all their open matches are forfeited to the opponent.`
                            )
                          ) {
                            dq.mutate(e.userId);
                          }
                        }}
                        disabled={dq.isPending}
                        title="Disqualify"
                        className="ml-auto shrink-0 border border-red-900 hover:border-red-700 text-red-400 hover:text-red-300 rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-50"
                      >
                        {dq.isPending && dq.variables === e.userId ? "…" : "DQ"}
                      </button>
                    )}
                </li>
              ))}
            {t.entries.length === 0 && <li className="text-gray-500 text-sm">No entrants yet</li>}
          </ul>
        </div>

        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
          <h2 className="text-white font-semibold mb-3">Bracket</h2>
          {sets.length === 0 ? (
            <p className="text-gray-500 text-sm">The bracket generates when the tournament starts.</p>
          ) : (
            <div className="space-y-6">
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Winners</p>
                <div className="flex gap-2 items-stretch">
                  <BracketColumns sets={sets} side="W" />
                  {gfSets.length > 0 && (
                    // Center the GF card in the column so it lines up with the
                    // winners-final (W4) card; the label floats above, out of
                    // flow, so it doesn't push the card off-center.
                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                      <div className="relative flex flex-col gap-1.5">
                        <span className="absolute bottom-full mb-1 left-0 right-0 text-yellow-500/80 text-[10px] uppercase tracking-wide truncate">
                          Grand finals
                        </span>
                        {gfSets.map((s) => (
                          <SetCard key={s.key} set={s} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Losers</p>
                <div className="flex gap-2 items-stretch">
                  <BracketColumns sets={sets} side="L" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {isAdmin && (
        <div className="space-y-4">
          <h2 className="text-red-400/90 font-semibold text-xs uppercase tracking-wider">
            Admin controls
          </h2>
          {t.status === "ACTIVE" && (
            <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
              <h3 className="text-white font-semibold mb-1">Stuck matches</h3>
              <p className="text-gray-500 text-xs mb-3">
                Sets ready for 10+ minutes with no reported result. Overriding awards the set —
                use it only when the players cannot finish.
              </p>
              {stuckMatches.length === 0 ? (
                <p className="text-gray-500 text-sm">None right now.</p>
              ) : (
                <ul className="space-y-2">
                  {stuckMatches.map((m) => (
                    <OverrideControl
                      key={m.matchKey}
                      tournamentId={t.id}
                      match={m}
                      names={entrantNames}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
          <ReplayReviewsPanel tournamentId={t.id} />
        </div>
      )}
    </div>
  );
}
