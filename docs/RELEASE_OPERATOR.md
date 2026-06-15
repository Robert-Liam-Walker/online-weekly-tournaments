# Release runbook — candidate → stable (operator)

Releases flow **candidate → stable**. Artifacts are immutable + versioned; the
public launcher only reads **stable**. Promotion and rollback are a one-line S3
pointer flip — never a rebuild. Owner-facing summary: `docs/RELEASE_ROBERT.md`.

## Prerequisites
- **`RELEASE_S3_BUCKET`** must be set — a dedicated S3 bucket for release
  manifests (your profile + the EB instance role must read/write it). The
  channel store is **OFF until this is set**, so deploying this code changes
  nothing about the served manifest until you opt in. It must also be set on
  the **EB environment** for the API to serve channels.
- **AWS creds** come from your profile (`~/.aws`). `release.ts` does NOT load
  the API's `.env`, so its placeholder AWS keys won't shadow your profile —
  just don't `export AWS_ACCESS_KEY_ID=placeholder` into the shell yourself.
- Dolphin build env (only when rebuilding Dolphin):
  `DXSDK_DIR="C:\Program Files (x86)\Microsoft DirectX SDK (June 2010)\"`,
  `MSYS2_ARG_CONV_EXCL="*"`, cargo on PATH.

## 1. Build + hash the artifacts
- **Dolphin** (only if the C++ changed): from `dolphin/`,
  `msbuild /p:Configuration=Release /p:Platform=x64 Source/Dolphin.sln /m` →
  `Binary/x64/Slippi Dolphin.exe`. Package the Win zip per the FoxTrotMelee
  `docs/ENGINEERING-NOTES.md` "Releasing" rules: **forward-slash zip via System32 `tar.exe`
  (never PowerShell `Compress-Archive`), never include `User/`**. `sha256sum` it.
- **Scene**: `cd ssbm-c && bash build-foxtrot.sh` → `output/FoxTrotTournaments-exi.dat`
  (bundled into gamefiles).
- **Gamefiles**: tag `gamefiles-v<version>` + push → `release-gamefiles.yml`
  builds `foxtrot-gamefiles-<version>.zip` (+`.sha256`) on **randalls-dolphin**.
  Grab the URL + sha256.
- **Launcher** (only if changed): published on **randalls-launcher**
  (`Randalls-Nightly-Tournaments-Setup-<version>.exe` + `latest.yml`).
  electron-updater self-update is separate from this manifest.
- **Protocol bump** on breaking changes: bump BOTH `FOXTROT_PROTOCOL_VERSION`
  (`Tournaments.c`) and `FOXTROT_EXI_PROTOCOL_VERSION` (`EXI_DeviceSlippi.cpp`)
  together; a mismatch shows "UPDATE FOXTROT REQUIRED" in-game.

## 2. Publish an immutable snapshot
```sh
export RELEASE_S3_BUCKET=<release-bucket>   # S3_REGION/AWS_REGION, RELEASE_API_BASE, RELEASE_GH_OWNER are optional
npx tsx apps/api/scripts/release.ts publish --id v2.1.0 \
  --dolphin-version 2.1.0 --dolphin-url <dolphin-zip-url> --dolphin-sha256 <hex> \
  --gamefiles-version 2.1.0 --gamefiles-url <gamefiles-zip-url> --gamefiles-sha256 <hex> \
  --launcher-min 0.2.0
```
Writes `manifests/releases/v2.1.0.json` (immutable — refuses to overwrite an
existing id). Prints the S3 console link + artifact URLs + sha256s.

## 3. Point candidate, then test
```sh
npx tsx apps/api/scripts/release.ts promote --channel candidate --release v2.1.0
```
Fresh-install E2E — launch the **installed** app on the candidate channel:
- PowerShell: `$env:FOXTROT_CHANNEL='candidate'; & "$env:LOCALAPPDATA\Programs\foxtrot-launcher\Randall's Nightly Tournaments.exe"`
- cmd: `set FOXTROT_CHANNEL=candidate && "%LOCALAPPDATA%\Programs\foxtrot-launcher\Randall's Nightly Tournaments.exe"`

The launcher pulls `…/api/launcher/manifest?channel=candidate`, downloads +
(gamefiles) sha-verifies + extracts, then: link account → register → play a
ranked Bo3 → bracket advances. **Only promote to stable if this passes.**

## 4. Promote to stable (the public launch button)
```sh
npx tsx apps/api/scripts/release.ts promote --channel stable --release v2.1.0
```
Public installs now get v2.1.0 (`…/api/launcher/manifest`, ~60s cache). The
command prints the manifest/S3 links + the exact **rollback command**.

## 5. Rollback
Repoint stable to the previous release id — instant, no rebuild, no re-test:
```sh
npx tsx apps/api/scripts/release.ts promote --channel stable --release <previous-id>
```

## Channel resolution + fallback
`/api/launcher/manifest?channel=stable|candidate` (default `stable`): when
`RELEASE_S3_BUCKET` is set and the channel pointer exists → returns that
immutable snapshot in the **exact v1 schema**; otherwise it falls back to the
legacy env-var manifest. So dev (no bucket) and pre-cutover prod keep working
unchanged.

## Hash-enforcement gap
The launcher **enforces gamefiles sha256** before extract. The
**Dolphin/launcher sha256 is recorded in the manifest but NOT enforced** by the
current launcher (metadata until launcher enforcement is added — fine for MVP).

## S3 layout / status
```
manifests/releases/<id>.json      immutable snapshot (v1 manifest body + sha256s)
manifests/channels/stable.json    { "release": "<id>" }
manifests/channels/candidate.json { "release": "<id>" }
```
`npx tsx apps/api/scripts/release.ts status` prints both channel pointers, the
manifest URLs, and the GitHub release pages.
