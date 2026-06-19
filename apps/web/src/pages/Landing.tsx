import { useMemo } from "react";
import { Link } from "react-router-dom";
import RandallIcon from "../components/RandallIcon";
import PublicFooter from "../components/PublicFooter";

// Public marketing homepage. Served at "/" for logged-out visitors.
// Renders with ZERO backend dependency — the next-start times below are
// computed entirely client-side from the regions' IANA time zones.

interface Region {
  name: string;
  timeZone: string;
  localLabel: string; // human label for the region's own wall-clock time
}

const REGIONS: Region[] = [
  { name: "EU", timeZone: "Europe/Berlin", localLabel: "8:00 PM Central European Time" },
  { name: "NA East", timeZone: "America/New_York", localLabel: "8:00 PM Eastern" },
  { name: "NA West", timeZone: "America/Los_Angeles", localLabel: "8:00 PM Pacific" },
];

// Read the wall-clock components of `date` as seen in `timeZone`.
function wallClockIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// Convert a wall-clock instant (y/m/d 20:00 in `timeZone`) to a UTC Date.
// Two-pass technique: guess the UTC instant, read back what wall-clock time
// that guess lands on in the zone, and correct by the difference. The second
// pass handles DST-transition edges, so this stays correct year-round.
function zonedEightPmToUtc(timeZone: string, year: number, month: number, day: number): Date {
  const desired = Date.UTC(year, month - 1, day, 20, 0, 0);
  let guess = new Date(desired);
  for (let i = 0; i < 2; i++) {
    const w = wallClockIn(guess, timeZone);
    const actual = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    guess = new Date(guess.getTime() + (desired - actual));
  }
  return guess;
}

// Next occurrence of 8:00 PM in the region's zone: today (region-local) if
// still in the future, otherwise tomorrow.
function nextRegionStart(timeZone: string, now: Date = new Date()): Date {
  const today = wallClockIn(now, timeZone);
  let start = zonedEightPmToUtc(timeZone, today.year, today.month, today.day);
  if (start.getTime() <= now.getTime()) {
    // Add one day to the region-local calendar date; Date.UTC normalizes
    // month/year rollover for us.
    const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    start = zonedEightPmToUtc(
      timeZone,
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate()
    );
  }
  return start;
}

// Format an instant in the VIEWER's local time zone (undefined locale +
// no timeZone option = browser defaults).
function formatLocal(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

const HOW_IT_WORKS: Array<{ title: string; body: string }> = [
  {
    title: "Download the game",
    body: "Grab the free installer for Windows. It sets up Slippi rollback netplay alongside your own Melee ISO and drops a desktop icon.",
  },
  {
    title: "Create an account",
    body: "Register with your email and a username. On first launch the game opens your browser to link your account — just click Approve.",
  },
  {
    title: "Register for tonight",
    body: "Pick your region — EU, NA East, or NA West — and claim one of 32 free spots in tonight's bracket.",
  },
  {
    title: "Check in",
    body: "Check in shortly before the 8pm start so the bracket fills with players who are actually ready.",
  },
  {
    title: "Play from inside the game",
    body: "Your matches appear right in the in-game tournament scene. Win or lose, there's another bracket tomorrow night.",
  },
];

export default function Landing() {
  // Computed once per page load; fine for a "tonight at 8pm" display.
  const startTimes = useMemo(() => {
    const now = new Date();
    return REGIONS.map((r) => ({
      ...r,
      nextStart: formatLocal(nextRegionStart(r.timeZone, now)),
    }));
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Hero */}
      <header className="max-w-5xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="flex justify-center mb-6">
          <RandallIcon size={96} />
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold mb-4">
          Online Nightly Tournament Series
        </h1>
        <p className="text-gray-400 text-lg max-w-2xl mx-auto mb-8">
          Free Super Smash Bros. Melee tournaments every single night, powered by
          Slippi rollback netplay. 32 players, double elimination, no entry fee —
          just show up at 8pm and play.
        </p>
        <div className="flex flex-col sm:flex-row justify-center gap-4">
          <Link
            to="/download"
            className="bg-green-600 hover:bg-green-500 text-white font-bold text-lg px-8 py-3 rounded-lg transition-colors"
          >
            Download the game
          </Link>
          <Link
            to="/login"
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white font-bold text-lg px-8 py-3 rounded-lg transition-colors"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* Region cards */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <h2 className="text-2xl font-bold text-center mb-8">
          Three regions, every night
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {startTimes.map((region) => (
            <div key={region.name} className="bg-gray-900 rounded-xl p-6 text-center">
              <h3 className="text-xl font-bold mb-1">{region.name}</h3>
              <p className="text-gray-400 text-sm mb-4">{region.localLabel}</p>
              <p className="text-green-500 font-semibold mb-1">
                Next bracket: {region.nextStart}
              </p>
              <p className="text-gray-600 text-xs mb-4">shown in your local time</p>
              <ul className="text-gray-400 text-sm space-y-1">
                <li>Free entry</li>
                <li>32 players</li>
                <li>Double elimination</li>
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-3xl mx-auto px-6 pb-8">
        <h2 className="text-2xl font-bold text-center mb-8">How it works</h2>
        <div className="space-y-4">
          {HOW_IT_WORKS.map((step, i) => (
            <div key={step.title} className="bg-gray-900 rounded-lg p-5 flex gap-4">
              <div className="text-green-500 font-bold text-2xl w-8 shrink-0">
                {i + 1}
              </div>
              <div>
                <h3 className="font-semibold mb-1">{step.title}</h3>
                <p className="text-gray-400 text-sm">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-gray-600 text-xs text-center mt-8">
          You must own a legally obtained copy of Super Smash Bros. Melee.
          Online Nightly Tournament Series is not affiliated with Nintendo or the
          Slippi team.
        </p>
      </section>

      <PublicFooter />
    </div>
  );
}
