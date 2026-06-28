export default function About() {
  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="space-y-10">
        {/* Top: How to Play */}
        <section>
          <h1 className="text-3xl font-bold text-white mb-6">How to Play</h1>
          <ol className="grid sm:grid-cols-2 gap-6 items-start">
            {[
              {
                num: "1",
                img: "/gameplay/2.png",
                title: "Open Online Play",
                text: "From the main menu, choose Online Play to drop straight into tonight's tournament — no sign-in, no start.gg.",
              },
              {
                num: "2a",
                img: "/gameplay/3.png",
                title: "Check the bracket - Winners side",
                text: "Press Y to see the full double-elimination bracket. The winners rounds run across into the grand finals up top.",
              },
              {
                num: "2b",
                img: "/gameplay/4.png",
                title: "Losers Bracket",
                text: "One loss isn't the end. Press Down to flip to the losers bracket and fight your way back to grand finals.",
              },
              {
                num: "3",
                img: "/gameplay/5.png",
                title: "Pick your character",
                text: "When your match is called you're taken to character select — no rank, no clutter. Choose your main and press Start.",
              },
              {
                num: "4",
                img: "/gameplay/7.png",
                title: "Strike for stage",
                text: "Strike stages to decide where you play. After game one, the loser of the previous game counterpicks the next stage.",
              },
              {
                num: "5",
                img: "/gameplay/6.png",
                title: "Play your set",
                text: "Battle it out best-of-three on Slippi's rollback netcode. The result reports automatically and the bracket advances.",
              },
            ].map((step) => (
              <li key={step.img} className="bg-gray-800 rounded-xl p-6">
                <div className="flex items-center gap-3 mb-3">
                  <span className="flex-shrink-0 min-w-[2rem] h-8 px-2 rounded-full bg-yellow-600 text-gray-900 font-bold flex items-center justify-center">
                    {step.num}
                  </span>
                  <h2 className="text-xl font-semibold text-white">{step.title}</h2>
                </div>
                <p className="text-gray-300 leading-relaxed mb-4">{step.text}</p>
                <img
                  src={step.img}
                  alt={step.title}
                  className="w-full rounded-lg border border-gray-700"
                />
              </li>
            ))}
          </ol>
        </section>

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
      </div>
    </div>
  );
}
