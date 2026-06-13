/**
 * slippi.ts — Slippi replay parser and winner attribution.
 *
 * Purpose: Parse a raw .slp file buffer and extract the structured match
 * outcome — stage, players (port + character + display name), winner port, and
 * duration. Used by the replay-upload route (routes/replays.ts) to auto-report
 * match results from the uploaded .slp file.
 *
 * Winner attribution logic:
 *   The game's "overall" stats do not include a winner field directly. We derive
 *   it by counting stocks remaining at game end:
 *     1. A stock entry in stats.stocks with endFrame === null was never lost —
 *        i.e. the player still had that stock when the game ended.
 *     2. The player with the most remaining stocks wins.
 *     3. Kill count breaks ties (unusual in Melee, but handled for correctness).
 *
 *   IMPORTANT CAVEAT — LRAS / voluntary quit:
 *   The Slippi SDK does not distinguish a natural game-over from an L+R+A+Start
 *   quit-out. If a player quits mid-game, their opponent may show 0 remaining
 *   stocks (the game-end state is the quit frame). The upload route should be
 *   used as a convenience shortcut only; the TO / match report flow remains the
 *   authoritative channel when disputes arise.
 *
 * Port vs. playerIndex:
 *   `@slippi/slippi-js` uses 0-based playerIndex internally (stats, metadata)
 *   and 1-based port externally (settings). The parser maps them correctly:
 *   winnerIndex (0-based) is translated back to winner port (1-based) so the
 *   returned winner field matches the port values in the players array.
 *
 * Key exports:
 *   parseReplayBuffer — parse a .slp buffer; returns ParsedReplay.
 *   ParsedReplay      — structured match outcome.
 *
 * Invariants:
 *   - All fields are nullable: older replays may be missing metadata or stats.
 *   - winner is the 1-based PORT number, not playerIndex. The upload route in
 *     routes/replays.ts is responsible for mapping port → userId via the
 *     rendezvous/tournament match record.
 */
import { SlippiGame } from "@slippi/slippi-js";

export interface ParsedReplay {
  stage: number | null;
  players: Array<{
    port: number;
    playerName: string | null;
    characterId: number | null;
  }>;
  /** 1-based port number of the winning player, or null if undetermined. */
  winner: number | null;
  durationFrames: number | null;
}

/**
 * Parse a raw .slp file buffer into a structured match outcome.
 * @param buffer - raw bytes of a Slippi .slp replay file.
 * @returns ParsedReplay with stage, players, winner port, and duration.
 *
 * All fields are nullable — missing metadata/stats in older or truncated
 * replays will produce nulls rather than throwing. Winner attribution uses
 * stocks-remaining then kill-count as a tiebreak; see module notes on the
 * LRAS caveat.
 */
export function parseReplayBuffer(buffer: Buffer): ParsedReplay {
  const game = new SlippiGame(buffer);
  const settings = game.getSettings();
  const metadata = game.getMetadata();
  const stats = game.getStats();

  // metadata.players is keyed by 0-based playerIndex (NOT by 1-based port);
  // settings player carries both, so look up the name by playerIndex while
  // exposing the port externally. Prefer the netplay display name; fall back
  // to the legacy code field for older replays.
  const players = (settings?.players ?? []).map((p) => {
    const names = metadata?.players?.[p.playerIndex]?.names;
    return {
      port: p.port,
      playerName: names?.netplay ?? names?.code ?? null,
      characterId: p.characterId,
    };
  });

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
