import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// Password-reset smoke test, run directly against the dev database
// (same pattern as scripts/smoke-integrity.ts — drives the route handlers'
// service logic, no HTTP server needed):
//   npx -w apps/api tsx scripts/smoke-password-reset.ts
//
// SES_FROM_EMAIL must be unset (dev default) so sendEmail falls back to the
// console — this script reads the reset URL from that output, exactly the
// way a developer would.
//
// Covers:
//   1. unknown email is a silent no-op (no row, no error)
//   2. request issues exactly one row storing the sha256 hash (never the raw)
//      with a ~60-minute expiry
//   3. a second request invalidates the first token
//   4. wrong/stale tokens are rejected and leave the password untouched
//   5. a valid token consumes the row (usedAt) and really changes the
//      password (bcrypt compare)
//   6. a token is single-use
//   7. an expired token is rejected

import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import {
  RESET_TOKEN_TTL_MS,
  hashResetToken,
  isResetTokenRowUsable,
  requestPasswordReset,
  resetPasswordWithToken,
} from "../src/routes/auth";

const TAG = "smoke-pwreset";
const EMAIL = `${TAG}@example.invalid`;
const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "new-password-456";

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { username: { startsWith: TAG } } });
  if (users.length > 0) {
    const ids = users.map((u) => u.id);
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Run `fn` while capturing console.log, and pull the reset token out of the
 *  dev-fallback email it prints. Output is passed through so the operator
 *  still sees the email. */
async function captureResetToken(fn: () => Promise<void>): Promise<string | null> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
    original.apply(console, args);
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  const match = lines.join("\n").match(/\/reset-password\?token=([0-9a-f]{64})/);
  return match ? match[1] : null;
}

async function passwordHashOf(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return user.passwordHash;
}

async function main() {
  expect(
    !process.env.SES_FROM_EMAIL,
    "SES_FROM_EMAIL must be unset so the console email fallback is active"
  );

  await cleanup();

  const user = await prisma.user.create({
    data: {
      username: TAG,
      email: EMAIL,
      passwordHash: await bcrypt.hash(OLD_PASSWORD, 12),
      connectCode: "SMPW#421",
    },
  });

  // 1. Unknown email: silent no-op
  await requestPasswordReset(`${TAG}-nobody@example.invalid`);
  expect(
    (await prisma.passwordResetToken.count({ where: { userId: user.id } })) === 0,
    "unknown email created no token rows"
  );
  console.log("  ok: unknown email is a silent no-op");

  // 2. Request a reset; grab the raw token from the console-fallback email
  const raw1 = await captureResetToken(() => requestPasswordReset(EMAIL));
  expect(raw1 !== null, "dev-fallback email printed a reset URL with a 64-hex token");

  const rows1 = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
  expect(rows1.length === 1, `exactly one token row after first request (got ${rows1.length})`);
  const row1 = rows1[0];
  expect(row1.tokenHash === hashResetToken(raw1!), "stored tokenHash is the sha256 of the raw");
  expect(row1.tokenHash !== raw1, "the raw token itself is never stored");
  expect(row1.usedAt === null, "fresh token is unused");
  expect(isResetTokenRowUsable(row1), "fresh token row is usable");
  const ttl = row1.expiresAt.getTime() - row1.createdAt.getTime();
  expect(
    Math.abs(ttl - RESET_TOKEN_TTL_MS) < 10_000,
    `expiry is ~60 minutes after issue (got ${ttl}ms)`
  );
  console.log("  ok: token row created — hash stored, 60-minute expiry");

  // 3. A second request invalidates the first token
  const raw2 = await captureResetToken(() => requestPasswordReset(EMAIL));
  expect(raw2 !== null && raw2 !== raw1, "second request issued a different token");
  const unused = await prisma.passwordResetToken.count({
    where: { userId: user.id, usedAt: null },
  });
  expect(unused === 1, `prior unused token was invalidated (got ${unused} unused rows)`);
  expect(
    (await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(raw1!) },
    })) === null,
    "first token's row is gone"
  );
  console.log("  ok: re-request invalidates the previous token");

  // 4. Stale and garbage tokens are rejected, password untouched
  expect(
    (await resetPasswordWithToken(raw1!, NEW_PASSWORD)) === false,
    "invalidated token rejected"
  );
  expect(
    (await resetPasswordWithToken("deadbeef".repeat(8), NEW_PASSWORD)) === false,
    "unknown token rejected"
  );
  expect(
    await bcrypt.compare(OLD_PASSWORD, await passwordHashOf(user.id)),
    "password unchanged after rejected attempts"
  );
  console.log("  ok: stale/unknown tokens rejected without touching the password");

  // 5. The live token works: row consumed + password really changed
  expect((await resetPasswordWithToken(raw2!, NEW_PASSWORD)) === true, "valid reset succeeds");
  const consumed = await prisma.passwordResetToken.findUniqueOrThrow({
    where: { tokenHash: hashResetToken(raw2!) },
  });
  expect(consumed.usedAt !== null, "token row was consumed (usedAt stamped)");
  const hashAfter = await passwordHashOf(user.id);
  expect(await bcrypt.compare(NEW_PASSWORD, hashAfter), "new password verifies via bcrypt");
  expect(!(await bcrypt.compare(OLD_PASSWORD, hashAfter)), "old password no longer verifies");
  console.log("  ok: valid token consumed and password actually changed");

  // 6. Single-use: replaying the consumed token fails
  expect(
    (await resetPasswordWithToken(raw2!, "replayed-pass-789")) === false,
    "consumed token cannot be replayed"
  );
  expect(
    await bcrypt.compare(NEW_PASSWORD, await passwordHashOf(user.id)),
    "replay attempt left the password alone"
  );
  console.log("  ok: token is single-use");

  // 7. Expired token rejected (row planted directly with a past expiry)
  const expiredRaw = "ab".repeat(32); // fixed test value, not a secret
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashResetToken(expiredRaw),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  expect(
    (await resetPasswordWithToken(expiredRaw, "expired-pass-000")) === false,
    "expired token rejected"
  );
  expect(
    await bcrypt.compare(NEW_PASSWORD, await passwordHashOf(user.id)),
    "expired attempt left the password alone"
  );
  console.log("  ok: expired token rejected");

  await cleanup();
  console.log("OK: password reset flow (issue, invalidate, consume, single-use, expiry) all pass");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
