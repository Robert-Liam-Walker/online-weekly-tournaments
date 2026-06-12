import PublicFooter from "../components/PublicFooter";

// Public /privacy page. Honest, plain-language privacy policy.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-white mb-2">{title}</h2>
      <div className="text-gray-400 space-y-3 leading-relaxed">{children}</div>
    </section>
  );
}

export default function Privacy() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-gray-500 text-sm mb-10">Last updated: June 12, 2026</p>

        <Section title="What we store">
          <p>We keep the data needed to run nightly tournaments, and not much else:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Your email address (for sign-in and password resets)</li>
            <li>Your username</li>
            <li>Your Slippi connect code</li>
            <li>Match results — who played whom, scores, and bracket placements</li>
            <li>Match replays from tournament sets</li>
          </ul>
          <p>
            Passwords are stored hashed — we never keep or see your actual
            password.
          </p>
        </Section>

        <Section title="What we do with it">
          <p>
            We use this data to run brackets, report results, show standings,
            and keep your account working. Usernames, connect codes, match
            results, and replays from tournament play are visible to other
            players — that's the nature of a public bracket.
          </p>
        </Section>

        <Section title="What we don't do">
          <p>
            We do not sell your data. We do not share it with advertisers. We
            do not send marketing emails — the only emails you'll get from us
            are transactional, like a password reset you requested.
          </p>
        </Section>

        <Section title="Deleting your data">
          <p>
            If you want your account and personal data removed, email us and
            we'll take care of it. Match results may remain in historical
            bracket records, but they'll no longer be tied to your personal
            details.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If this policy changes in any meaningful way, we'll update this
            page with a new date.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions, or a data request? Email{" "}
            <a
              href="mailto:robert.liam.walker@gmail.com"
              className="text-green-500 hover:text-green-400"
            >
              robert.liam.walker@gmail.com
            </a>
            .
          </p>
        </Section>
      </div>
      <PublicFooter />
    </div>
  );
}
