import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { authenticateSocketToken } from "./socketAuth";

// Mirrors the HTTP setup: one @fastify/jwt instance with our secret. A second
// instance signs with a DIFFERENT secret to forge structurally-valid tokens.
const SECRET = "test-secret-please-ignore";

let app: FastifyInstance;
let attacker: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(jwt, { secret: SECRET });
  await app.ready();

  attacker = Fastify();
  await attacker.register(jwt, { secret: "a-completely-different-secret" });
  await attacker.ready();
});

describe("authenticateSocketToken", () => {
  it("returns the user id for a validly-signed token", () => {
    const token = app.jwt.sign({ id: "user-123" });
    expect(authenticateSocketToken(app, token)).toBe("user-123");
  });

  it("rejects a token signed with a different secret (forged)", () => {
    const forged = attacker.jwt.sign({ id: "attacker" });
    expect(() => authenticateSocketToken(app, forged)).toThrow();
  });

  it("rejects a tampered token (mutated payload, original signature)", () => {
    const token = app.jwt.sign({ id: "user-123" });
    const [header, , signature] = token.split(".");
    const evilPayload = Buffer.from(JSON.stringify({ id: "attacker" })).toString(
      "base64url"
    );
    expect(() =>
      authenticateSocketToken(app, `${header}.${evilPayload}.${signature}`)
    ).toThrow();
  });

  it("rejects garbage / unsigned input", () => {
    expect(() => authenticateSocketToken(app, "not.a.jwt")).toThrow();
    expect(() => authenticateSocketToken(app, "")).toThrow();
  });

  it("rejects a validly-signed token that carries no user id", () => {
    const token = app.jwt.sign({ foo: "bar" });
    expect(() => authenticateSocketToken(app, token)).toThrow();
  });
});
