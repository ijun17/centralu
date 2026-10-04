# Releasing

How a version of Centralu reaches users. Publishing is npm-only; there is no download
page and no update server.

## Why the packages are shaped this way

Five packages go to npm:

| Package | Contents | Installed on |
|---|---|---|
| `centralu` | a launcher script, a few KB | every supported platform |
| `centralu-darwin-arm64` | `Centralu.app` | macOS, Apple Silicon |
| `centralu-linux-x64` | `Centralu.AppImage`, `icon.png` | Linux, x86-64 |
| `centralu-linux-arm64` | `Centralu.AppImage`, `icon.png` | Linux, arm64 — from 0.1.0-beta.3 |
| `@centralu/win32-x64` | a `Centralu\` folder: `centralu.exe`, `resources\host\` | Windows, x86-64 — from 0.1.0-beta.9 |

`centralu` declares the others as `optionalDependencies` and carries `os`/`cpu`
fields on each of them, so npm installs exactly one bundle for the machine doing the
installing. This is the same layout esbuild and swc use, and the reason is size: nobody
downloads a macOS bundle onto a Linux box.

Two consequences that shape the procedure below:

- **The pins are exact versions, not ranges.** A range would let a platform package
  update on its own, leaving the launcher and the app it launches at different versions.
  So every platform package must exist at the version being released *before* the
  `centralu` shim that points at them goes out.
- **A bundle can only be built on the platform it ships to.** `scripts/release-npm.mts`
  refuses to package one it did not build here, because all of its checks — code
  signature, exec bit, machine type — read the real artifact. There is no cross-build
  switch on purpose: it could only produce something unverified.

Publishing is irreversible. npm blocks unpublish after 24 hours. That is why the release
script rehearses by default and why nothing publishes automatically.

## What CI does

- `.github/workflows/build.yml` — builds every platform on every push and PR and uploads
  the bundles as artifacts. Since nobody on the project owns a Linux machine, this is the
  only place a Linux build is ever exercised. Download the artifact to try it; GitHub
  artifacts are zips and drop the exec bit, so `chmod +x` the AppImage after unzipping.
- The same workflow builds **windows-x64** (#14) and uploads two artifacts:
  `centralu-windows-x64`, a portable folder (`Centralu\centralu.exe` beside
  `Centralu\resources\host\`), and `centralu-windows-x64-setup`, the NSIS installer
  (per-user, no admin rights). The folder is what an npm package can ship, the way the
  AppImage ships for Linux: npm can unpack a folder and start an exe, but cannot run an
  installer. The installer's one advantage is that it installs the WebView2 runtime on a
  machine without it. Neither is signed, so SmartScreen asks before the first start. The
  Windows job also runs the Rust unit tests, and a separate `windows tests` job runs the
  four parts of `pnpm verify`. Lint, dependency rules and types block there as anywhere; the
  unit-test step does not yet (`continue-on-error` on that step only), so the job stays green
  and a warning annotation gives the failing count, with the failing files in the job summary.
  Its known failures are listed in #307; once they are fixed the step should block. The npm
  package `@centralu/win32-x64` ships the same folder, built again by `release.yml`'s own
  Windows job (see [Windows](#windows-14-w3) below).
- `.github/workflows/release.yml` — **the release.** A `v*` tag push publishes every
  package, in order, from one run. `workflow_dispatch` rehearses the same thing without a
  tag (`dry_run`, default on). See below.
- `.github/workflows/publish-linux-npm.yml` — the predecessor: `centralu-linux-x64` alone,
  `workflow_dispatch` only, dry run by default. `release.yml` replaces it and does strictly
  more. It is kept, working, until `release.yml` has done one real release — deleting the
  path that shipped 0.1.0-beta.2 before its successor has ever shipped anything would trade
  a proven thing for an untested one. Delete it after that release.

A push to a branch or a merge still publishes nothing. **A `v*` tag now does** — that is what
the tag is for.

## One-time setup

1. Create an npm token with **Bypass 2FA** (npmjs.com → Access Tokens → Granular). What the
   UI used to call an *automation* token is now this checkbox. A publish-type token still
   demands a one-time code, and a workflow has nobody to type it: the first release found
   this as a bare `EOTP` after a full build (#29).
2. Repo → Settings → Environments → **New environment** named `npm-publish`. Add yourself
   as a required reviewer. Add the token there as the secret `NPM_TOKEN` — in the
   environment, not at repo level, so no other workflow can reach it.

## Releasing a version

1. Bump `APP_VERSION` in `packages/protocol/src/brand.ts`, and the same version in
   `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` and
   `apps/desktop/package.json`. `tooling/brand.test.ts` fails if any of them disagree.
   Commit and push — the release script refuses to run on a dirty tree, so that what ships
   and what is in git cannot differ.

2. **Rehearse.** Actions → `release` → Run workflow, `dry_run` left checked. It builds every
   platform, packs every package and publishes nothing. It asks for no approval:
   `npm pack` needs no token, and gating a rehearsal costs an approval per attempt — three
   were spent that way on the first release.

   Read the `npm pack` output for each package. The shim job ends with a yellow warning that
   the platform packages are not on the registry at this version; that is the truth about a
   rehearsal, not a fault.

3. **Tag it.** The tag is the release:

   ```bash
   git tag v0.1.0-beta.3 && git push origin v0.1.0-beta.3
   ```

   `release.yml` checks the tag against `APP_VERSION` before anything is built, so a tag on
   the wrong commit, or one that outran the version bump, costs seconds rather than four Rust
   release builds. To fix: `git push --delete origin <tag>`, correct, tag again.

4. **Approve.** Publishing waits on the `npm-publish` environment. GitHub asks twice: once
   for the four platform jobs, which wait together, and again for the shim job after all of
   them have succeeded. That second approval is the last moment anything is reversible.

5. Verify from a machine that has never had it: `npm i -g centralu@beta && centralu`.

### What the job graph guarantees

```
guard ──┬── linux-x64 (ubuntu-22.04) ──────┐
        ├── linux-arm64 (ubuntu-22.04-arm) ─┤
        ├── darwin-arm64 (macos-14) ────────┤
        └── win32-x64 (windows-2022) ───────┴── centralu (shim)
```

The shim pins its platform packages at an *exact* version, so it may only go out once every
one of them is already on the registry. `needs` on the matrix job means **every** entry
succeeded — which keeps being true when a platform is added, without anyone remembering to
update it. `scripts/release-npm.mts` re-checks the registry itself before publishing the
shim, so the graph is the first line of defence rather than the only one.

`tooling/release-workflow.test.ts` holds the matrix and the shim's `optionalDependencies` to
the same list, in both directions: a pinned platform with no job to build it strands a
half-published release, and a job for a platform the shim never pins ships users a launcher
that cannot find its own app.

### When a job fails halfway

Nothing is undone, and nothing needs to be. Re-run the failed job from the same run: a
platform job re-runs its own build and publish, and the shim job re-runs on its own once every
platform is green. A package that is already on the registry at this version makes its job
fail on re-publish (`EPUBLISHCONFLICT`) rather than doing damage — bump to the next
prerelease if a version genuinely has to be rebuilt.

### Publishing by hand

Still supported, and still the fallback if Actions is down. On an Apple Silicon Mac:

```bash
pnpm release:npm                       # rehearsal: build, copy, verify, npm pack
pnpm release:npm --publish             # publishes centralu-darwin-arm64, then centralu
```

Linux and Windows have to come from CI first (`release.yml` with `dry_run` off; for
linux-x64 alone, also `publish-linux-npm.yml`), because the second command refuses to
publish the shim while any pinned platform package is missing from the registry at this
version.

A release build produces only the `.app`, not the `.dmg` the plain `pnpm app` build also
makes. That is deliberate twice over: a release should build what it publishes, and the
DMG step is the one that can fail for reasons unrelated to the code — Tauri's
`bundle_dmg.sh` drives Finder through `osascript`, so a shell with no GUI session behind
it (an agent, an ssh session) is denied Automation access and exits 64. Losing a release
to that, with a correctly built and signed `.app` already sitting there, is not a trade
worth making. CI still builds the `.dmg`, which is where a genuine break in it should show.

Flags:

| Flag | What it does |
|---|---|
| `--skip-build` | reuse the bundle already in `target/release/bundle` |
| `--otp=123456` | a one-time code, for an account with 2FA and a token that asks for one |
| `--platform-only` | the platform package, not the shim — what each platform job runs |
| `--shim-only` | the shim, nothing else. Needs no bundle and no particular host, so it runs anywhere; the registry check is what keeps it last |
| `--also-latest` | also point the `latest` dist-tag at this prerelease |

`--also-latest` is on by default in `release.yml` and needs to be **turned off at 1.0**. It
exists because `latest` is empty while no stable release exists, and `npm i -g centralu`
(no tag) then fails outright with "No matching version found for centralu@latest". Once a
stable release exists, moving `latest` onto a prerelease hands betas to everyone who asked
for stable: change `also_latest=true` in the workflow's `guard` job and the input's default
to `false` at the same time as the 1.0 bump.

## Adding a platform

1. Add an entry to `TARGETS` in `scripts/release-npm.mts` — bundle location, how to copy
   it, and the checks that prove the copy is intact, executable and the right machine.
   Do not skip a check because the platform has no equivalent; find what it was standing
   in for. (Linux has no code signature, so it checks the AppImage magic instead: the
   point of the signature check was "this file is what we think it is and is not
   truncated".)
2. Add `packaging/npm/<id>/package.json` with matching `os`/`cpu`/`files`.
3. Add it to `optionalDependencies` and `os` in `packaging/npm/centralu/package.json`.
4. Add it to the list in `tooling/brand.test.ts` so the version pin is enforced.
5. Teach the launcher to resolve and start it: an entry in `TARGETS` in
   `packaging/npm/centralu/bin/platform.mjs` (which `tooling/launcher-platform.test.ts`
   holds to the shim's pins), and whatever starting it takes in `centralu.mjs`.
6. Add it to the matrix in `.github/workflows/build.yml`, so every push builds it.
7. Add it to the matrix in `.github/workflows/release.yml`, so every release publishes it.
   Steps 3 and 7 have to land together — `tooling/release-workflow.test.ts` fails on either
   one alone, which is the point: a pin with no job strands a half-published release, and a
   job with no pin ships users a launcher that cannot find its own app.

## Windows (#14, W3)

All seven steps above landed together for 0.1.0-beta.8, for the reason the linux-arm64
section below gives: a pin can only be added in the change that publishes what it points at.

**Why this one is scoped.** The other platform packages are unscoped (`centralu-<id>`), but the first publish of `centralu-win32-x64` (0.1.0-beta.8, 2026-10-05) was refused by the registry with `403 … Package name triggered spam detection`. The `@centralu` scope belongs to the owner's npm organization, so a scoped name cannot be refused that way or taken by anyone else. Users never type it: the shim pulls it in as an optional dependency, and the launcher resolves it by name. The CI token must be allowed to publish under `@centralu`.

**The package.** `@centralu/win32-x64` (`os: win32`, `cpu: x64`) carries the portable folder
`build.yml` has uploaded since W1 (#307): `Centralu\centralu.exe` beside
`Centralu\resources\host\`. Tauri looks for its resources next to the exe when nothing is
installed, so the folder runs where npm unpacked it. ARM64 Windows with native Node skips the
package and the launcher says the platform is not supported yet; nothing is published for it.

**The release job.** `win32-x64` on `windows-2022` in `release.yml`'s platform matrix, under
the same `npm-publish` gate as the others. `scripts/release-npm.mts` runs it like any other
target, with three differences, each commented where it is made:

- It builds with `tauri build --no-bundle`. The NSIS installer is not what ships, and a
  release builds what it publishes.
- It runs `pnpm lint`, `pnpm depcruise` and `pnpm typecheck` instead of `pnpm verify`. The
  unit tests have known failures on Windows (the W2 list in #307). The full `pnpm verify`
  runs on the same commit in every other platform job and in the shim job, and the shim
  cannot go out unless they all pass. Drop this exception when the W2 list is empty.
- Its checks read the PE header instead of a code signature and exec bit: `MZ` and `PE\0\0`
  (the file is what we think it is), the subsystem is GUI (a console-subsystem exe would open
  a console window on every start), the machine is x86-64, and `main.mjs` and `conpty.node`
  sit beside it.

**What the launcher does on Windows** (`packaging/npm/centralu/bin/platform.mjs`, tested on
every OS by `tooling/launcher-platform.test.ts`):

| Command | What happens |
|---|---|
| `centralu` | Checks the registry for the WebView2 Runtime. If it is missing, prints the download link and exits instead of starting an exe that would end without a window. Otherwise starts `centralu.exe` **detached**, from the installed copy if there is one and from the npm package if not, and watches it for 3 s: an exe that exits nonzero in that time gets a message with the WebView2 link and the `host.log` path |
| `centralu install` | Copies the folder to `%LOCALAPPDATA%\Programs\Centralu` and writes a Start-menu shortcut (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Centralu.lnk`). The new copy is assembled beside the old one and swapped in, so a failed copy or a running app leaves the working install untouched |
| `centralu update` | `npm i -g centralu@<latest>` (through the shell, because `npm` is `npm.cmd`), then refreshes the installed copy if there is one |
| `centralu uninstall` | Removes the copy and the shortcut. Leaves `%USERPROFILE%\.centralu` alone |

Why a copy, like macOS, rather than a shortcut into the package, like Linux: Windows will not
replace a running program's files. With the app running from inside the npm package,
`npm i -g centralu@newer` fails with EBUSY. Running from the copy leaves the package free to
update. Either way the launcher says when Windows refused because the app is still running.

Detached is not optional. libuv puts every non-detached child in a job object that kills it
when the parent exits, so an attached app would close when the launcher returns or the
console window is closed. `windowsHide` stays off: it starts the process with SW_HIDE, which a
GUI program applies to its first window.

**Unsigned: SmartScreen.** There is no Windows code signing. SmartScreen keys on the
mark-of-the-web that browsers attach to downloads, and npm does not attach it, so an npm
install is expected to start without a prompt. That is the same reasoning as macOS
quarantine, but unmeasured on Windows. The CI artifact downloaded as a zip does carry the
mark. When SmartScreen does show "Windows protected your PC", click **More info → Run
anyway**. Smart App Control (on by default only on clean Windows 11 installs) can block an
unsigned exe outright with no such button; whether it does for this one is unknown.

**WebView2.** Windows 11 includes the runtime, and current Windows 10 usually has it. The NSIS
installer would install it; an npm install cannot, so the launcher checks first (the three
registry locations in Microsoft's distribution guide) and points at the Evergreen
Bootstrapper. If `reg.exe` cannot be run, the check answers "unknown" and the app starts
anyway, because a broken check should not block a launch.

**What is still unproven.** Nobody has run `npm i -g centralu` on Windows: not the launcher,
not the shortcut, not an update while the app is open. The release job has run as a dry run
only. Paths are about 180 characters deep under a default npm prefix, which is inside
`MAX_PATH` for ordinary profile names but has not been checked against a long one.

## linux-arm64 (#29)

All seven steps above are done as of 0.1.0-beta.3. Three of them (1, 2 and 6) landed early,
because they cost nothing to have ready; the other four had to wait for the release that
publishes the package, for the reason below. The history is worth keeping: this is the shape
every *next* platform will have to move in too.

**Why the runner works, and why it is not just plugged in anyway.** GitHub hosts
`ubuntu-22.04-arm` — the same distro version as the `ubuntu-22.04` pin `build.yml` already
uses for x64, so pointing a matrix entry at it does not raise the minimum glibc for arm64
users the way an arm64 image at a newer distro would have. That label went GA for public
repositories on 2025-08-07
([GitHub changelog](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)),
free, and GA for private repositories followed on 2026-01-29
([GitHub changelog](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/)) —
usable there too, but *not* free the way public-repo usage is: it draws from the plan's
included minutes and then bills per minute (Tauri's own CI guide independently points at
the same two labels: <https://v2.tauri.app/distribute/pipelines/github/>). `ijun17/centralu`
is a public repo as of this writing, where the runner is free, so `build.yml`'s matrix entry
was turned on (`bb403d1`) and the build is green (run 32381990293). It is written as a plain
matrix entry rather than something conditional on today's visibility, because `build.yml`
runs on every push and every PR with no human approving each run: **if the repo ever goes
private again, comment that entry back out first** — that is the one thing this paragraph
cannot do for you, and a visibility flip would otherwise turn into a silent bill.
`publish-linux-npm.yml` and `release.yml` are different: publishing is already
gated behind the `npm-publish` environment, so a human already has to choose to run it —
generalizing its `target` input to include `linux-arm64` does not add a new way for this
to happen by accident.

**Why it waited, and why 0.1.0-beta.3 is when it stopped waiting.**
`packaging/npm/centralu/package.json`'s `optionalDependencies` pin exact versions, and
`assertPinnedPlatformsPublished` in `scripts/release-npm.mts` refuses to publish the shim
while any pinned platform is missing from the registry at the release version. Pinning
`centralu-linux-arm64` on an ordinary day would therefore have wedged the *next*
darwin/x64 release behind a package nothing had built — the trap that guard exists to
prevent, aimed at this repo instead of at a user's install. The pin can only be added in
the same change that publishes what it points at, and `release.yml` is what makes that one
change: the arm64 job publishes the package, and the shim job does not start until it has.
That is why all four edits below landed in a single commit for beta.3, and why
`tooling/release-workflow.test.ts` fails on any partial state.

1. `"centralu-linux-arm64": "<version>"` in `optionalDependencies` in
   `packaging/npm/centralu/package.json` (`os` already listed `linux`).
2. `{ dir: 'linux-arm64', bundle: `${APP_NAME}.AppImage` }` in the `platforms` array in
   `tooling/brand.test.ts`, replacing the parked-package test.
3. `'linux-arm64': { pkg: 'centralu-linux-arm64', artifact: `${APP_NAME}.AppImage` }` in
   `TARGETS` in `packaging/npm/centralu/bin/centralu.mjs`.
4. The `linux-arm64` matrix entry in `.github/workflows/release.yml`.

**What is still unproven.** Run 32381990293 answered both of #29's build questions with
evidence: `node-pty` (no Linux prebuild at any architecture, so node-gyp compiles it on the
runner) and `better-sqlite3` both build on arm64, and the AppImage tooling produces a bundle
of a size consistent with x64. A green build does not prove it *launches*, and nobody has
started one — on either Linux architecture. That is the same thing already true of the x64
package shipped in beta.2, and the README says so on both.
