import { useEffect, useState } from "react";
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

  const joinArena = useMutation({
    mutationFn: (data: { format: Format; note?: string }) =>
      api.post("/arena/join", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["arena"] }),
  });

  const leaveArena = useMutation({
    mutationFn: () => api.delete("/arena/leave").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["arena"] }),
  });

  return { entries, isLoading, joinArena, leaveArena };
}
