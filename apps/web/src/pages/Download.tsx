// Public downloads page — the funnel's front door. There is no launcher and no
// installer: the download is a portable .zip of the game client (Dolphin)
// itself. You unzip it, point it at your own Melee ISO, and double-click to
// play. Login is automatic on first boot (the game opens the browser approval
// page) — no launcher, no separate sign-in app.
//
// NOTE: the source repos are private, so the .zip is hosted on a public S3
// bucket (nts-downloads-826671498662) rather than GitHub release assets.
// Replace the object in that bucket to ship a new build (same URL, no code bump).

import PublicFooter from "../components/PublicFooter";

const ZIP_URL =
  "https://nts-downloads-826671498662.s3.amazonaws.com/Nightly-Tournament-Service-Win.zip";

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Download and unzip",
    body: "Download the .zip and extract it anywhere (your Desktop is fine).",
  },
  {
    title: "Add your Melee ISO",
    body: "Open Slippi Dolphin.exe from the unzipped folder. The first time, add the folder that holds your own NTSC 1.02 Melee ISO under Config → Paths (we never distribute the game).",
  },
  {
    title: "Launch and approve",
    body: "Double-click Melee to boot. The first launch opens your browser to the link page — sign in (or create an account) and click Approve. The game picks up the link in a few seconds. One time only; it stays linked.",
  },
  {
    title: "Play tonight at 8pm",
    body: "Open Online Play and register for tonight's free bracket. 16-player double elimination, best of 3, every single night.",
  },
];

export default function Download() {
  return (
    <div className="bg-gray-950">
      <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="text-center mb-10">
        <img src="/favicon.svg" alt="Online Nightly Tournament Series" className="w-24 h-24 mx-auto mb-4" />
        <h1 className="text-4xl font-bold text-white mb-3">Online Nightly Tournament Series</h1>
        <p className="text-gray-400 text-lg mb-6">
          Free Melee brackets every night at 8pm. Powered by Slippi's open-source rollback netcode.
        </p>
        <a
          href={ZIP_URL}
          className="inline-block bg-green-600 hover:bg-green-500 text-white font-bold text-lg px-8 py-3 rounded-lg transition-colors"
        >
          Download for Windows (.zip)
        </a>
        <p className="text-gray-600 text-sm mt-3">Windows 10/11, 64-bit</p>
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
        Tournaments is not affiliated with Nintendo or the Slippi team.
      </p>
      </div>
      <PublicFooter />
    </div>
  );
}
