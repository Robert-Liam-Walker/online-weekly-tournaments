import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

// The name shown in Dolphin and on brackets. POSTs /auth/display-name; the game
// client polls and picks the new name up in-game within a few seconds (EXI).
// Five letters then two numbers, e.g. ABCDE12. Without one the player appears as
// GUEST + their spot in each tournament.
export default function InGameName({ current }: { current: string | null }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: (displayName: string) =>
      api.post("/auth/display-name", { displayName }).then((r) => r.data),
    onSuccess: () => {
      setError("");
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: unknown) => {
      setSaved(false);
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          "Could not save"
      );
    },
  });

  const valid = /^[A-Z]{5}[0-9]{2}$/.test(value);

  return (
    <div className="bg-gray-800 rounded-xl p-6 mb-4">
      <h2 className="text-white font-semibold mb-1">In-Game Name</h2>
      <p className="text-gray-400 text-sm mb-4">
        The name shown in Dolphin and on brackets. Five letters then two numbers
        (e.g. ABCDE12). Without one, you appear as GUEST + your spot in each
        tournament. Changing it here updates in-game within a few seconds.
      </p>
      <div className="flex items-center gap-3">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value.toUpperCase().slice(0, 7));
            setSaved(false);
            setError("");
          }}
          maxLength={7}
          placeholder="ABCDE12"
          className="bg-gray-900 text-white tracking-widest font-mono px-4 py-2.5 rounded-lg w-36 outline-none focus:ring-2 focus:ring-yellow-500/60"
        />
        <button
          onClick={() => valid && mutation.mutate(value)}
          disabled={!valid || mutation.isPending || value === (current ?? "")}
          className="bg-yellow-600 hover:bg-yellow-500 disabled:opacity-40 text-black px-5 py-2.5 rounded-lg font-medium transition-colors"
        >
          {mutation.isPending ? "Saving..." : "Save"}
        </button>
      </div>
      {error && (
        <p className="text-red-400 text-sm bg-red-900/30 rounded-lg px-3 py-2 mt-3">{error}</p>
      )}
      {saved && !error && (
        <p className="text-green-300 text-sm mt-3">Saved — it'll show up in-game shortly.</p>
      )}
    </div>
  );
}
