// Public downloads page — the funnel's front door. Links the latest
// published launcher installer (GitHub Releases serves the asset; the
// /latest/download path always points at the newest version).

import PublicFooter from "../components/PublicFooter";

const INSTALLER_URL =
  "https://github.com/Robert-Liam-Walker/randalls-launcher/releases/latest/download/Randalls-Nightly-Tournaments-Setup-0.1.0.exe";
const RELEASES_URL = "https://github.com/Robert-Liam-Walker/randalls-launcher/releases/latest";

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Install the launcher",
    body: "Run the installer. Windows SmartScreen may warn about an unsigned app — choose More info, then Run anyway. The launcher installs to its own folder and never touches an existing Slippi Launcher setup.",
  },
  {
    title: "Sign in with Slippi and pick your ISO",
    body: "The quick-start walks you through logging into your Slippi account and selecting your own NTSC 1.02 Melee ISO. We never distribute the game.",
  },
  {
    title: "Create your account and link your device",
    body: "Register here on the website, then enter the 6-character code the game shows you on the Device page. One time only — your game stays linked.",
  },
  {
    title: "Play tonight at 8pm",
    body: "Boot the game from the launcher, open Online Play, and register for tonight's free regional — EU, NA East, or NA West. 32-player double elimination, best of 3, every single night.",
  },
];

export default function Download() {
  return (
    <div className="min-h-screen bg-gray-950">
      <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="text-center mb-10">
        <img src="/favicon.png" alt="Randall" className="w-24 h-24 mx-auto mb-4" />
        <h1 className="text-4xl font-bold text-white mb-3">Randall's Nightly Tournaments</h1>
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
        You must own a legally obtained copy of Super Smash Bros. Melee. Randall's Nightly
        Tournaments is not affiliated with Nintendo or the Slippi team. Launcher and emulator
        are open source (GPL) — sources at github.com/Robert-Liam-Walker.
      </p>
      </div>
      <PublicFooter />
    </div>
  );
}
