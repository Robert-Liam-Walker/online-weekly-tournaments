import "dotenv/config"; // load apps/api/.env when run standalone (run from apps/api/)
// End-to-end smoke test for the tournament replay-attachment routes, run
// against the live dev API (does not touch the DB directly):
//   npx -w apps/api tsx scripts/smoke-replay.ts
//
// Exercises the validation paths (401 / 404 / 403 / 400 / 422) using the
// seeded demo tournaments. The happy parse path needs a real .slp and is
// covered separately by the decideVerification unit tests.

const BASE = "http://127.0.0.1:3001";

interface TournamentSummary {
  id: string;
  name: string;
  status: string;
}

interface TournamentDetail {
  entries: Array<{ user: { id: string; username: string; connectCode: string } }>;
  matches: Array<{ matchKey: string; player1Id: string | null; player2Id: string | null }>;
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function gameLogin(connectCode: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE}/api/auth/game-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectCode }),
  });
  if (!res.ok) throw new Error(`game-login ${connectCode} failed: ${res.status}`);
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

function emptyForm(): FormData {
  return new FormData();
}

function garbageForm(): FormData {
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([Buffer.from("this is definitely not a slippi replay, just junk bytes")]),
    "garbage.slp"
  );
  return fd;
}

async function postReplay(
  token: string | null,
  tournamentId: string,
  matchKey: string,
  form: FormData
) {
  const res = await fetch(
    `${BASE}/api/replays/${tournamentId}/matches/${encodeURIComponent(matchKey)}/replay`,
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    }
  );
  return { status: res.status, body: (await res.json()) as { error?: unknown } };
}

async function waitForApi(tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/api/tournaments`);
      if (res.ok) return;
    } catch {
      // not up yet (tsx watch may be mid-restart)
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API at ${BASE} not reachable`);
}

async function main() {
  await waitForApi();

  // --- locate a seeded demo tournament with a fully-decided match ---------
  const tournaments = (await (await fetch(`${BASE}/api/tournaments`)).json()) as TournamentSummary[];
  const preferred = ["Sweet Sixteen Demo", "Live Bracket Demo"];
  const wede = await gameLogin("WEDE#971");

  let tournamentId: string | null = null;
  let tournamentName = "";
  let match: TournamentDetail["matches"][number] | null = null;
  let codeOf = new Map<string, string>();

  for (const name of preferred) {
    const t = tournaments.find((x) => x.name === name);
    if (!t) continue;
    const detail = (await (
      await fetch(`${BASE}/api/tournaments/${t.id}`, {
        headers: { authorization: `Bearer ${wede.token}` },
      })
    ).json()) as TournamentDetail;
    codeOf = new Map(detail.entries.map((e) => [e.user.id, e.user.connectCode]));
    // For the 403 path the uploader (WEDE) must not be in the match.
    const candidate = detail.matches.find(
      (m) =>
        m.player1Id &&
        m.player2Id &&
        m.player1Id !== wede.userId &&
        m.player2Id !== wede.userId
    );
    if (candidate) {
      tournamentId = t.id;
      tournamentName = name;
      match = candidate;
      break;
    }
  }
  if (!tournamentId || !match) {
    throw new Error("No seeded demo tournament with a decided match found — reseed dev events");
  }
  const participantCode = codeOf.get(match.player1Id!);
  if (!participantCode) throw new Error("Could not map match player1 to a connect code");
  const participant = await gameLogin(participantCode);

  console.log(`Using "${tournamentName}" (${tournamentId}), match ${match.matchKey},`);
  console.log(`  non-participant WEDE#971, participant ${participantCode}\n`);

  const listUrl = `${BASE}/api/replays/${tournamentId}/matches/${encodeURIComponent(
    match.matchKey
  )}/replays`;
  const before = (await (
    await fetch(listUrl, { headers: { authorization: `Bearer ${participant.token}` } })
  ).json()) as { replays: unknown[] };

  // --- validation paths ----------------------------------------------------
  console.log("POST /api/replays/:tournamentId/matches/:matchKey/replay");

  const noAuth = await postReplay(null, tournamentId, match.matchKey, emptyForm());
  check("401 without a token", noAuth.status === 401, noAuth);

  const unknownMatch = await postReplay(wede.token, tournamentId, "ZZ9-99", emptyForm());
  check("404 unknown matchKey", unknownMatch.status === 404, unknownMatch);

  const unknownTournament = await postReplay(wede.token, "not-a-tournament-id", "W1-1", emptyForm());
  check("404 unknown tournament id", unknownTournament.status === 404, unknownTournament);

  const nonParticipant = await postReplay(wede.token, tournamentId, match.matchKey, emptyForm());
  check("403 non-participant uploader", nonParticipant.status === 403, nonParticipant);

  const noFile = await postReplay(participant.token, tournamentId, match.matchKey, emptyForm());
  check("400 participant but no file attached", noFile.status === 400, noFile);

  const badFile = await postReplay(participant.token, tournamentId, match.matchKey, garbageForm());
  check("422 participant with unparseable .slp", badFile.status === 422, badFile);

  console.log("\nGET /api/replays/:tournamentId/matches/:matchKey/replays");

  const listRes = await fetch(listUrl, {
    headers: { authorization: `Bearer ${participant.token}` },
  });
  const listBody = (await listRes.json()) as { replays: unknown[] };
  check("200 with a replays array", listRes.status === 200 && Array.isArray(listBody.replays));
  check(
    "no rows persisted by the rejected uploads",
    listBody.replays.length === before.replays.length,
    { before: before.replays.length, after: listBody.replays.length }
  );

  const list404 = await fetch(
    `${BASE}/api/replays/${tournamentId}/matches/ZZ9-99/replays`,
    { headers: { authorization: `Bearer ${participant.token}` } }
  );
  check("404 listing an unknown match", list404.status === 404);

  console.log("");
  if (failures > 0) throw new Error(`${failures} smoke check(s) failed`);
  console.log("SMOKE OK: all replay-route validation paths behave as specified");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
