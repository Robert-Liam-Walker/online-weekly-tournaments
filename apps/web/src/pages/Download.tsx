// Public downloads page — the funnel's front door. There is no launcher: the
// download is a one-time installer for the game client (Dolphin) itself. It
// installs the client, asks for your ISO, and drops a desktop icon that boots
// straight into Melee. Login is automatic on first boot (the game opens the
// browser approval page) — no launcher, no separate sign-in app.
//
// NOTE: the installer asset lives on the public game-client repo
// (randalls-dolphin) releases. The filename is version-pinned, so bump
// INSTALLER_URL whenever a new installer is published.

import PublicFooter from "../components/PublicFooter";

const INSTALLER_URL =
  "https://github.com/Robert-Liam-Walker/randalls-dolphin/releases/latest/download/Randalls-Nightly-Tournaments-Setup-0.3.0.exe";
const RELEASES_URL = "https://github.com/Robert-Liam-Walker/randalls-dolphin/releases/latest";

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Download and install",
    body: "Run the installer. Windows SmartScreen may warn about an unsigned app — choose More info, then Run anyway. During setup you pick your own NTSC 1.02 Melee ISO (we never distribute the game) and can add a desktop icon.",
  },
  {
    title: "Launch from your desktop icon",
    body: "Double-click the Nightly Tournaments icon. It boots your game client straight into Melee — there's no launcher to open first.",
  },
  {
    title: "Approve in your browser",
    body: "The first time you launch, the game opens your browser to the link page — sign in (or create an account) and click Approve. The game picks up the link in a few seconds. One time only; it stays linked.",
  },
  {
    title: "Play tonight at 8pm",
    body: "Open Online Play and register for tonight's free regional — EU, NA East, or NA West. 16-player double elimination, best of 3, every single night.",
  },
];

export default function Download() {
  return (
    <div className="min-h-screen bg-gray-950">
      <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="text-center mb-10">
        <img src="/favicon.svg" alt="Nightly Tournaments" className="w-24 h-24 mx-auto mb-4" />
        <h1 className="text-4xl font-bold text-white mb-3">Nightly Tournaments</h1>
        <p className="text-gray-400 text-lg mb-6">
          Free Melee brackets every night — EU, NA East, and NA West at 8pm local. Powered by
          Slippi rollback netplay.
        </p>
        <a
          href={INSTALLER_URL}
          className="inline-block bg-green-600 hover:bg-green-500 text-white font-bold text-lg px-8 py-3 rounded-lg transition-colors"
        >
          Download for Windows
        </a>
        <p className="text-gray-600 text-sm mt-3">
          Windows 10/11, 64-bit ·{" "}
          <a href={RELEASES_URL} className="underline hover:text-gray-400">
            all releases
          </a>
        </p>
      </div>

      <div className="space-y-4">
        {STEPS.map((step, i) => (
          <div key={step.title} className="bg-gray-800 rounded-lg p-5 flex gap-4">
            <div className="text-green-500 font-bold text-2xl w-8 shrink-0">{i + 1}</div>
            <div>
              <h2 className="text-white font-semibold mb-1">{step.title}</h2>
              <p className="text-gray-400 text-sm">{step.body}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-gray-600 text-xs text-center mt-10">
        You must own a legally obtained copy of Super Smash Bros. Melee. Nightly
        Tournaments is not affiliated with Nintendo or the Slippi team. The game client and
        emulator are open source (GPL) — sources at github.com/Robert-Liam-Walker.
      </p>
      </div>
      <PublicFooter />
    </div>
  );
}
