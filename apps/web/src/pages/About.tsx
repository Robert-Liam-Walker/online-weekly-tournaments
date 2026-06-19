export default function About() {
  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="grid md:grid-cols-3 gap-6 items-start">
        {/* Left: About */}
        <section>
          <h1 className="text-3xl font-bold text-white mb-6">About</h1>
          <div className="bg-gray-800 rounded-xl p-6">
            <p className="text-gray-300 leading-relaxed">
              Online Nightly Tournament Series is a daily (nightly) repeating tournament series,
              fully online. No sign-up required, no messing with start.gg and managing Discord,
              messaging people to start the match, or stage striking on a website. It's all in
              Dolphin, like Slippi. The website is just an added bonus. Download the Dolphin
              package, click A to register, and you're in when the tournament starts. Can't
              play tonight? Join us tomorrow!
            </p>
          </div>
        </section>

        {/* Right: Rules */}
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

        {/* Far right: Gameplay */}
        <section>
          <h1 className="text-3xl font-bold text-white mb-6">Gameplay</h1>
          <div className="bg-gray-800 rounded-xl p-6 space-y-4">
            <img
              src="/gameplay/1.png"
              alt="Linking your game from the browser"
              className="w-full rounded-lg border border-gray-700"
            />
            <img
              src="/gameplay/2.png"
              alt="Choosing Online Play in the in-game menu"
              className="w-full rounded-lg border border-gray-700"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
