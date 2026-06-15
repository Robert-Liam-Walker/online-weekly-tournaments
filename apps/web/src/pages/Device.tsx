import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../hooks/useAuth";

// Confirm a device link code shown by the FoxTrot Dolphin client. Links the
// game to this account so it stops relying on connect-code trust.
//
// Two entry paths land here (both behind RequireAuth, so the user is logged in
// by the time this renders):
//   - Auto: Dolphin opens the browser to /device?code=ABC123 on boot when it
//     has no/expired token. The code is prefilled and the player just clicks
//     Approve — no typing (the standalone-launch low-friction path).
//   - Manual fallback: the player opens /device themselves and types the
//     6-character code the game shows on screen.
export default function Device() {
  const [params] = useSearchParams();
  const urlCode = (params.get("code") ?? "").trim().toUpperCase().slice(0, 6);
  const [code, setCode] = useState(urlCode);
  const username = useAuthStore((s) => s.user?.username);

  const confirm = useMutation({
    mutationFn: async (value: string) =>
      (await api.post("/device/link/confirm", { code: value.trim().toUpperCase() })).data,
  });

  const linked = confirm.isSuccess;
  const errorMsg = (confirm.error as any)?.response?.data?.error;

  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-2xl font-bold text-white mb-2">Link your game</h1>

      {linked ? (
        <div className="bg-green-900/40 border border-green-700 rounded-xl p-4">
          <p className="text-green-300 font-medium">✓ Device linked</p>
          <p className="text-gray-400 text-sm mt-1">
            Head back to the game — it picks up the link within a few seconds.
          </p>
        </div>
      ) : urlCode ? (
        // Auto path: code came pre-filled from the game. One click to approve.
        <>
          <p className="text-gray-400 text-sm mb-6">
            Approve linking this game{username ? ` to ${username}` : ""}? Code{" "}
            <span className="font-mono text-white tracking-widest">{urlCode}</span>.
          </p>
          <button
            onClick={() => confirm.mutate(urlCode)}
            disabled={confirm.isPending}
            className="w-full bg-yellow-700 hover:bg-yellow-600 text-white font-medium py-3 rounded-lg disabled:opacity-50"
          >
            {confirm.isPending ? "Approving…" : "Approve"}
          </button>
          {confirm.isError && (
            <p className="text-red-400 text-sm mt-3">{errorMsg ?? "Link failed"}</p>
          )}
        </>
      ) : (
        // Manual fallback: no code in the URL, player types it.
        <>
          <p className="text-gray-400 text-sm mb-6">
            The Nightly Tournaments client shows a 6-character code when it needs to link.
            Enter it here to connect the game to your account.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim().length === 6) confirm.mutate(code);
            }}
            className="space-y-3"
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="ABC123"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white text-2xl tracking-[0.5em] text-center font-mono uppercase focus:outline-none focus:border-yellow-600"
            />
            <button
              type="submit"
              disabled={code.trim().length !== 6 || confirm.isPending}
              className="w-full bg-yellow-700 hover:bg-yellow-600 text-white font-medium py-3 rounded-lg disabled:opacity-50"
            >
              {confirm.isPending ? "Linking…" : "Link device"}
            </button>
            {confirm.isError && (
              <p className="text-red-400 text-sm">{errorMsg ?? "Link failed"}</p>
            )}
          </form>
        </>
      )}
    </div>
  );
}
