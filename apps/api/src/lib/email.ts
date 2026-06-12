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
