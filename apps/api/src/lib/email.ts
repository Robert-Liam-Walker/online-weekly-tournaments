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
}

export async function sendEmail({ to, subject, text }: SendEmailInput): Promise<void> {
  const source = process.env.SES_FROM_EMAIL;

  if (!source) {
    // Dev fallback — no SES configured. Log instead of sending.
    console.log(
      `[email dev fallback] to: ${to}\n[email dev fallback] subject: ${subject}\n${text}`
    );
    return;
  }

  await getSesClient().send(
    new SendEmailCommand({
      Source: source,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Text: { Data: text, Charset: "UTF-8" } },
      },
    })
  );
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Reset your FoxTrot password",
    text: [
      "Hi,",
      "",
      "Someone requested a password reset for the FoxTrot account using this email address.",
      "",
      "Reset your password here (link expires in 60 minutes):",
      resetUrl,
      "",
      "If you didn't request this, you can safely ignore this email — your password will not change.",
      "",
      "— FoxTrot",
    ].join("\n"),
  });
}
