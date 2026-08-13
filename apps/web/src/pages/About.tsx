// Public About page — what the series is, the ruleset, and where the source
// lives. The in-game walkthrough moved to its own tab (see pages/Gameplay.tsx).
//
// GPL: WEB_REPO_URL/CLIENT_REPO_URL below are also the written offer of source
// for the shipped client (see pages/Download.tsx). Keep CLIENT_REPO_URL pointing
// at the repo the shipped build came from.

const WEB_REPO_URL = "https://github.com/Robert-Liam-Walker/online-weekly-tournaments";

const CLIENT_REPO_URL =
  "https://github.com/Robert-Liam-Walker/online-weekly-tournaments-melee";

const REPOS: Array<{ name: string; url: string; text: string }> = [
  {
    name: "online-weekly-tournaments",
    url: WEB_REPO_URL,
    text: "This website and the API behind it — brackets, matchmaking, accounts, and the weekly scheduler.",
  },
  {
    name: "online-weekly-tournaments-melee",
    url: CLIENT_REPO_URL,
    text: "The game client: a fork of Project Slippi and the Dolphin emulator with the in-game tournament flow built in.",
  },
];

export default function About() {
  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="space-y-10">
        {/* About */}
        <section>
          <h1 className="text-3xl font-bold text-white mb-6">About</h1>
          <div className="bg-gray-800 rounded-xl p-6">
            <p className="text-gray-300 leading-relaxed">
              Online Weekly Tournament Series is a weekly repeating tournament series, every
              Friday at 8PM Eastern, fully online. No sign-up required, no messing with start.gg
              and managing Discord, messaging people to start the match, or stage striking on a
              website. It's all in Dolphin, like Slippi. The website is just an added bonus.
              Download the Dolphin package, click A to register, and you're in when the
              tournament starts. Can't play this Friday? Join us next week!
            </p>
          </div>
        </section>

        {/* Rules */}
        <section>
          <h1 className="text-3xl font-bold text-white mb-6">Rules</h1>
          <div className="bg-gray-800 rounded-xl p-6">
            <ol className="list-decimal list-inside space-y-3 text-gray-300">
              <li>Each event is a 16-player double-elimination bracket, best of 3 sets.</li>
              <li>Matches use the standard Melee ruleset: 4 stocks, 8-minute timer, items off.</li>
              <li>
                Legal stages: Battlefield, Final Destination, Pokémon Stadium, Yoshi's Story,
                Fountain of Dreams, and Dream Land 64.
              </li>
              <li>
                The first game's stage is decided by striking; the loser of each game picks the
                next stage.
              </li>
              <li>No stalling.</li>
              <li>This only works if people show up for the bracket. A no-show three times is a ban.</li>
              <li>Play fair and be respectful. Cheating or harassment is a bannable offense.</li>
            </ol>
          </div>
        </section>

        {/* Codebase */}
        <section>
          <h1 className="text-3xl font-bold text-white mb-6">Codebase</h1>
          <div className="bg-gray-800 rounded-xl p-6">
            <p className="text-gray-300 leading-relaxed mb-5">
              The whole thing is open source, split across two public repositories on GitHub.
            </p>
            <ul className="space-y-5">
              {REPOS.map((repo) => (
                <li key={repo.url}>
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-yellow-500 hover:text-yellow-400 font-semibold underline break-all"
                  >
                    {repo.name}
                  </a>
                  <p className="text-gray-300 leading-relaxed mt-1">{repo.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
