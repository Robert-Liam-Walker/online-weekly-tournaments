import { useState } from "react";
import { useArena } from "../hooks/useArena";
import { useAuthStore } from "../hooks/useAuth";
import { ArenaEntry, Format } from "../types";
import { api } from "../lib/api";

export default function Arena() {
  const { entries, isLoading, joinArena, leaveArena } = useArena();
  const { user, isSubscribed } = useAuthStore();
  const [inArena, setInArena] = useState(false);
  const [format, setFormat] = useState<Format>("BO3");
  const [note, setNote] = useState("");

  const myEntry = entries.find((e) => e.userId === user?.id);

  async function handleToggleArena() {
    if (myEntry) {
      await leaveArena.mutateAsync();
      setInArena(false);
    } else {
      await joinArena.mutateAsync({ format, note: note || undefined });
      setInArena(true);
    }
  }

  async function sendChallenge(entry: ArenaEntry) {
    await api.post("/challenges", {
      challengedId: entry.userId,
      format: entry.format,
    });
    alert(`Challenge sent to ${entry.user.username}! Open Slippi and wait for them to connect.`);
  }

  if (isLoading) {
    return <div className="p-8 text-center text-gray-400">Loading arena...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-2">PvP Arena</h1>
      <p className="text-gray-400 mb-6">
        List yourself as available to be challenged, or challenge someone else. Both players
        connect via Slippi direct mode using their connect codes.
      </p>

      {/* Arena controls */}
      {isSubscribed() ? (
        <div className="bg-gray-800 rounded-lg p-4 mb-6 flex flex-wrap gap-4 items-end">
          {!myEntry && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as Format)}
                  className="bg-gray-700 text-white rounded px-3 py-2"
                >
                  <option value="BO3">Best of 3</option>
                  <option value="BO5">Best of 5</option>
                </select>
              </div>
              <div className="flex-1 min-w-48">
                <label className="block text-sm text-gray-400 mb-1">Note (optional)</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Serious matches only, Fox/Falco"
                  className="w-full bg-gray-700 text-white rounded px-3 py-2"
                  maxLength={100}
                />
              </div>
            </>
          )}
          <button
            onClick={handleToggleArena}
            disabled={joinArena.isPending || leaveArena.isPending}
            className={`px-5 py-2 rounded font-semibold transition-colors ${
              myEntry
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-green-600 hover:bg-green-700 text-white"
            }`}
          >
            {myEntry ? "Leave Arena" : "Join Arena"}
          </button>
        </div>
      ) : (
        <div className="bg-yellow-900/40 border border-yellow-700 rounded-lg p-4 mb-6">
          <p className="text-yellow-300">
            Subscribe for $5/month to join the arena and challenge players.{" "}
            <a href="/subscribe" className="underline hover:text-yellow-200">
              Subscribe now
            </a>
          </p>
        </div>
      )}

      {/* Arena list */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-gray-300 text-sm">
            {entries.length} player{entries.length !== 1 ? "s" : ""} available
          </span>
        </div>

        {entries.length === 0 ? (
          <p className="text-gray-500 text-center py-12">
            No one is in the arena right now. Be the first!
          </p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="bg-gray-800 rounded-lg p-4 flex items-center justify-between"
            >
              <div>
                <div className="flex items-center gap-3">
                  <span className="text-white font-semibold">{entry.user.username}</span>
                  <span className="text-gray-400 text-sm font-mono">
                    {entry.user.connectCode}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      entry.format === "BO5"
                        ? "bg-purple-900 text-purple-300"
                        : "bg-blue-900 text-blue-300"
                    }`}
                  >
                    {entry.format === "BO5" ? "Best of 5" : "Best of 3"}
                  </span>
                </div>
                {entry.note && (
                  <p className="text-gray-400 text-sm mt-1">{entry.note}</p>
                )}
              </div>

              {entry.userId !== user?.id && isSubscribed() && (
                <button
                  onClick={() => sendChallenge(entry)}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-medium transition-colors"
                >
                  Challenge
                </button>
              )}
              {entry.userId === user?.id && (
                <span className="text-green-400 text-sm">You</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
