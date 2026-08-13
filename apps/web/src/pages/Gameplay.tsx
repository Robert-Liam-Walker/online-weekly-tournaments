// Public "How to Play" walkthrough — screenshots of the in-game flow, from the
// main menu through to reporting a set. Lives on its own tab (/gameplay) rather
// than on /about so the walkthrough is linkable on its own.

const STEPS: Array<{ num: string; img: string; title: string; text: string }> = [
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
];

export default function Gameplay() {
  return (
    <div className="max-w-6xl mx-auto p-6">
      <section>
        <h1 className="text-3xl font-bold text-white mb-6">How to Play</h1>
        <ol className="grid sm:grid-cols-2 gap-6 items-start">
          {STEPS.map((step) => (
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
    </div>
  );
}
