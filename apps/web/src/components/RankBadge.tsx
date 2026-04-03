import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

interface SlippiRank {
  rating: number | null;
  wins: number;
  losses: number;
  tier: string;
  globalPlacement: number | null;
}

const TIER_STYLES: Record<string, { color: string; bg: string }> = {
  Grandmaster: { color: "text-red-300",    bg: "bg-red-900/60"      },
  Master:      { color: "text-purple-300", bg: "bg-purple-900/60"   },
  Diamond:     { color: "text-blue-300",   bg: "bg-blue-900/60"     },
  Platinum:    { color: "text-cyan-300",   bg: "bg-cyan-900/60"     },
  Gold:        { color: "text-yellow-300", bg: "bg-yellow-900/60"   },
  Silver:      { color: "text-gray-300",   bg: "bg-gray-700/80"     },
  Bronze:      { color: "text-orange-400", bg: "bg-orange-900/60"   },
  Unranked:    { color: "text-gray-500",   bg: "bg-gray-800"        },
};

export default function RankBadge({
  connectCode,
  showRecord = false,
}: {
  connectCode: string;
  showRecord?: boolean;
}) {
  const { data, isLoading } = useQuery<SlippiRank>({
    queryKey: ["rank", connectCode],
    queryFn: () => api.get(`/rank/${encodeURIComponent(connectCode)}`).then((r) => r.data),
    staleTime: 60 * 60 * 1000, // 1 hour — mirrors backend cache
    retry: false,
  });

  if (isLoading) {
    return <span className="text-xs text-gray-600 animate-pulse">···</span>;
  }

  if (!data || data.tier === "Unranked") {
    return <span className="text-xs text-gray-600">Unranked</span>;
  }

  const style = TIER_STYLES[data.tier] ?? TIER_STYLES.Unranked;

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${style.bg} ${style.color}`}>
        {data.tier}
        {data.rating !== null && (
          <span className="ml-1 opacity-75">{Math.round(data.rating)}</span>
        )}
      </span>
      {showRecord && (data.wins > 0 || data.losses > 0) && (
        <span className="text-xs text-gray-500">{data.wins}W–{data.losses}L</span>
      )}
    </span>
  );
}
