import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";
import { useAuthStore } from "../hooks/useAuth";
import { Series as SeriesType } from "../types";

interface Game {
  id: string;
  gameNumber: number;
  winnerId: string;
  createdAt: string;
}

interface SeriesDetail extends SeriesType {
  games: Game[];
}

export default function SeriesPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "verified" | "error">("idle");
  const [uploadError, setUploadError] = useState("");

  const { data: series, isLoading } = useQuery<SeriesDetail>({
    queryKey: ["series", id],
    queryFn: () => api.get(`/series/${id}`).then((r) => r.data),
    enabled: !!id,
  });

  // Real-time series updates
  useEffect(() => {
    const socket = getSocket();
    socket.on("series:update", (updated: SeriesType) => {
      if (updated.id === id) {
        queryClient.setQueryData(["series", id], (old: SeriesDetail | undefined) =>
          old ? { ...old, ...updated } : old
        );
      }
    });
    return () => { socket.off("series:update"); };
  }, [id, queryClient]);

  if (isLoading) {
    return <div className="p-8 text-center text-gray-400">Loading series...</div>;
  }

  if (!series) {
    return <div className="p-8 text-center text-gray-400">Series not found.</div>;
  }

  const isParticipant = user?.id === series.player1Id || user?.id === series.player2Id;
  const opponent = user?.id === series.player1Id ? series.player2 : series.player1;
  const myWins = user?.id === series.player1Id ? series.p1Wins : series.p2Wins;
  const theirWins = user?.id === series.player1Id ? series.p2Wins : series.p1Wins;
  const winsNeeded = series.format === "BO5" ? 3 : 2;

  async function uploadReplay() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploadStatus("uploading");
    setUploadError("");
    try {
      const form = new FormData();
      form.append("file", file);
      await api.post(`/series/${id}/replay`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setUploadStatus("verified");
      queryClient.invalidateQueries({ queryKey: ["series", id] });
      if (fileRef.current) fileRef.current.value = "";
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "Verification failed";
      setUploadStatus("error");
      setUploadError(msg);
    }
  }

  const isCompleted = series.status === "COMPLETED";
  const winner = isCompleted
    ? series.winnerId === series.player1Id
      ? series.player1
      : series.player2
    : null;

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-4">
        <Link to="/arena" className="text-gray-400 hover:text-white text-sm">← Back to Arena</Link>
      </div>

      <div className="bg-gray-800 rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-white">
            {series.format === "BO5" ? "Best of 5" : "Best of 3"} Series
          </h1>
          <span
            className={`text-xs px-3 py-1 rounded-full font-medium ${
              isCompleted
                ? "bg-green-900 text-green-300"
                : "bg-yellow-900 text-yellow-300"
            }`}
          >
            {isCompleted ? "Completed" : "In Progress"}
          </span>
        </div>

        {/* Score display */}
        <div className="flex items-center justify-center gap-8 py-6">
          <div className="text-center">
            <p className="text-gray-400 text-sm mb-1">{series.player1.username}</p>
            <p className="text-5xl font-bold text-white">{series.p1Wins}</p>
            <p className="text-gray-500 text-xs font-mono mt-1">{series.player1.connectCode}</p>
          </div>
          <div className="text-gray-600 text-2xl font-light">vs</div>
          <div className="text-center">
            <p className="text-gray-400 text-sm mb-1">{series.player2.username}</p>
            <p className="text-5xl font-bold text-white">{series.p2Wins}</p>
            <p className="text-gray-500 text-xs font-mono mt-1">{series.player2.connectCode}</p>
          </div>
        </div>

        {isCompleted && winner && (
          <div className="text-center py-3 bg-green-900/30 rounded-lg border border-green-800">
            <p className="text-green-300 font-semibold">
              {winner.username} wins the series!
            </p>
          </div>
        )}

        {!isCompleted && isParticipant && (
          <div className="text-center text-gray-400 text-sm">
            First to {winsNeeded} wins • You: {myWins} — Opponent: {theirWins}
          </div>
        )}
      </div>

      {/* Game history */}
      {series.games.length > 0 && (
        <div className="bg-gray-800 rounded-xl p-6 mb-6">
          <h2 className="text-white font-semibold mb-3">Game History</h2>
          <div className="space-y-2">
            {series.games.map((game) => {
              const gameWinner =
                game.winnerId === series.player1Id ? series.player1 : series.player2;
              return (
                <div
                  key={game.id}
                  className="flex items-center justify-between text-sm py-2 border-b border-gray-700 last:border-0"
                >
                  <span className="text-gray-400">Game {game.gameNumber}</span>
                  <span className="text-white font-medium">{gameWinner.username} wins</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Replay upload — primary way to record game results */}
      {!isCompleted && isParticipant && (
        <div className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-white font-semibold mb-1">Submit Game Result</h2>
          <p className="text-gray-400 text-sm mb-4">
            After each game, either player uploads the <span className="font-mono">.slp</span> replay file.
            FoxTrot reads the result directly from the replay — no self-reporting needed.
          </p>
          <div className="flex gap-3 items-center flex-wrap">
            <input
              ref={fileRef}
              type="file"
              accept=".slp"
              className="text-sm text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-gray-700 file:text-white hover:file:bg-gray-600"
            />
            <button
              onClick={uploadReplay}
              disabled={uploadStatus === "uploading"}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              {uploadStatus === "uploading" ? "Reading replay..." : "Submit"}
            </button>
          </div>
          {uploadStatus === "verified" && (
            <p className="text-green-400 text-sm mt-3">Game recorded from replay.</p>
          )}
          {uploadStatus === "error" && (
            <p className="text-red-400 text-sm mt-3">{uploadError}</p>
          )}
        </div>
      )}
    </div>
  );
}
