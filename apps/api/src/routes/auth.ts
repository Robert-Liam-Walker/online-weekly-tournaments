import { createHash, randomBytes } from "crypto";
import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { USERNAME_REGEX } from "@foxtrot/shared";
import { prisma } from "../lib/prisma";
import { sendPasswordResetEmail } from "../lib/email";
import { DISPLAY_NAME_REGEX } from "../lib/displayName";

const registerSchema = z.object({
  username: z
    .string()
    .regex(USERNAME_REGEX, "Username must be 3-15 letters or numbers"),
  email: z.string().email(),
  password: z.string().min(8),
});

// `email` is accepted as an identifier: it may be an email OR a username, so
// it is intentionally NOT constrained to email format. (Key name kept for
// client compatibility — the web form and game client both post `email`.)
const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

// Brute-force protection: account creation and credential checks get a much
// stricter per-IP budget than the global API limit.
const strictRateLimit = {
  rateLimit: { max: 10, timeWindow: "1 minute" },
};

// ---------------------------------------------------------------------------
// Password reset
//
// Only the sha256 hex of the emailed token is ever stored or compared; the
// raw token exists in the reset URL alone. Pure helpers are exported for
// unit tests, the service functions for the smoke script.
// ---------------------------------------------------------------------------

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 minutes

export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function generateResetToken(): { raw: string; tokenHash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, tokenHash: hashResetToken(raw) };
}

/** A stored token row is usable iff it exists, is unused, and is unexpired. */
export function isResetTokenRowUsable(
  row: { expiresAt: Date; usedAt: Date | null } | null | undefined,
  now: Date = new Date()
): boolean {
  if (!row) return false;
  if (row.usedAt !== null) return false;
  return row.expiresAt.getTime() > now.getTime();
}

/**
 * Issue a reset token for the account behind `email` (silently a no-op when
 * no account matches — callers must answer identically either way to avoid
 * user enumeration). Any prior unused tokens for the user are invalidated.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

  const { raw, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    }),
  ]);

  const webUrl = process.env.WEB_URL ?? "http://localhost:5173";
  await sendPasswordResetEmail(user.email, `${webUrl}/reset-password?token=${raw}`, user.username);
}

/**
 * Consume a raw reset token and set the user's password. Returns false for
 * any unknown/used/expired token (callers map that to one generic 400 so the
 * response never reveals which check failed). Consumption is guarded by a
 * conditional update inside the transaction, so a concurrent double-submit
 * of the same token can only succeed once.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string
): Promise<boolean> {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
  });
  if (!row || !isResetTokenRowUsable(row)) return false;

  const passwordHash = await bcrypt.hash(newPassword, 12);

  return prisma.$transaction(async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) return false; // lost the race — already used
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    return true;
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", { config: strictRateLimit }, async (request, reply) => {
    const body = registerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    const { username, email, password } = body.data;

    // Username uniqueness is case-insensitive (DB enforces it via the
    // lower(username) unique index; this check gives a friendly 409).
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username: { equals: username, mode: "insensitive" } },
        ],
      },
    });
    if (existing) {
      return reply
        .code(409)
        .send({ error: "Email or username already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // Admin bootstrap: the operator email (ADMIN_EMAIL env) registers
    // straight into the ADMIN role — production has no DB shell access.
    const role = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL ? "ADMIN" : "USER";
    // No custom in-game name yet — the player shows as GUEST + their registration
    // order in each tournament until they set one here on the web.
    const user = await prisma.user.create({
      data: { username, email, passwordHash, role },
      select: { id: true, username: true, displayName: true, email: true, subscriptionStatus: true },
    });

    const token = app.jwt.sign({ id: user.id }, { expiresIn: "7d" });
    return reply.code(201).send({ user, token });
  });

  app.post("/login", { config: strictRateLimit }, async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    // Identifier may be an email or a username (username match is
    // case-insensitive, mirroring registration's uniqueness rule).
    const identifier = body.data.email.trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: { equals: identifier, mode: "insensitive" } },
        ],
      },
    });
    if (!user) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(body.data.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = app.jwt.sign({ id: user.id }, { expiresIn: "7d" });
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        subscriptionStatus: user.subscriptionStatus,
      },
      token,
    };
  });

  // Step 1 of password reset: email a single-use, 60-minute link. ALWAYS
  // answers 200 {ok:true} — whether or not the account exists, and even if
  // the email send fails — so the endpoint can't be used for user
  // enumeration. Tight per-IP budget: this sends outbound email.
  app.post(
    "/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = forgotPasswordSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      try {
        await requestPasswordReset(body.data.email);
      } catch (err) {
        // Never let a delivery failure change the response (enumeration) —
        // log and answer 200 anyway. The raw token is not part of `err`.
        request.log.error({ err }, "password reset request failed");
      }

      return { ok: true };
    }
  );

  // Step 2: trade the emailed token for a new password. One generic 400 for
  // every failure mode (unknown, used, expired) — no oracle.
  app.post(
    "/reset-password",
    { config: strictRateLimit },
    async (request, reply) => {
      const body = resetPasswordSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.flatten() });
      }

      const ok = await resetPasswordWithToken(body.data.token, body.data.newPassword);
      if (!ok) {
        return reply.code(400).send({ error: "Invalid or expired reset link" });
      }

      return { ok: true };
    }
  );

  // /game-login is GONE (Phase 3, 2026-06-12): clients authenticate via
  // launcher login (writes foxtrot-token.txt) or the in-game device-link
  // flow; dev tooling mints tokens with scripts/mint-dev-token.ts.

  app.get(
    "/me",
    { preHandler: [(req, rep) => req.jwtVerify()] },
    async (request) => {
      const { id } = request.user as { id: string };
      return prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          role: true,
          subscriptionStatus: true,
          subscriptionEndsAt: true,
          createdAt: true,
        },
      });
    }
  );

  // Change the in-game identity (the ABCD12 name shown in-game and in brackets).
  // Login required; format-validated and unique. The Dolphin client re-fetches
  // it on its poll, so the change shows up in-game within a few seconds.
  app.post(
    "/display-name",
    { preHandler: [(req, rep) => req.jwtVerify()] },
    async (request, reply) => {
      const { id } = request.user as { id: string };
      const raw = (request.body as { displayName?: string } | undefined)?.displayName;
      const displayName = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      if (!DISPLAY_NAME_REGEX.test(displayName)) {
        return reply.code(400).send({ error: "Name must be 5 letters then 2 numbers (e.g. ABCDE12)" });
      }
      const taken = await prisma.user.findUnique({ where: { displayName } });
      if (taken && taken.id !== id) {
        return reply.code(409).send({ error: "That name is taken" });
      }
      const user = await prisma.user.update({
        where: { id },
        data: { displayName },
        select: { id: true, username: true, displayName: true },
      });
      return { user };
    }
  );
}
