import PublicFooter from "../components/PublicFooter";

// Public /terms page. Plain-language terms for a free hobby gaming service.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-white mb-2">{title}</h2>
      <div className="text-gray-400 space-y-3 leading-relaxed">{children}</div>
    </section>
  );
}

export default function Terms() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-gray-500 text-sm mb-10">Last updated: June 12, 2026</p>

        <Section title="What this service is">
          <p>
            Randall's Nightly Tournaments is a free, hobby-run platform for
            nightly Super Smash Bros. Melee tournaments played over Slippi
            rollback netplay. There is no entry fee, no prize money, and no
            paid tier at this time. By creating an account or playing in a
            bracket you agree to these terms.
          </p>
        </Section>

        <Section title="Your account">
          <p>
            You need an account with a valid email address, a username, and
            your Slippi connect code to register for tournaments. You are
            responsible for keeping your password private and for what happens
            under your account. One account per person, please.
          </p>
        </Section>

        <Section title="Fair play">
          <p>
            Don't cheat. That includes using modified game clients to gain an
            advantage, exploiting bugs in matchmaking or reporting, deliberately
            lagging opponents, sandbagging to manipulate seeding, or playing on
            someone else's account. Be a reasonable person to your opponents —
            harassment, slurs, and threats are not tolerated.
          </p>
          <p>
            We may disqualify you from a bracket, suspend your account, or
            terminate it entirely if you break these rules. For a free service
            run by one person, that judgment call is ours to make, though we'll
            aim to be fair about it.
          </p>
        </Section>

        <Section title="The game itself">
          <p>
            You must own a legally obtained copy of Super Smash Bros. Melee.
            We do not distribute the game or any Nintendo property. Randall's
            Nightly Tournaments is not affiliated with, endorsed by, or
            connected to Nintendo or the Slippi team.
          </p>
        </Section>

        <Section title="No warranty">
          <p>
            The service is provided as-is and as-available, with no warranty of
            any kind. This is a free hobby project: tournaments may be delayed
            or cancelled, servers may go down mid-bracket, features may change
            or disappear, and the whole service could shut down someday. We are
            not liable for any damages arising from your use of the service, to
            the maximum extent permitted by law.
          </p>
        </Section>

        <Section title="Changes to these terms">
          <p>
            We may update these terms from time to time. If we make a
            significant change we'll note it on this page with a new date.
            Continuing to use the service after a change means you accept the
            updated terms.
          </p>
        </Section>

        <Section title="Governing law">
          <p>
            These terms are governed by the laws of the State of Texas and the
            United States of America.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about these terms? Email{" "}
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
