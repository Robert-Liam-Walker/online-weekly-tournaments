import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";
import { Tournament, Format } from "../types";

// Tournament-organizer console: create events and jump into the per-event
// admin controls that live on the tournament detail page (DQ, match
// override, replay review). Server enforces requireAdmin on everything here;
// this page is just the front door.

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const inputClass =
  "w-full bg-gray-800 text-white rounded-lg px-4 py-2.5 border border-gray-700 focus:border-blue-500 focus:outline-none";

function CreateEventForm() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [maxEntrants, setMaxEntrants] = useState(64);
  const [seriesFormat, setSeriesFormat] = useState<Format>("BO5");
  const [created, setCreated] = useState<Tournament | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post("/tournaments", {
          name: name.trim(),
          description: description.trim() || undefined,
          // datetime-local gives "YYYY-MM-DDTHH:mm" in local time; the API
          // wants a full ISO datetime string.
          scheduledAt: new Date(scheduledAt).toISOString(),
          maxEntrants,
          seriesFormat,
          entryFee: 0,
        })
      ).data as Tournament,
    onSuccess: (t) => {
      setCreated(t);
      setName("");
      setDescription("");
      setScheduledAt("");
      setMaxEntrants(64);
      setSeriesFormat("BO5");
      queryClient.invalidateQueries({ queryKey: ["tournaments"] });
    },
  });

  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <h2 className="text-white font-semibold mb-4">Create event</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setCreated(null);
          create.mutate();
        }}
        className="space-y-4"
      >
        <div>
          <label className="block text-sm text-gray-400 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={3}
            maxLength={100}
            placeholder="Saturday Smash #12"
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Weekly free double-elim bracket."
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Starts at</label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Max entrants</label>
            <input
              type="number"
              value={maxEntrants}
              onChange={(e) => setMaxEntrants(Number(e.target.value))}
              required
              min={4}
              max={256}
              className={inputClass}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Series format</label>
            <select
              value={seriesFormat}
              onChange={(e) => setSeriesFormat(e.target.value as Format)}
              className={inputClass}
            >
              <option value="BO3">Best of 3</option>
              <option value="BO5">Best of 5</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Entry fee</label>
            <input value="Free ($0)" disabled className={`${inputClass} opacity-60`} />
            <p className="text-xs text-gray-500 mt-1">Paid events are disabled for now.</p>
          </div>
        </div>

        {create.isError && (
          <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2">
            {(() => {
              const err = (create.error as { response?: { data?: { error?: unknown } } })
                ?.response?.data?.error;
              return typeof err === "string" ? err : "Failed to create event";
            })()}
          </p>
        )}
        {created && (
          <p className="text-green-400 text-sm bg-green-900/30 rounded-lg px-3 py-2">
            Created{" "}
            <Link to={`/tournaments/${created.id}`} className="underline hover:text-green-300">
              {created.name}
            </Link>
          </p>
        )}

        <button
          type="submit"
          disabled={create.isPending}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-lg transition-colors"
        >
          {create.isPending ? "Creating…" : "Create event"}
        </button>
      </form>
    </div>
  );
}

function UpcomingEvents() {
  const { data: tournaments = [], isLoading } = useQuery<Tournament[]>({
    queryKey: ["tournaments"],
    queryFn: () => api.get("/tournaments").then((r) => r.data),
  });

  const upcoming = tournaments.filter(
    (t) => t.status === "UPCOMING" || t.status === "REGISTRATION" || t.status === "ACTIVE"
  );

  return (
    <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <h2 className="text-white font-semibold mb-4">Upcoming events</h2>
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : upcoming.length === 0 ? (
        <p className="text-gray-500 text-sm">Nothing scheduled.</p>
      ) : (
        <ul className="divide-y divide-gray-700">
          {upcoming.map((t) => (
            <li key={t.id} className="py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <Link
                  to={`/tournaments/${t.id}`}
                  className="text-white font-medium hover:text-yellow-300"
                >
                  {t.name}
                </Link>
                <p className="text-gray-400 text-xs mt-0.5">
                  {formatDate(t.scheduledAt)} · {t.seriesFormat} ·{" "}
                  {t._count?.entries ?? 0}/{t.maxEntrants} entrants
                </p>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                  t.status === "ACTIVE"
                    ? "bg-green-900 text-green-300"
                    : t.status === "REGISTRATION"
                      ? "bg-blue-900 text-blue-300"
                      : "bg-gray-700 text-gray-300"
                }`}
              >
                {t.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Admin() {
  const user = useAuthStore((s) => s.user);

  // Defensive: role may be missing from older /auth/me payloads → not admin.
  if (user?.role !== "ADMIN") {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h1 className="text-2xl font-bold text-white mb-2">Admin</h1>
        <p className="text-gray-400">You need an admin account to use this page.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Admin</h1>
        <p className="text-gray-400 text-sm mt-1">
          Create events here; DQ, match overrides and replay review live on each event's detail
          page.
        </p>
      </div>
      <CreateEventForm />
      <UpcomingEvents />
    </div>
  );
}
