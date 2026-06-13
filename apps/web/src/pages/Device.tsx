/**
 * Device page
 *
 * Route:    /device  (rendered inside RequireAuth + Layout in App.tsx)
 * Auth:     Behind RequireAuth.
 *
 * Purpose:  One-time device-link flow. The FoxTrot Dolphin client displays a
 *           6-character alphanumeric code when it needs to associate itself
 *           with a web account. The user types that code here to complete the
 *           link; after linking the game polls /device/link/status and picks
 *           up the association within a few seconds.
 *
 * Data dependencies:
 *   - POST /device/link/confirm   — validates the code and creates the link
 *
 * UI states:
 *   - idle: 6-char input + "Link device" button (disabled until 6 chars entered).
 *   - pending: button shows "Linking…".
 *   - success: green confirmation card; form hidden.
 *   - error: red inline error below the button.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";

export default function Device() {
  const [code, setCode] = useState("");

  const confirm = useMutation({
    mutationFn: async () =>
      (await api.post("/device/link/confirm", { code: code.trim().toUpperCase() })).data,
  });

  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-2xl font-bold text-white mb-2">Link your game</h1>
      <p className="text-gray-400 text-sm mb-6">
        The Randall's Nightly Tournaments client shows a 6-character code when it needs to link. Enter it here to connect
        the game to your account.
      </p>

      {confirm.isSuccess ? (
        <div className="bg-green-900/40 border border-green-700 rounded-xl p-4">
          <p className="text-green-300 font-medium">✓ Device linked</p>
          <p className="text-gray-400 text-sm mt-1">
            Head back to the game — it picks up the link within a few seconds.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length === 6) confirm.mutate();
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
            <p className="text-red-400 text-sm">
              {(confirm.error as any)?.response?.data?.error ?? "Link failed"}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
