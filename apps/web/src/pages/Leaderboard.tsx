import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

// Old-school arcade "HIGH SCORES" screen: pure black, 8-bit bitmap font,
// usernames ranked by tournament wins (championships), descending. Public.

type Leader = { userId: string; username: string; wins: number };

// Classic arcade palette: top three get gold / silver / bronze-ish neon,
// the rest cycle cool neon colors so the board reads like a CRT high-score list.
const RANK_COLOR = ["#ffe600", "#7df9ff", "#ff77ff"];
const REST_COLORS = ["#39ff14", "#00e5ff", "#ff6ec7", "#f5a623"];

function rankColor(i: number) {
  return i < RANK_COLOR.length ? RANK_COLOR[i] : REST_COLORS[i % REST_COLORS.length];
}

/** Arcade names are uppercase; clamp long usernames so the row never wraps. */
function arcadeName(name: string) {
  const up = name.toUpperCase();
  return up.length > 12 ? up.slice(0, 11) + "…" : up;
}

export default function Leaderboard() {
  const { data, isLoading, isError } = useQuery<{ leaders: Leader[] }>({
    queryKey: ["leaderboard"],
    queryFn: () => api.get("/tournaments/leaderboard").then((r) => r.data),
    refetchInterval: 60_000,
  });

  const leaders = data?.leaders ?? [];

  return (
    <div className="arcade arcade-scanlines min-h-screen bg-black text-white flex flex-col items-center px-4 py-10 overflow-x-hidden">
      <Link
        to="/"
        className="self-start text-[10px] text-gray-500 hover:text-cyan-300 mb-8"
      >
        &lt; BACK
      </Link>

      <h1
        className="text-2xl sm:text-3xl text-center leading-relaxed"
        style={{ color: "#ffe600", textShadow: "0 0 12px rgba(255,230,0,0.6)" }}
      >
        HIGH SCORES
      </h1>
      <p className="text-[10px] sm:text-xs text-cyan-300 mt-4 mb-10 text-center">
        ONLINE NIGHTLY TOURNAMENT SERIES
      </p>

      <div className="w-full max-w-2xl">
        {isLoading ? (
          <p className="text-center text-xs text-gray-400 arcade-blink">LOADING…</p>
        ) : isError ? (
          <p className="text-center text-xs text-red-400">- CONNECTION ERROR -</p>
        ) : leaders.length === 0 ? (
          <div className="text-center text-gray-400 space-y-4">
            <p className="text-xs leading-relaxed">NO CHAMPIONS YET</p>
            <p className="text-[10px] text-gray-500 leading-relaxed">
              WIN A NIGHTLY BRACKET
              <br />
              TO CLAIM THE TOP SPOT
            </p>
          </div>
        ) : (
          <ol className="space-y-4 sm:space-y-5">
            {leaders.map((l, i) => (
              <li
                key={l.userId}
                className="flex items-center gap-3 text-xs sm:text-sm"
                style={{ color: rankColor(i) }}
              >
                <span className="w-10 shrink-0 text-right tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 min-w-0 truncate tracking-wider">
                  {arcadeName(l.username)}
                </span>
                <span className="shrink-0 tabular-nums">
                  {String(l.wins).padStart(3, "0")}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <p className="text-[10px] text-gray-500 mt-12 arcade-blink">PRESS START</p>
    </div>
  );
}
