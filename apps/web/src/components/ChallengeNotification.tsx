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
      <p className="text-white font-bold text-lg mb-0.5">{active.challenger.username}</p>
      <p className="text-gray-400 text-sm font-mono mb-1">{active.challenger.connectCode}</p>
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
