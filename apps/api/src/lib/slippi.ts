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

  // Determine winner: most stocks remaining at game end, kills as tiebreak.
  // (OverallType has no stock info; surviving stocks are the entries in
  // stats.stocks that never ended.)
  const overall = stats?.overall ?? [];
  const stocks = stats?.stocks ?? [];
  const stocksRemaining = (playerIndex: number) =>
    stocks.filter((s) => s.playerIndex === playerIndex && s.endFrame === null).length;
  const winner =
    overall.length > 0
      ? [...overall].sort((a, b) => {
          const stockDiff = stocksRemaining(b.playerIndex) - stocksRemaining(a.playerIndex);
          return stockDiff !== 0 ? stockDiff : b.killCount - a.killCount;
        })[0]?.playerIndex ?? null
      : null;

  return {
    stage: settings?.stageId ?? null,
    players,
    winner,
    durationFrames: metadata?.lastFrame ?? null,
  };
}
