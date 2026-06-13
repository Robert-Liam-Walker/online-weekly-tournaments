/**
 * useArena — hook for the Arena (matchmaking lobby) page.
 *
 * PURPOSE
 *   Fetches the current arena roster and keeps it in sync with real-time
 *   socket events. Exposes mutations to join or leave the arena.
 *
 * RETURNS
 * ──────────────────────────────────────────────────────────────────────────
 *   entries: ArenaEntry[]
 *     Current list of players waiting in the arena. Each entry includes the
 *     player's user snippet, chosen format (BO3|BO5), optional note, and
 *     timestamp.
 *
 *   isLoading: boolean
 *     True on the initial fetch; false once the query has settled.
 *
 *   joinArena: UseMutationResult
 *     POST /arena/join — add the current user to the arena.
 *     Payload: { format: Format; note?: string }
 *     On success: invalidates the ["arena"] query to refetch the full list.
 *
 *   leaveArena: UseMutationResult
 *     DELETE /arena/leave — remove the current user from the arena.
 *     On success: invalidates the ["arena"] query.
 *
 * SOCKET EVENTS SUBSCRIBED
 * ──────────────────────────────────────────────────────────────────────────
 *   "arena:join" (ArenaEntry)
 *     A player joined the arena. Appended to the cached list if not already
 *     present (deduplicated by userId to guard against duplicate events).
 *
 *   "arena:leave" ({ userId: string })
 *     A player left the arena. Removed from the cached list by userId.
 *
 *   Both listeners are cleaned up on unmount. The query key is ["arena"].
 *
 * WHERE USED
 *   apps/web/src/pages/Arena.tsx (Agent C's page).
 */

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArenaEntry, Format } from "../types";
import { api } from "../lib/api";
import { getSocket } from "../lib/socket";

export function useArena() {
  const qc = useQueryClient();

  const { data: entries = [], isLoading } = useQuery<ArenaEntry[]>({
    queryKey: ["arena"],
    queryFn: () => api.get("/arena").then((r) => r.data),
  });

  // Real-time updates via Socket.io
  useEffect(() => {
    const socket = getSocket();

    socket.on("arena:join", (entry: ArenaEntry) => {
      qc.setQueryData<ArenaEntry[]>(["arena"], (prev = []) => {
        const exists = prev.some((e) => e.userId === entry.userId);
        return exists ? prev : [...prev, entry];
      });
    });

    socket.on("arena:leave", ({ userId }: { userId: string }) => {
      qc.setQueryData<ArenaEntry[]>(["arena"], (prev = []) =>
        prev.filter((e) => e.userId !== userId)
      );
    });

    return () => {
      socket.off("arena:join");
      socket.off("arena:leave");
    };
  }, [qc]);

  /** POST /arena/join — enter the matchmaking lobby with a format and optional note. */
  const joinArena = useMutation({
    mutationFn: (data: { format: Format; note?: string }) =>
      api.post("/arena/join", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["arena"] }),
  });

  /** DELETE /arena/leave — exit the matchmaking lobby. */
  const leaveArena = useMutation({
    mutationFn: () => api.delete("/arena/leave").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["arena"] }),
  });

  return { entries, isLoading, joinArena, leaveArena };
}
