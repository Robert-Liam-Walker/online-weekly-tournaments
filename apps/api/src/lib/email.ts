/**
 * email.ts — Outbound email with SES (production) and console (dev) backends.
 *
 * Purpose: Send transactional emails (currently: password reset). Provides one
 * narrow surface (sendEmail) with two backends selected by environment variable,
 * mirroring the same dual-backend pattern as replayStorage.ts.
 *
 * Backends:
 *   SES (production) — active when SES_FROM_EMAIL is set. AWS credentials come
 *     from the default provider chain (env vars, shared config, or the EC2/ECS
 *     instance role on Elastic Beanstalk — none are passed explicitly here).
 *     SES identities are verified in us-east-1; the region is pinned there.
 *
 *   Console (dev, default) — when SES_FROM_EMAIL is unset, the email body is
 *     printed to stdout and the call resolves immediately. This is intentional:
 *     password-reset URLs are readable from the server log in dev, which is the
 *     only delivery channel (no actual email sent). Smoke scripts read the link
 *     from here.
 *
 * From address:
 *   If SES_FROM_EMAIL contains no "<" character, the FROM_DISPLAY_NAME is
 *   prepended to produce a branded "Randall's Nightly Tournaments <addr>" header.
 *   If the env var already includes the angle-bracket form, it is used as-is.
 *
 * Key exports:
 *   sendEmail             — low-level send (to/subject/text/html).
 *   sendPasswordResetEmail — high-level helper that composes text + HTML for the
 *                            standard password-reset flow.
 *   SendEmailInput        — input type for sendEmail.
 *
 * Invariants:
 *   - RESET_LINK_EXPIRY_TEXT must stay in sync with RESET_TOKEN_TTL_MS in
 *     routes/auth.ts (currently 60 minutes). A comment marks the coupling.
 *   - The HTML template escapes all user-supplied values (username, resetUrl)
 *     via escapeHtml to prevent XSS in email clients that render HTML.
 *   - The SESClient is lazily created and cached; never instantiate SESClient
 *     directly outside this module.
 */
import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";

// Outbound email with two backends behind one narrow surface (same shape as
// replayStorage.ts):
//
//   - SES (production): active when SES_FROM_EMAIL is set. Credentials come
//     from the default AWS provider chain (env vars, shared config, or the
//     instance role on Elastic Beanstalk — nothing passed explicitly here).
//     Region is pinned to us-east-1, where our SES identities are verified.
//
//   - Console (dev, default): when SES_FROM_EMAIL is unset, the email is
//     printed to stdout and the promise resolves. This is the only place a
//     password-reset URL may ever be logged — it IS the delivery channel in
//     dev (smoke scripts read the link from here).

const SES_REGION = "us-east-1";

/** Display name shown in recipients' inboxes; the address stays SES_FROM_EMAIL. */
const FROM_DISPLAY_NAME = "Randall's Nightly Tournaments";

let sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (!sesClient) {
    sesClient = new SESClient({ region: SES_REGION });
  }
  return sesClient;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative part; the text part is always sent alongside it. */
  html?: string;
}

/**
 * Send an email using the configured backend (SES or console fallback).
 * @param input - recipient, subject, plain-text body, and optional HTML body.
 *
 * In dev (SES_FROM_EMAIL unset) the email is printed to stdout and resolves
 * immediately — no actual email is sent.
 *
 * @throws {SESServiceException} on SES API errors in production.
 */
export async function sendEmail({ to, subject, text, html }: SendEmailInput): Promise<void> {
  const source = process.env.SES_FROM_EMAIL;

  if (!source) {
    // Dev fallback — no SES configured. Log instead of sending.
    console.log(
      `[email dev fallback] to: ${to}\n[email dev fallback] subject: ${subject}\n${text}`
    );
    return;
  }

  // Branded From header: keep the verified address from SES_FROM_EMAIL,
  // add the product display name (unless the env var already carries one).
  const brandedSource = source.includes("<") ? source : `${FROM_DISPLAY_NAME} <${source}>`;

  await getSesClient().send(
    new SendEmailCommand({
      Source: brandedSource,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: text, Charset: "UTF-8" },
          ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
        },
      },
    })
  );
}

/**
 * Minimal HTML-entity escaper for user-supplied values embedded in the
 * password-reset email HTML template. Covers the characters that matter in
 * attribute and text contexts.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Keep this in sync with RESET_TOKEN_TTL_MS in routes/auth.ts (60 minutes).
const RESET_LINK_EXPIRY_TEXT = "60 minutes";

/**
 * Send a password-reset email to the given address.
 * @param to       - recipient address.
 * @param resetUrl - the full reset URL (already signed / token-embedded).
 * @param username - optional display name for the greeting line.
 *
 * Sends both a plain-text and an HTML body. The URL and username are HTML-
 * escaped in the HTML body to prevent injection. The link expiry text must
 * match RESET_TOKEN_TTL_MS in routes/auth.ts.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  username?: string
): Promise<void> {
  const greeting = username ? `Hi ${username},` : "Hi,";

  const text = [
    greeting,
    "",
    "Someone requested a password reset for the Randall's Nightly Tournaments account using this email address.",
    "",
    `Reset your password here (link expires in ${RESET_LINK_EXPIRY_TEXT}):`,
    resetUrl,
    "",
    "If you didn't request this, you can safely ignore this email — your password will not change.",
    "",
    "— Randall's Nightly Tournaments",
  ].join("\n");

  const safeGreeting = username ? `Hi ${escapeHtml(username)},` : "Hi,";
  const safeUrl = escapeHtml(resetUrl);

  const html = [
    `<div style="font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f7; padding: 24px;">`,
    `  <div style="max-width: 520px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 32px; color: #333333;">`,
    `    <h1 style="font-size: 20px; margin: 0 0 16px 0; color: #1a1a2e;">Randall&#39;s Nightly Tournaments</h1>`,
    `    <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px 0;">${safeGreeting}</p>`,
    `    <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px 0;">Someone requested a password reset for the Randall&#39;s Nightly Tournaments account using this email address.</p>`,
    `    <p style="margin: 0 0 24px 0;">`,
    `      <a href="${safeUrl}" style="display: inline-block; background-color: #4f46e5; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: bold; padding: 12px 24px; border-radius: 6px;">Reset your password</a>`,
    `    </p>`,
    `    <p style="font-size: 13px; line-height: 1.5; margin: 0 0 16px 0; color: #555555;">This link expires in ${RESET_LINK_EXPIRY_TEXT}. If the button doesn&#39;t work, copy and paste this URL into your browser:</p>`,
    `    <p style="font-size: 13px; line-height: 1.5; margin: 0 0 16px 0; word-break: break-all;"><a href="${safeUrl}" style="color: #4f46e5;">${safeUrl}</a></p>`,
    `    <p style="font-size: 13px; line-height: 1.5; margin: 0; color: #555555;">If you didn&#39;t request this, you can safely ignore this email — your password will not change.</p>`,
    `  </div>`,
    `</div>`,
  ].join("\n");

  await sendEmail({
    to,
    subject: "Reset your Randall's Nightly Tournaments password",
    text,
    html,
  });
}
