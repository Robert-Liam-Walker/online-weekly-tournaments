import { SlippiGame } from "@slippi/slippi-js";

export interface ParsedReplay {
  stage: number | null;
  players: Array<{
    port: number;
    connectCode: string | null;
    characterId: number | null;
  }>;
  winner: number | null; // player port of the winner
  durationFrames: number | null;
}

export function parseReplayBuffer(buffer: Buffer): ParsedReplay {
  const game = new SlippiGame(buffer);
  const settings = game.getSettings();
  const metadata = game.getMetadata();
  const stats = game.getStats();

  const players = (settings?.players ?? []).map((p) => ({
    port: p.port,
    connectCode: metadata?.players?.[p.port]?.names?.code ?? null,
    characterId: p.characterId,
  }));

  // Determine winner from placements (lower placement = better)
  const placements = stats?.overall ?? [];
  const winner =
    placements.length > 0
      ? placements.sort((a, b) => {
          const stockDiff =
            (b.stocksRemaining ?? 0) - (a.stocksRemaining ?? 0);
          return stockDiff !== 0 ? stockDiff : a.killCount - b.killCount;
        })[0]?.playerIndex ?? null
      : null;

  return {
    stage: settings?.stageId ?? null,
    players,
    winner,
    durationFrames: metadata?.lastFrame ?? null,
  };
}
