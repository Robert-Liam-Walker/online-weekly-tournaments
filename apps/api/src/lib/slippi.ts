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

  // metadata.players is keyed by 0-based playerIndex (NOT by 1-based port);
  // settings player carries both, so look up the code by playerIndex while
  // exposing the port externally.
  const players = (settings?.players ?? []).map((p) => ({
    port: p.port,
    connectCode: metadata?.players?.[p.playerIndex]?.names?.code ?? null,
    characterId: p.characterId,
  }));

  // playerIndex (0-based, used by stats) -> port (1-based, our public contract)
  const portByIndex = new Map<number, number>(
    (settings?.players ?? []).map((p) => [p.playerIndex, p.port]),
  );

  // Determine winner: most stocks remaining at game end, kills as tiebreak.
  // (OverallType has no stock info; surviving stocks are the entries in
  // stats.stocks that never ended.)
  const overall = stats?.overall ?? [];
  const stocks = stats?.stocks ?? [];
  const stocksRemaining = (playerIndex: number) =>
    stocks.filter((s) => s.playerIndex === playerIndex && s.endFrame === null).length;
  const winnerIndex =
    overall.length > 0
      ? [...overall].sort((a, b) => {
          const stockDiff = stocksRemaining(b.playerIndex) - stocksRemaining(a.playerIndex);
          return stockDiff !== 0 ? stockDiff : b.killCount - a.killCount;
        })[0]?.playerIndex ?? null
      : null;
  // map the winning playerIndex back to its port to honour the documented
  // `winner = port` contract (replay route matches players by port)
  const winner = winnerIndex !== null ? portByIndex.get(winnerIndex) ?? null : null;

  return {
    stage: settings?.stageId ?? null,
    players,
    winner,
    durationFrames: metadata?.lastFrame ?? null,
  };
}
