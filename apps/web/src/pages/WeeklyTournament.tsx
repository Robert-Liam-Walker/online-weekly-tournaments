import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Tournament } from "../types";
import TournamentDetail from "./TournamentDetail";

// The service centers on a single weekly tournament, so there is no list and
// no id in the URL: /tournament resolves the current event and renders its
// detail inline. Pick the live event if one is running, else the soonest
// open/upcoming, else the most recently completed.
export default function WeeklyTournament() {
  const { data: tournaments = [], isLoading } = useQuery<Tournament[]>({
    queryKey: ["tournaments"],
    queryFn: () => api.get("/tournaments").then((r) => r.data),
  });

  if (isLoading) {
    return <p className="text-gray-400 p-6">Loading tournament…</p>;
  }

  const bySoonest = (a: Tournament, b: Tournament) =>
    new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  const pick = (status: Tournament["status"], latest = false) => {
    const matches = tournaments.filter((t) => t.status === status);
    matches.sort(latest ? (a, b) => bySoonest(b, a) : bySoonest);
    return matches[0];
  };
  const target =
    pick("ACTIVE") ??
    pick("REGISTRATION") ??
    pick("UPCOMING") ??
    pick("COMPLETED", true) ??
    tournaments[0];

  if (!target) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-24 text-center">
        <p className="text-xl font-semibold text-white">No tournament scheduled yet</p>
        <p className="text-gray-400 text-sm">
          A new weekly bracket opens every Friday — check back soon.
        </p>
        <Link to="/download" className="text-blue-400 hover:text-blue-300 text-sm underline mt-2">
          Download the client
        </Link>
      </div>
    );
  }

  return <TournamentDetail id={target.id} />;
}
