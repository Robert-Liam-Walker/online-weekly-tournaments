import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";

// Outbound email behind one narrow surface (sendEmail), with three backends
// selected by env — precedence: Resend -> SES -> console:
//
//   - Resend (MVP default for real delivery): active when RESEND_API_KEY is
//     set. POSTs the Resend HTTP API; the sender domain (randallsnightly.com)
//     is verified in Resend via Route53 DNS. Chosen for the MVP so password
//     resets reach arbitrary recipients WITHOUT waiting on AWS SES production
//     access.
//
//   - SES (fallback only): active when SES_FROM_EMAIL is set and no Resend key.
//     Credentials come from the default AWS provider chain (the EB instance
//     role). Region pinned to us-east-1. NOTE: SES is still sandboxed
//     (production access denied), so it only delivers to verified recipients.
//
//   - Console (dev, default): when neither is configured, the email is printed
//     to stdout and the promise resolves — the delivery channel in dev (smoke
//     scripts read the password-reset link from here).
//
// EMAIL_PROVIDER (resend|ses|console) forces a backend; else the precedence
// above applies. Same narrow-surface shape as replayStorage.ts.

const SES_REGION = "us-east-1";

/** Display name shown in recipients' inboxes; the address stays the From env value. */
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

type EmailProvider = "resend" | "ses" | "console";

function resolveProvider(): EmailProvider {
  const explicit = process.env.EMAIL_PROVIDER?.toLowerCase();
  if (explicit === "resend" || explicit === "ses" || explicit === "console") {
    return explicit;
  }
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SES_FROM_EMAIL) return "ses";
  return "console";
}

/** Branded From header, e.g. `Randall's Nightly Tournaments <no-reply@…>`. */
function brandedFrom(address: string): string {
  return address.includes("<") ? address : `${FROM_DISPLAY_NAME} <${address}>`;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  switch (resolveProvider()) {
    case "resend":
      return sendViaResend(input);
    case "ses":
      return sendViaSes(input);
    default:
      console.log(
        `[email dev fallback] to: ${input.to}\n[email dev fallback] subject: ${input.subject}\n${input.text}`
      );
      return;
  }
}

async function sendViaResend({ to, subject, text, html }: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const from = brandedFrom(
    process.env.RESEND_FROM_EMAIL ||
      process.env.SES_FROM_EMAIL ||
      "no-reply@randallsnightly.com"
  );
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text, ...(html ? { html } : {}) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 500)}`);
  }
}

async function sendViaSes({ to, subject, text, html }: SendEmailInput): Promise<void> {
  const source = process.env.SES_FROM_EMAIL;
  if (!source) throw new Error("SES_FROM_EMAIL is not set");
  await getSesClient().send(
    new SendEmailCommand({
      Source: brandedFrom(source),
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
    `    <p style="font-size: 13px; line-height: 1.5; margin: 0; color: #555555;">If you didn't request this, you can safely ignore this email — your password will not change.</p>`,
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
