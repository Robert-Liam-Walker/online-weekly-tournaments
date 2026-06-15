# Releases — owner guide

Plain-language guide to launching and rolling back. Full detail for the
operator: `docs/RELEASE_OPERATOR.md`.

The public app only ever pulls the **stable** release. New builds go to
**candidate** first, get tested, then you flip **stable** — that flip *is* the
public launch.

## Launch (after the candidate passes its test)
```sh
npx tsx apps/api/scripts/release.ts promote --channel stable --release <release-id>
```
Done. Everyone gets it on their next launcher check (~1 min).

## Roll back
```sh
npx tsx apps/api/scripts/release.ts promote --channel stable --release <previous-release-id>
```
Instant, no rebuild. (The previous id is printed every time you promote — keep it.)

## Safety rules
- **Never reuse a version number** — snapshots are immutable; always bump
  (e.g. `v2.1.0` → `v2.1.1`).
- **Never promote a candidate that hasn't passed a fresh-install test** (below).
- **The public only ever sees `stable`.** Candidate is for internal testing.

## Test a candidate (fresh install)
Point candidate at the build (`… promote --channel candidate --release <id>`),
then launch the **installed** app on the candidate channel:
- **PowerShell:** `$env:FOXTROT_CHANNEL='candidate'; & "$env:LOCALAPPDATA\Programs\foxtrot-launcher\Randall's Nightly Tournaments.exe"`
- **cmd:** `set FOXTROT_CHANNEL=candidate && "%LOCALAPPDATA%\Programs\foxtrot-launcher\Randall's Nightly Tournaments.exe"`

It downloads the candidate Dolphin + gamefiles; play a full ranked Bo3 to confirm.

## Where things live
(`release.ts` prints the exact, clickable links every time you publish or
promote — these are the templates, with `<id>` = the release id and
`<RELEASE_S3_BUCKET>` = your release bucket.)

- **S3 bucket:** `https://s3.console.aws.amazon.com/s3/buckets/<RELEASE_S3_BUCKET>?region=us-east-1&prefix=manifests/`
- **Snapshot:** `https://s3.console.aws.amazon.com/s3/object/<RELEASE_S3_BUCKET>?region=us-east-1&prefix=manifests/releases/<id>.json`
- **Stable pointer:** `…&prefix=manifests/channels/stable.json` · **Candidate pointer:** `…&prefix=manifests/channels/candidate.json`
- **Live manifest (public / stable):** https://randallsnightly.com/api/launcher/manifest
- **Live manifest (candidate):** https://randallsnightly.com/api/launcher/manifest?channel=candidate
- **Dolphin + gamefiles releases:** https://github.com/Robert-Liam-Walker/randalls-dolphin/releases
- **Launcher releases:** https://github.com/Robert-Liam-Walker/randalls-launcher/releases

## One caveat
The **gamefiles** download is hash-verified (a corrupt or tampered gamefiles is
rejected). The **Dolphin and launcher** downloads have their hash *recorded but
not yet enforced* by the installed launcher — fine for now, worth hardening later.
