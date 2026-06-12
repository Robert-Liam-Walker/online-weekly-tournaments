import { describe, expect, it, vi, beforeEach } from "vitest";

// Mutable holder the mocked SlippiGame reads from (hoisted above the mock).
const h = vi.hoisted(() => ({
  settings: null as unknown,
  metadata: null as unknown,
  stats: null as unknown,
}));

vi.mock("@slippi/slippi-js", () => ({
  SlippiGame: vi.fn().mockImplementation(() => ({
    getSettings: () => h.settings,
    getMetadata: () => h.metadata,
    getStats: () => h.stats,
  })),
}));

import { parseReplayBuffer } from "../src/lib/slippi";

// playerIndex is 0-based; port is 1-based. metadata.players is keyed by
// playerIndex, NOT port — the bug this guards against indexed it by port.
function setGame() {
  h.settings = {
    stageId: 31,
    players: [
      { playerIndex: 0, port: 1, characterId: 9 }, // Marth
      { playerIndex: 1, port: 2, characterId: 2 }, // Fox
    ],
  };
  h.metadata = {
    lastFrame: 1234,
    players: {
      0: { names: { netplay: "PlayerOne", code: "AAAA#111" } },
      1: { names: { netplay: "PlayerTwo", code: "BBBB#222" } },
    },
  };
  // Player at index 1 (port 2) wins: keeps a stock, more kills.
  h.stats = {
    overall: [{ playerIndex: 0, killCount: 1 }, { playerIndex: 1, killCount: 4 }],
    stocks: [
      { playerIndex: 0, endFrame: 900 }, // p1's last stock ended -> 0 remaining
      { playerIndex: 1, endFrame: null }, // p2 still alive -> 1 remaining
    ],
  };
}

describe("parseReplayBuffer", () => {
  beforeEach(() => setGame());

  it("pairs each player's name by playerIndex, not port", () => {
    const parsed = parseReplayBuffer(Buffer.from([]));
    const p1 = parsed.players.find((p) => p.port === 1);
    const p2 = parsed.players.find((p) => p.port === 2);
    expect(p1?.playerName).toBe("PlayerOne");
    expect(p2?.playerName).toBe("PlayerTwo");
  });

  it("falls back to the legacy code field when no netplay name exists", () => {
    h.metadata = {
      lastFrame: 1234,
      players: {
        0: { names: { code: "AAAA#111" } },
        1: { names: { code: "BBBB#222" } },
      },
    };
    const parsed = parseReplayBuffer(Buffer.from([]));
    expect(parsed.players.find((p) => p.port === 1)?.playerName).toBe("AAAA#111");
    expect(parsed.players.find((p) => p.port === 2)?.playerName).toBe("BBBB#222");
  });

  it("returns the winner as a port (1-based), not a 0-based playerIndex", () => {
    const parsed = parseReplayBuffer(Buffer.from([]));
    // winning playerIndex is 1; the port is 2. The old bug returned 1.
    expect(parsed.winner).toBe(2);
  });

  it("the winner port resolves to the correct player name (end-to-end pairing)", () => {
    const parsed = parseReplayBuffer(Buffer.from([]));
    const winnerName = parsed.players.find((p) => p.port === parsed.winner)?.playerName;
    expect(winnerName).toBe("PlayerTwo");
  });

  it("exposes stage and duration from settings/metadata", () => {
    const parsed = parseReplayBuffer(Buffer.from([]));
    expect(parsed.stage).toBe(31);
    expect(parsed.durationFrames).toBe(1234);
  });
});
