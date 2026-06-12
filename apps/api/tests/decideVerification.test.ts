import { describe, expect, it } from "vitest";
import { decideVerification } from "../src/routes/replays";

const P1_ID = "user-p1";
const P2_ID = "user-p2";
const P1_NAME = "MangoFox";
const P2_NAME = "ZainMarth1";

describe("decideVerification", () => {
  it("VERIFIED when the parsed winner is the recorded winner (player 1)", () => {
    expect(decideVerification(P1_NAME, P1_NAME, P2_NAME, P1_ID, P2_ID, P1_ID)).toBe("VERIFIED");
  });

  it("VERIFIED when the parsed winner is the recorded winner (player 2)", () => {
    expect(decideVerification(P2_NAME, P1_NAME, P2_NAME, P1_ID, P2_ID, P2_ID)).toBe("VERIFIED");
  });

  it("VERIFIED is case-insensitive on usernames", () => {
    expect(decideVerification("mangofox", P1_NAME, P2_NAME, P1_ID, P2_ID, P1_ID)).toBe("VERIFIED");
    expect(decideVerification(P2_NAME, P1_NAME, "ZAINMARTH1", P1_ID, P2_ID, P2_ID)).toBe("VERIFIED");
  });

  it("MISMATCH when the parsed winner contradicts the recorded winner", () => {
    expect(decideVerification(P2_NAME, P1_NAME, P2_NAME, P1_ID, P2_ID, P1_ID)).toBe("MISMATCH");
    expect(decideVerification(P1_NAME, P1_NAME, P2_NAME, P1_ID, P2_ID, P2_ID)).toBe("MISMATCH");
  });

  it("PENDING when the parsed winner maps but no result is recorded yet", () => {
    expect(decideVerification(P1_NAME, P1_NAME, P2_NAME, P1_ID, P2_ID, null)).toBe("PENDING");
    expect(decideVerification(P2_NAME, P1_NAME, P2_NAME, P1_ID, P2_ID, null)).toBe("PENDING");
  });

  it("MANUAL_REVIEW when the parsed winner name matches neither entrant", () => {
    expect(decideVerification("SomeoneElse", P1_NAME, P2_NAME, P1_ID, P2_ID, P1_ID)).toBe(
      "MANUAL_REVIEW"
    );
    expect(decideVerification("SomeoneElse", P1_NAME, P2_NAME, P1_ID, P2_ID, null)).toBe(
      "MANUAL_REVIEW"
    );
  });

  it("MANUAL_REVIEW when no winner name could be parsed, even with a recorded winner", () => {
    expect(decideVerification(null, P1_NAME, P2_NAME, P1_ID, P2_ID, P1_ID)).toBe("MANUAL_REVIEW");
    expect(decideVerification(null, P1_NAME, P2_NAME, P1_ID, P2_ID, null)).toBe("MANUAL_REVIEW");
  });

  it("MANUAL_REVIEW when entrant usernames are missing — null never matches null", () => {
    expect(decideVerification(null, null, null, P1_ID, P2_ID, P1_ID)).toBe("MANUAL_REVIEW");
    expect(decideVerification(P1_NAME, null, null, P1_ID, P2_ID, P1_ID)).toBe("MANUAL_REVIEW");
  });
});
