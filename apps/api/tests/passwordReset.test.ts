import { describe, expect, it } from "vitest";
import {
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  isResetTokenRowUsable,
} from "../src/routes/auth";

const NOW = new Date("2026-06-11T12:00:00.000Z");

function row(opts: { expiresInMs: number; usedAt?: Date | null }) {
  return {
    expiresAt: new Date(NOW.getTime() + opts.expiresInMs),
    usedAt: opts.usedAt ?? null,
  };
}

describe("hashResetToken", () => {
  it("produces 64 lowercase hex chars (sha256)", () => {
    expect(hashResetToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input, same hash", () => {
    expect(hashResetToken("token-a")).toBe(hashResetToken("token-a"));
  });

  it("matches the canonical SHA-256 test vector", () => {
    expect(hashResetToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("different inputs give different hashes", () => {
    expect(hashResetToken("token-a")).not.toBe(hashResetToken("token-b"));
  });
});

describe("generateResetToken", () => {
  it("raw token is 32 random bytes as 64 hex chars", () => {
    expect(generateResetToken().raw).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tokenHash is exactly the sha256 of the raw token (roundtrip)", () => {
    const { raw, tokenHash } = generateResetToken();
    expect(tokenHash).toBe(hashResetToken(raw));
  });

  it("the stored form never equals the raw form", () => {
    const { raw, tokenHash } = generateResetToken();
    expect(tokenHash).not.toBe(raw);
  });

  it("every issue is unique", () => {
    const raws = new Set(Array.from({ length: 100 }, () => generateResetToken().raw));
    expect(raws.size).toBe(100);
  });
});

describe("isResetTokenRowUsable", () => {
  it("rejects a missing row (unknown token)", () => {
    expect(isResetTokenRowUsable(null, NOW)).toBe(false);
    expect(isResetTokenRowUsable(undefined, NOW)).toBe(false);
  });

  it("accepts an unused, unexpired row", () => {
    expect(isResetTokenRowUsable(row({ expiresInMs: RESET_TOKEN_TTL_MS }), NOW)).toBe(true);
    expect(isResetTokenRowUsable(row({ expiresInMs: 1 }), NOW)).toBe(true);
  });

  it("rejects a used row even when unexpired", () => {
    expect(
      isResetTokenRowUsable(
        row({ expiresInMs: RESET_TOKEN_TTL_MS, usedAt: new Date(NOW.getTime() - 1000) }),
        NOW
      )
    ).toBe(false);
  });

  it("rejects an expired row even when unused", () => {
    expect(isResetTokenRowUsable(row({ expiresInMs: -1 }), NOW)).toBe(false);
    expect(isResetTokenRowUsable(row({ expiresInMs: -RESET_TOKEN_TTL_MS }), NOW)).toBe(false);
  });

  it("expiry boundary is exclusive — a row expiring exactly now is dead", () => {
    expect(isResetTokenRowUsable(row({ expiresInMs: 0 }), NOW)).toBe(false);
  });

  it("rejects a row that is both used and expired", () => {
    expect(
      isResetTokenRowUsable(row({ expiresInMs: -1, usedAt: new Date(NOW.getTime() - 5) }), NOW)
    ).toBe(false);
  });

  it("defaults `now` to the wall clock", () => {
    expect(
      isResetTokenRowUsable({ expiresAt: new Date(Date.now() + 60_000), usedAt: null })
    ).toBe(true);
    expect(
      isResetTokenRowUsable({ expiresAt: new Date(Date.now() - 60_000), usedAt: null })
    ).toBe(false);
  });
});

describe("RESET_TOKEN_TTL_MS", () => {
  it("is 60 minutes", () => {
    expect(RESET_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });
});
