/**
 * ChallengeNotification — global realtime challenge toast.
 *
 * PURPOSE
 *   Renders a fixed-position card (bottom-right) when the current user has
 *   an incoming challenge waiting for a response. Shows one challenge at a
 *   time (the oldest pending one). Provides Accept / Decline actions.
 *
 * PROPS
 *   None. Reads the current user from useAuthStore and registers socket
 *   listeners unconditionally; skips network calls when user is null.
 *
 * WHERE USED
 *   Mounted once inside Layout (App.tsx), so it is present on every authed
 *   page and persists across client-side navigations.
 *
 * KEY BEHAVIOR
 *   Polling:
 *     Polls GET /challenges/pending every 15 s while user is logged in.
 *     On mount (or after an accept/decline) the oldest pending challenge from
 *     the poll response is shown if no challenge is currently active.
 *
 *   Socket events:
 *     "challenge:receive" — a new challenge arrived; invalidates the pending
 *       query and sets the active toast if none is showing.
 *     "challenge:accepted" — the challenger's client accepted our outgoing
 *       challenge; clears the toast and navigates to /series/:id.
 *       (This fires on the CHALLENGER's side, not the receiver's.)
 *
 *   Accept flow:
 *     PATCH /challenges/:id/accept → clears toast, invalidates query,
 *     navigates to /series/:seriesId from the response.
 *
 *   Decline flow:
 *     PATCH /challenges/:id/decline → clears toast, invalidates query.
 *
 *   While either action is in-flight, `responding` disables both buttons to
 *   prevent double-submission.
 *
 *   If no active challenge, renders null (no DOM node).
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { Challenge } from "../types";
import { useAuthStore } from "../hooks/useAuth";

export default function ChallengeNotification() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<Challenge | null>(null);
  const [responding, setResponding] = useState(false);

  /** Poll for pending challenges every 15 s; only runs when logged in. */
  const { data: pending = [] } = useQuery<Challenge[]>({
    queryKey: ["challenges", "pending"],
    queryFn: () => api.get("/challenges/pending").then((r) => r.data),
    refetchInterval: 15_000,
    enabled: !!user,
  });

  // Show oldest pending challenge that isn't already active
  useEffect(() => {
    if (!active && pending.length > 0) {
      setActive(pending[0]);
    }
  }, [pending, active]);

  // Listen for real-time incoming challenges
  useEffect(() => {
    if (!user) return;
    const socket = getSocket();

    socket.on("challenge:receive", (challenge: Challenge) => {
      queryClient.invalidateQueries({ queryKey: ["challenges", "pending"] });
      setActive((prev) => prev ?? challenge);
    });

    socket.on("challenge:accepted", ({ series }: { series: { id: string } }) => {
      setActive(null);
      navigate(`/series/${series.id}`);
    });

    return () => {
      socket.off("challenge:receive");
      socket.off("challenge:accepted");
    };
  }, [user, navigate, queryClient]);

  /** Accept the active challenge. Navigates to the created series on success. */
  async function accept() {
    if (!active) return;
    setResponding(true);
    try {
      const { data } = await api.patch(`/challenges/${active.id}/accept`);
      setActive(null);
      queryClient.invalidateQueries({ queryKey: ["challenges", "pending"] });
      navigate(`/series/${data.series.id}`);
    } finally {
      setResponding(false);
    }
  }

  /** Decline the active challenge. */
  async function decline() {
    if (!active) return;
    setResponding(true);
    try {
      await api.patch(`/challenges/${active.id}/decline`);
      setActive(null);
      queryClient.invalidateQueries({ queryKey: ["challenges", "pending"] });
    } finally {
      setResponding(false);
    }
  }

  if (!active) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl p-5 w-80">
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Incoming Challenge</p>
      <p className="text-white font-bold text-lg mb-1">{active.challenger.username}</p>
      <span
        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
          active.format === "BO5"
            ? "bg-purple-900 text-purple-300"
            : "bg-blue-900 text-blue-300"
        }`}
      >
        {active.format === "BO5" ? "Best of 5" : "Best of 3"}
      </span>
      <p className="text-gray-400 text-xs mt-2 mb-4">
        Open Slippi and connect via direct mode before accepting.
      </p>
      <div className="flex gap-2">
        <button
          onClick={accept}
          disabled={responding}
          className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-2 rounded-lg transition-colors"
        >
          Accept
        </button>
        <button
          onClick={decline}
          disabled={responding}
          className="flex-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-semibold py-2 rounded-lg transition-colors"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
