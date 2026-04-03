import { useQuery, useMutation } from "@tanstack/react-query";
import { Tournament } from "../types";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";

export default function Tournaments() {
  const { isSubscribed } = useAuthStore();

  const { data: tournaments = [], isLoading } = useQuery<Tournament[]>({
    queryKey: ["tournaments"],
    queryFn: () => api.get("/tournaments").then((r) => r.data),
  });

  const register = useMutation({
    mutationFn: (tournamentId: string) =>
      api.post(`/tournaments/${tournamentId}/register`).then((r) => r.data),
  });

  if (isLoading) {
    return <div className="p-8 text-center text-gray-400">Loading tournaments...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-white mb-2">Weekly Tournaments</h1>
      <p className="text-gray-400 mb-6">
        Compete in best-of-5 single or double elimination brackets. New tournament every week.
      </p>

      <div className="space-y-4">
        {tournaments.length === 0 && (
          <p className="text-gray-500 text-center py-12">No tournaments scheduled yet.</p>
        )}
        {tournaments.map((t) => (
          <div key={t.id} className="bg-gray-800 rounded-lg p-5">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-white font-bold text-xl">{t.name}</h2>
                {t.description && (
                  <p className="text-gray-400 text-sm mt-1">{t.description}</p>
                )}
                <div className="flex gap-3 mt-3 text-sm text-gray-400">
                  <span>
                    {new Date(t.scheduledAt).toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  <span>|</span>
                  <span>{t.format === "DOUBLE_ELIM" ? "Double Elim" : "Single Elim"}</span>
                  <span>|</span>
                  <span>{t.seriesFormat === "BO5" ? "Best of 5" : "Best of 3"}</span>
                  <span>|</span>
                  <span>
                    {t._count?.entries ?? 0}/{t.maxEntrants} players
                  </span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-2">
                <span
                  className={`text-xs px-2 py-1 rounded-full font-medium ${
                    t.status === "REGISTRATION"
                      ? "bg-green-900 text-green-300"
                      : t.status === "ACTIVE"
                      ? "bg-yellow-900 text-yellow-300"
                      : t.status === "COMPLETED"
                      ? "bg-gray-700 text-gray-400"
                      : "bg-blue-900 text-blue-300"
                  }`}
                >
                  {t.status}
                </span>

                {t.status === "REGISTRATION" && (
                  <>
                    {isSubscribed() ? (
                      <button
                        onClick={() => register.mutate(t.id)}
                        disabled={register.isPending}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-medium text-sm transition-colors"
                      >
                        Register
                      </button>
                    ) : (
                      <a
                        href="/subscribe"
                        className="bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded font-medium text-sm transition-colors"
                      >
                        Subscribe to Enter
                      </a>
                    )}
                  </>
                )}

                {(t.status === "ACTIVE" || t.status === "COMPLETED") && (
                  <a
                    href={`/tournaments/${t.id}`}
                    className="text-blue-400 hover:text-blue-300 text-sm underline"
                  >
                    View Bracket
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
