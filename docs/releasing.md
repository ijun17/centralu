# Releasing

How a version of Centralu reaches users. Publishing is npm-only; there is no download
page and no update server.

## Why the packages are shaped this way

Three packages go to npm:

| Package | Contents | Installed on |
|---|---|---|
| `centralu` | a launcher script, a few KB | every supported platform |
| `centralu-darwin-arm64` | `Centralu.app` | macOS, Apple Silicon |
| `centralu-linux-x64` | `Centralu.AppImage`, `icon.png` | Linux, x86-64 |

(A fourth package, `centralu-linux-arm64`, exists in the repo — `packaging/npm/linux-arm64/`
— but is not wired into the shim yet. See "linux-arm64 (#29)" below.)

`centralu` declares the other two as `optionalDependencies` and carries `os`/`cpu`
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
- `.github/workflows/release.yml` — **the release.** A `v*` tag push publishes all three
  packages, in order, from one run. `workflow_dispatch` rehearses the same thing without a
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

2. **Rehearse.** Actions → `release` → Run workflow, `dry_run` left checked. It builds both
   platforms, packs all three packages and publishes nothing. It asks for no approval:
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
   the wrong commit, or one that outran the version bump, costs seconds rather than two Rust
   release builds. To fix: `git push --delete origin <tag>`, correct, tag again.

4. **Approve.** Publishing waits on the `npm-publish` environment. GitHub asks twice: once
   for the two platform jobs, which wait together, and again for the shim job after both
   have succeeded. That second approval is the last moment anything is reversible.

5. Verify from a machine that has never had it: `npm i -g centralu@beta && centralu`.

### What the job graph guarantees

```
guard ──┬── linux-x64 (ubuntu-22.04) ──┐
        └── darwin-arm64 (macos-14) ───┴── centralu (shim)
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
platform job re-runs its own build and publish, and the shim job re-runs on its own once both
platforms are green. A package that is already on the registry at this version makes its job
fail on re-publish (`EPUBLISHCONFLICT`) rather than doing damage — bump to the next
prerelease if a version genuinely has to be rebuilt.

### Publishing by hand

Still supported, and still the fallback if Actions is down. On an Apple Silicon Mac:

```bash
pnpm release:npm                       # rehearsal: build, copy, verify, npm pack
pnpm release:npm --publish             # publishes centralu-darwin-arm64, then centralu
```

Linux has to come from CI first (`publish-linux-npm.yml`, or `release.yml` with `dry_run`
off), because the second command refuses to publish the shim while any pinned platform
package is missing from the registry at this version.

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
5. Teach the launcher (`packaging/npm/centralu/bin/centralu.mjs`) to resolve and start it.
6. Add it to the matrix in `.github/workflows/build.yml`, so every push builds it.
7. Add it to the matrix in `.github/workflows/release.yml`, so every release publishes it.
   Steps 3 and 7 have to land together — `tooling/release-workflow.test.ts` fails on either
   one alone, which is the point: a pin with no job strands a half-published release, and a
   job with no pin ships users a launcher that cannot find its own app.

## linux-arm64 (#29)

Steps 1, 2 and 6 above are done; steps 3, 4 and 5 are deliberately not, because all three
assume `centralu-linux-arm64` already exists on the npm registry, and nothing arm64 has
ever been built here, let alone published.

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

**Why the rest waits.** `packaging/npm/centralu/package.json`'s `optionalDependencies` pin
exact versions, and `assertPinnedPlatformsPublished` in `scripts/release-npm.mts` refuses
to publish the shim while any pinned platform is missing from the registry at the release
version. Pin `centralu-linux-arm64` there before it is ever published, and the *next*
ordinary darwin/x64 release cannot publish the shim until arm64 catches up too — the trap
the guard exists to prevent, aimed at this repo's own next release instead of a user's
install. `tooling/brand.test.ts`'s platform list would fail for the same reason (its
exact-match assertion checks the shim's `optionalDependencies`, which would not yet have
the entry). The launcher's `TARGETS` table carries its own comment on this exact rule:
listing a package that was never released turns "not supported yet" into "your install is
broken."

**Enabling it.** The precondition that used to sit here — "once a build has actually run
green on `ubuntu-22.04-arm`" — is met: run 32381990293 answered both of #29's open questions
with evidence rather than reasoning. `node-pty` (no Linux prebuild at any architecture, so
node-gyp compiles it on the runner) and `better-sqlite3` both build on arm64, and the
AppImage tooling produces a bundle of a size consistent with x64. What a green build still
does not prove is that it *launches*; nobody has started it, on either Linux architecture.

The four steps below have to land in one commit. Each is a promise the others keep: the pin
without the job strands a half-published release at the shim, and the job without the pin
publishes a package no launcher will ever look for. `tooling/release-workflow.test.ts` fails
on any partial state, and `tooling/brand.test.ts` on step 2's absence.

1. Add `"centralu-linux-arm64": "<version>"` to `optionalDependencies` in
   `packaging/npm/centralu/package.json` (`os` already lists `linux`, so no change there).
2. Add `{ dir: 'linux-arm64', bundle: `${APP_NAME}.AppImage` }` to the `platforms` array in
   `tooling/brand.test.ts`, and delete the parked-package test added alongside it for #29
   (the one asserting the package is *not* yet in `optionalDependencies`).
3. Add `'linux-arm64': { pkg: 'centralu-linux-arm64', artifact: `${APP_NAME}.AppImage` }` to
   `TARGETS` in `packaging/npm/centralu/bin/centralu.mjs`.
4. Uncomment the `linux-arm64` matrix entry in `.github/workflows/release.yml` — two `#`.
   Then rehearse (`workflow_dispatch`, `dry_run` on) before tagging: that job has never run.
