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

- `.github/workflows/build.yml` — builds both platforms on every push and PR and uploads
  the bundles as artifacts. Since nobody on the project owns a Linux machine, this is the
  only place a Linux build is ever exercised. Download the artifact to try it; GitHub
  artifacts are zips and drop the exec bit, so `chmod +x` the AppImage after unzipping.
- `.github/workflows/publish-linux-npm.yml` — publishes `centralu-linux-x64`.
  `workflow_dispatch` only, dry run by default, gated behind the `npm-publish`
  environment. It never publishes the `centralu` shim.

Nothing publishes on a push, a tag, or a merge.

## One-time setup

1. Create an npm **automation** token (npmjs.com → Access Tokens → Granular/Automation).
   A classic publish token still prompts for a 2FA code, and a workflow has nobody to
   type it — the run would hang instead of failing.
2. Repo → Settings → Environments → **New environment** named `npm-publish`. Add yourself
   as a required reviewer. Add the token there as the secret `NPM_TOKEN` — in the
   environment, not at repo level, so no other workflow can reach it.

## Releasing a version

1. Bump `APP_VERSION` in `packages/protocol/src/brand.ts`, and the same version in
   `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` and
   `apps/desktop/package.json`. `tooling/brand.test.ts` fails if any of them disagree.
   Commit — the release script refuses to run on a dirty tree, so that what ships and
   what is in git cannot differ.

2. **Linux first.** Actions → `publish-linux-npm` → Run workflow with `dry_run` checked.
   Read the `npm pack` output. Then run it again with `dry_run` unchecked and approve the
   environment prompt. Now `centralu-linux-x64@<version>` is on the registry.

3. **macOS, then the shim.** On an Apple Silicon Mac:

   ```bash
   pnpm release:npm                       # rehearsal: build, copy, verify, npm pack
   pnpm release:npm --publish             # publishes centralu-darwin-arm64, then centralu
   ```

   The second command publishes the shim last and refuses to do so if any pinned platform
   package is missing from the registry at this version — which is what step 2 was for.

   A release build produces only the `.app`, not the `.dmg` the plain `pnpm app` build also
   makes. That is deliberate twice over: a release should build what it publishes, and the
   DMG step is the one that can fail for reasons unrelated to the code — Tauri's
   `bundle_dmg.sh` drives Finder through `osascript`, so a shell with no GUI session behind
   it (an agent, an ssh session) is denied Automation access and exits 64. Losing a release
   to that, with a correctly built and signed `.app` already sitting there, is not a trade
   worth making. CI still builds the `.dmg`, which is where a genuine break in it should show.

   Useful flags: `--skip-build` reuses an existing bundle, `--otp=123456` for accounts with
   2FA, `--platform-only` publishes the platform package without the shim, `--also-latest`
   points the `latest` dist-tag at a prerelease (only correct while no stable release
   exists — a prerelease is tagged `beta` otherwise, and `npm i -g centralu` with an empty
   `latest` fails outright).

4. Verify from a clean machine: `npm i -g centralu@beta && centralu`.

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
6. Add it to the matrix in `.github/workflows/build.yml`.

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
is a public repo as of this writing, where the runner is free, but `build.yml` runs on
every push and every PR with no human approving each run, and repo visibility can change —
so the matrix entry in `build.yml` is commented out rather than conditional on today's
visibility, which is the one option that cannot turn a later visibility flip into a silent
bill. `publish-linux-npm.yml` is different: it is `workflow_dispatch`-only and already
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

**Enabling it**, once a build has actually run green on `ubuntu-22.04-arm` (uncomment the
matrix entry in `build.yml` first — expect the first run to fail: `node-pty` has no Linux
prebuild at any architecture and is compiled by node-gyp on whatever runner runs this, which
has only ever been x64 so far, and `better-sqlite3` raises the identical question) and
`centralu-linux-arm64` is published at the release version (`publish-linux-npm.yml`,
`target: linux-arm64`):

1. Add `"centralu-linux-arm64": "<version>"` to `optionalDependencies` in
   `packaging/npm/centralu/package.json` (`os` already lists `linux`, so no change there).
2. Add `{ dir: 'linux-arm64', bundle: `${APP_NAME}.AppImage` }` to the `platforms` array in
   `tooling/brand.test.ts`, and delete the parked-package test added alongside it for #29
   (the one asserting the package is *not* yet in `optionalDependencies`).
3. Add `'linux-arm64': { pkg: 'centralu-linux-arm64', artifact: `${APP_NAME}.AppImage` }` to
   `TARGETS` in `packaging/npm/centralu/bin/centralu.mjs`.
