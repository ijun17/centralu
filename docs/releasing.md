# Releasing

How a version of Centralu reaches users. Publishing is npm-only; there is no download
page and no update server.

## Why the packages are shaped this way

Eight packages go to npm:

| Package | Contents | Installed on |
|---|---|---|
| `centralu` | a launcher script, a few KB | every supported platform |
| `@centralu/darwin-arm64` | `Centralu.app` | macOS, Apple Silicon |
| `@centralu/linux-x64` | `Centralu.AppImage`, `icon.png`, `host/` | Linux, x86-64 |
| `@centralu/linux-arm64` | `Centralu.AppImage`, `icon.png`, `host/` | Linux, arm64 |
| `@centralu/win32-x64` | a `Centralu\` folder: `centralu.exe`, `resources\host\` | Windows, x86-64 — from 0.1.0-beta.9 |
| `@centralu/host-linux-x64`, `@centralu/host-linux-arm64`, `@centralu/host-win32-x64` | `host/` only, about 3.7 MB packed | a remote a hub installs on, never by npm ([below](#host-only-packages)) |

**The platform packages are scoped (`@centralu/…`) from 0.1.0-beta.10.** The first publish of an unscoped `centralu-win32-x64` (0.1.0-beta.8) was refused with `403 … Package name triggered spam detection`; the `@centralu` scope belongs to the owner's npm organization, so nobody can take or squat a name under it. Up to 0.1.0-beta.9, macOS and Linux shipped as `centralu-darwin-arm64`, `centralu-linux-x64` and `centralu-linux-arm64`; those stay on the registry, marked deprecated, so older shims that pin them keep installing. The shim itself stays the unscoped `centralu`, because it is the name people type; it is managed by the organization through its `developers` team. Users never type a platform package's name.

The Linux packages carry the bundled host a second time, unpacked, as `host/` beside the AppImage. `centralu serve`
(the remote mode's headless host, [agent-host.md](agent-host.md) §4.7) runs it with the system Node; the copy inside
the AppImage is only reachable by mounting the AppImage (FUSE, which servers often lack) or extracting it on every
start. It costs about 11 MB. macOS and Windows need no second copy: `Centralu.app/Contents/Resources/resources/host`
and `Centralu\resources\host` are plain folders already. `scripts/release-npm.mts` copies it from
`src-tauri/resources/host` and checks that `main.mjs`, `bundle-info.json` (for this machine) and both native modules
are there.

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
- On macOS, CI passes `--bundles app` and uploads `Centralu-app.tar.gz`, preserving the app's
  executable bits and signature. It no longer creates or uploads a DMG (#628): intermittent
  `bundle_dmg.sh` failures blocked otherwise valid builds, and no workflow consumes that image.
  `release.yml` builds its own app through `release-npm.mts`; npm publishes the staged `.app`,
  never a DMG, so there is no release DMG step to retry.
- The same workflow builds **windows-x64** (#14) and uploads two artifacts:
  `centralu-windows-x64`, a portable folder (`Centralu\centralu.exe` beside
  `Centralu\resources\host\`), and `centralu-windows-x64-setup`, the NSIS installer
  (per-user, no admin rights). The folder is what an npm package can ship, the way the
  AppImage ships for Linux: npm can unpack a folder and start an exe, but cannot run an
  installer. The installer's one advantage is that it installs the WebView2 runtime on a
  machine without it. Neither is signed, so SmartScreen asks before the first start. The
  Windows job also runs the Rust unit tests, and a separate `windows tests` job runs the
  four parts of `pnpm verify`, each blocking as on the other platforms. (The unit-test step
  did not block until the W2 failures listed in #307 were fixed.) The host's own tests also
  run on the Node remotes are pinned to ([below](#the-node-remotes-run-82)). The npm
  package `@centralu/win32-x64` ships the same folder, built again by `release.yml`'s own
  Windows job (see [Windows](#windows-14-w3) below).
- The same workflow runs the Playwright suite (`e2e/`) on ubuntu-24.04 in WebKit and in
  Chromium, the two engines the desktop app renders in, each split into shards that run side by
  side (the `e2e (webkit i/n)` and `e2e (chromium i/n)` jobs). When a shard fails,
  `e2e report` merges each engine's shard reports into one HTML report with traces and uploads
  them as the `e2e-report` artifact, a folder per engine.
- `.github/workflows/release.yml` — **the release.** A `v*` tag push publishes every
  package, in order, from one run. `workflow_dispatch` rehearses the same thing without a
  tag (`dry_run`, default on). See below.

A push to a branch or a merge still publishes nothing. **A `v*` tag now does** — that is what
the tag is for.

### Reusing the bump PR's CI (#629)

For `rehearse` and `tag`, the board can use the bump PR's green required checks while
main's checks are pending or absent. The PR must be merged into main from
`release.branchPrefix` plus the current version, main's head must be its single-parent
squash merge commit, and `git rev-parse <sha>^{tree}` must match for main and the PR head.
Even a later commit with an unchanged tree invalidates this evidence. Every required
check on that exact PR head must be reported and green; missing, pending or failed
checks refuse it. `bump` still requires main's own green CI.

Main's green checks are used directly. A failing main check blocks reuse, including a
run that was pending at rehearsal and fails before tagging: every call reads CI again.
Both steps and `release_status` name their evidence, for example
`CI: PR #624's run on the same tree`, or explain why main's CI is required. Status's
next step waits for CI when neither source qualifies.

Release CI reads only GitHub Actions check suites belonging to the configured CI
workflow files, matching their run's commit and event: push-to-main for main, and
pull-request runs for the PR head. Release/rehearsal checks with the same job names
cannot replace build checks; check names alone are not evidence of their source.

Tagging does not authorize publication. Before every `npm-publish` approval (platform
jobs and the later shim job), `approve` requires main's **own** CI to be green, with
no PR fallback. If main moved, the tagged commit's own CI must also be green: newer
main checks cannot hide a failure on the code about to ship. Pending, absent or failed
CI refuses approval, and tagged `release_status` explains this gate before suggesting
approval. Direct approval in GitHub's UI is outside this tool's enforcement.

Workflow event audit (2026-10-13):

| Workflow and jobs | Event-dependent behavior | Required for this CI gate? |
| --- | --- | --- |
| `build.yml`: `bundle`, `verify`, `content-verify`, `windows-tests`, `e2e`, `e2e-chromium`, `e2e-report`, `ux-tasks`, `host-tests-remote-node`, `keeper`, `keeper-linux` | No job or step branches on push-to-main versus PR. OS, cancellation and earlier-job outcomes select some steps; concurrency uses the ref but does not change test behavior. | Yes: the configured CI workflow, unless branch protection specifies the set. |
| `release.yml`: `guard`, `platform`, `shim` | Tag push or manual dispatch; `guard` validates the tag on push and dry-run controls publishing. Neither main push nor PR runs it. | No; rehearsal remains a separate tag prerequisite. |
| `shell-release.yml`: `guard`, `build`, `publish` | Manual dispatch only. | No. |
| `local-content-sign.yml`: `validate`, `sign` | Manual dispatch only; real signing requires main. | No. |
| `drift.yml`: `claude-sdk`, `codex-protocol` | Schedule or manual dispatch only. | No. |
| `discord-notify.yml`: `notify` | Issue, PR and discussion notifications (`pull_request_target`, not build CI). | No. |

Before reusing PR evidence, the tool audits the configured `ci.workflows` files from
main's fetched commit against the required check names. A required job with event/branch
context (including inline shell scripts), one outside a shared push/PR workflow, or a required name it cannot
map to an audited job requires main's own run and says why. This is conservative:
unsupported workflow shapes do not grant an exemption. No workflow conditions are
changed by this optimization.

The automated event audit does not follow scripts called by workflow steps, package
scripts, imported modules, local actions, or reusable workflows. Those need manual
review for event-dependent behavior (including environment variables) when they
change. A clean inline scan is not proof that called code behaves identically. If a
required called script behaves differently on push-to-main and pull requests, wait
for main's own green run before invoking `rehearse` or `tag`; the automated fallback
cannot establish equivalence for that script. Publication still waits for main's
own CI through the approval gate above.

## One-time setup

1. Create an npm token with **Bypass 2FA** (npmjs.com → Access Tokens → Granular). What the
   UI used to call an *automation* token is now this checkbox. A publish-type token still
   demands a one-time code, and a workflow has nobody to type it: the first release found
   this as a bare `EOTP` after a full build (#29).
2. Repo → Settings → Environments → **New environment** named `npm-publish`. Add yourself
   as a required reviewer. Add the token there as the secret `NPM_TOKEN` — in the
   environment, not at repo level, so no other workflow can reach it.

## Releasing a version

The project board app (`.centralu/apps/project-board`) carries these steps as tools (#386):
`release_status` says where the release stands and what is next, and `release` takes `step`
`bump`, `rehearse`, `tag` or `approve`. Each step is for a login with maintain or admin
permission, checks everything first (a clean checkout on main at GitHub's main, qualifying green CI,
the version untagged, a successful rehearsal before the tag) and refuses with every reason, and
does nothing without `confirm: true`. The board's "Release" dialog shows the same state.

Before rehearsing, wait for main's checks with
`node .centralu/apps/project-board/bin/wait-checks.mjs --ref main` (a commit SHA works too).
The ref is resolved once; output includes its pinned SHA, such as `repo@main (abc1234)`.
It allows workflow runs to register and waits for active runs to complete before deciding
on checks, including jobs that register late.
The existing `<pr|owner/repo#pr>` form waits for a pull request.
The default deadline is 90 minutes; use `--timeout-minutes <minutes>` with either form to
change it. Waiting for approval (`waiting` or `action_required`) ends immediately with an
action-needed message. No workflow runs and no checks for two minutes means "nothing to wait
for". Cancelled runs have their own outcome; "superseded by a newer push (cancelled)" is shown
only when a newer run on the same workflow, branch, event, and repository has a different SHA.
A failed `gh` request gets three retries after 1, 2, and 4 seconds. Polling, retries, and `gh`
subprocesses all share the overall deadline.

| Exit | Meaning |
|---|---|
| 0 | Checks passed |
| 1 | Checks failed |
| 2 | Invalid arguments or GitHub error after retries |
| 3 | Approval or other action required |
| 4 | Nothing to wait for after the registration grace period |
| 5 | Cancelled, with supersession reported when confirmed |
| 6 | Overall timeout |

Release tools still enforce the required-check set.

The bump scans every tracked text file on remote main, with no extension or e2e exclusion.
It reports each unexpected reference as `file:line`, including the exact version followed by
`.local.N` or `+build` (optionally with dot-separated build identifiers), inside template strings,
and in unquoted text. Different prereleases and metadata are not hits: `1.0.0-beta.21`,
`1.0.0-rc` and `1.0.0+other` do not pin `1.0.0`. Nor does a different numeric or alphanumeric
continuation (`beta.210` when checking `beta.21`). In `package.json`, dependency values starting
with `^`, `~`, `>=` or `workspace:` are exempt only under the top-level `dependencies`,
`devDependencies`, `peerDependencies` and `optionalDependencies` fields. Exact pins, the package's
own `version`, scripts and other fields are still checked, with their original line numbers.
Automatic replacement still changes only whole single- or double-quoted versions in
`release.versionFiles`; derive embedded runtime/test values from `APP_VERSION`.

Historical references and intentional pins belong in `release.ignore` in
`.centralu/apps/project-board/project.json`. This explicit path allowlist uses the same patterns
as `versionFiles`: `*` matches within a path segment and `**` matches zero or more folders.
The repository allows `docs/**/*.md`, `**/CHANGELOG*`, `**/release-notes/**/*.md`,
`**/pnpm-lock.yaml`, `**/package-lock.json`, `**/npm-shrinkwrap.json` and `**/*.lock`.
These files are scanned only when they are declared in `versionFiles`: that list always wins,
so the app's own versions in `Cargo.lock` must still be current and are bumped.
For a fixture that deliberately pins a historical version, add its exact path, for example
`"fixtures/pinned-version.json"`, to `release.ignore` and explain the pin in the fixture or its
test. `tooling/project-board-release.test.ts` is explicitly allowed because its regression cases
intentionally pin stable and prerelease versions. Other fixtures and tests are not exempt by
default. Keep exemptions narrow; they skip the whole file. `release` with `step: "bump"` and no `confirm` runs these checks without pushing or opening
a release PR (and still reports other readiness problems, such as not being on main).

The steps by hand:

1. Bump `APP_VERSION` in `packages/protocol/src/brand.ts`, and the same version in every
   file listed under `release.versionFiles` in `.centralu/apps/project-board/project.json`:
   `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` (and
   `Cargo.lock`), `apps/desktop/package.json` and every `packaging/npm/*/package.json`
   (including the shim's pins). `tooling/brand.test.ts` fails if any of them disagree, and
   `tooling/project-board-release.test.ts` if a file carries the version without being on that
   list. Commit and push — the release script refuses to run on a dirty tree, so that what ships
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

Nothing is undone, and nothing needs to be. **Re-run the failed jobs from the same run**: a
platform job re-runs its own build and publish, and the shim job re-runs on its own once every
platform is green.

A re-run finishes the release rather than tripping over it. Before each publish,
`release-npm.mts` asks the registry for that exact version (`scripts/release-registry.mts`):

| On the registry at this version | What the job does |
|---|---|
| Nothing | Publishes |
| A package whose `gitHead` is this commit | Skips it: an earlier attempt of this release published it. Moves the dist-tag again, which changes nothing if it was already moved |
| A package from another commit, or one npm recorded no commit for | Stops before publishing anything more: the same version from other code. Bump to the next prerelease |

npm records the commit a package was published from as `gitHead` (every package of 0.1.0-beta.14
names the release commit). The tarball's integrity cannot stand in for it: a rebuild is not byte for
byte the same (the macOS bundle is signed again, the AppImage carries build times), so "the same
integrity as what was built" would never hold on a re-run. Before this, a job that published one
package and failed after it failed again on every re-run (`EPUBLISHCONFLICT`), and the shim could
not go out without a bump.

The shim job waits for the registry: it asks for every platform and host-only package at this
version immediately, then up to twenty more times, 30 s apart (ten minutes of waits). The
0.1.0-beta.18 shim exhausted the previous nine waits (4 min 30 s) before the packages appeared;
this matches the update installer's ten-minute retry window (#586). A rehearsal asks once and
warns, since it published nothing.

### Publishing by hand

Still supported, and still the fallback if Actions is down. On an Apple Silicon Mac:

```bash
pnpm release:npm                       # rehearsal: build, copy, verify, npm pack
pnpm release:npm --publish             # publishes @centralu/darwin-arm64, then centralu
```

By hand, the content manifest (below) is signed with a throwaway key and the script says so: the
signing key exists only as a GitHub secret. That is harmless only while the shell the release carries
is unpinned (the window never opens one); once `shell.lock` pins a shell, a publish with a throwaway key
stops before anything is published, so a darwin release has to come from `release.yml`.

Linux and Windows have to come from CI first (`release.yml` with `dry_run` off), because the second command refuses to
publish the shim while any pinned platform package is missing from the registry at this
version.

A release build produces only the `.app`, not the `.dmg` the plain `pnpm app` build also
makes. That is deliberate twice over: a release should build what it publishes, and the
DMG step is the one that can fail for reasons unrelated to the code — Tauri's
`bundle_dmg.sh` drives Finder through `osascript`, so a shell with no GUI session behind
it (an agent, an ssh session) is denied Automation access and exits 64. Losing a release
to that, with a correctly built and signed `.app` already sitting there, is not a trade
worth making. PR and main CI now also build only the `.app`; the default local Tauri
configuration still includes the `.dmg`, but neither CI nor the npm release ships one.

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

## Host-only packages

`@centralu/host-<platform>` is the bundled host and nothing else, for each platform a hub installs
Centralu on over ssh ([plans/remote-hub.md](plans/remote-hub.md) §10.2, owner decision 2 of §10.9):
the platforms `packaging/remote-runtime.json` pins a Node for, today `linux-x64`, `linux-arm64` and
`win32-x64`. macOS has none: a hub does not install on a Mac.

**Why.** The installer used to fetch the platform package and delete the window after unpacking. On
Linux that was an 88 MB download (the 81 MB AppImage) to keep 12 MB, which cost 9 of the 16 seconds
of an install in WSL (§10.7 of the plan). The host-only package is about 3.7 MB packed (measured
with `npm pack` on a bundled host; 11.6 MB unpacked), so a Linux install downloads about 84 MB less
and a Windows one about 2.5 MB less (`centralu.exe`).

| Who | What it does with them |
|---|---|
| `release-npm.mts`, in the platform job of that platform | Copies `src-tauri/resources/host` (what the build just bundled, the same folder the platform package's host comes from) into `packaging/npm/host-<platform>/host/`, checks it (`scripts/host-package.mts`: `main.mjs`, `bundle-info.json` for this platform, both native modules, `conpty.node` on Windows, `remote-runtime.json` equal to the pin, `files` exactly `["host"]`, nothing of the window), and publishes it **before** the platform package |
| The shim job | Will not publish the shim until every host-only package is on the registry too, though the shim does not pin them |
| The hub's installer (`links/install.ts`) | Reads `@centralu/host-<platform>@<v>` from the registry and checks its signature; installs it beside the `centralu` package. Only when the registry answers 404 (a version published before these packages existed) does it take the platform package instead, as before. A signature that does not check out refuses, as for any package |
| The shim, in a managed install (`findHostEntry`, `platform.mjs`) | `centralu serve` looks for the host in the platform package first (an npm install), then in `@centralu/host-<platform>/host/` |

**Not pinned by the shim.** An npm install already gets the host inside its platform package, so
pinning these too would download it twice. The exact pin the installer relies on is the version
itself: it asks for `@centralu/host-<platform>` at exactly its own version, and the release
publishes it from the same commit and build as the platform package. `tooling/host-package.test.ts`
holds the package folders, the Node pin's platforms, the shim's table and the installer's name to one
list; `tooling/release-workflow.test.ts` holds that every one of them has a platform job.

**Why first in the job.** A new package name is the publish most likely to be refused (a token that
may publish only the existing packages). Refused first, it leaves nothing of that platform published;
the re-run rule above then finishes the job once the token is fixed.

## The content manifest (#440)

The darwin job also stages the bundle's host and its `centralu-keeper` into
`apps/desktop/src-tauri/target/release/content/` and writes a signed `content-manifest.json` there
(`scripts/content-manifest.mts`, formats in [security-boundaries.md](security-boundaries.md) "Signed
content"). That folder is then copied into the bundle as `Contents/Resources/content/`, which the shell
verifies and starts the keeper from ([plans/thin-shell.md](plans/thin-shell.md) §10.2, next section).

- A rehearsal signs with a key generated in memory. A publish runs with `--require-content-key`, signs
  with `CONTENT_SIGNING_KEY` from the `npm-publish` environment, and checks the result against
  `packaging/shell/keys.json` **before** anything is published, so a secret that does not match the
  public key stops the release while it is still reversible.
- The manifest and its signature are kept as the run's `content-manifest-darwin-arm64` artifact. That
  upload cannot fail the job.
- To check one by hand: `pnpm exec tsx scripts/content-manifest.mts verify <folder>`.

## Local maintainer updates (#610)

`pnpm local-update` normally builds and installs macOS arm64 content on the maintainer's
selected machine. Only `content-manifest.json` (at most 60,000 UTF-8 bytes) is sent to
`.github/workflows/local-content-sign.yml`; the command uploads no executables. This is
an intended workflow, not a machine restriction: a signed manifest and its matching files
can be copied to any other `darwin-arm64` machine trusting the key with a lower highest-seen
version. The signature is not machine-bound. Full npm releases remain the public update path.

```bash
pnpm local-update --plan        # read the installed version and check the version bounds
pnpm local-update --dry-run     # local build + throwaway signing; no dispatch or install
pnpm local-update               # build, dispatch, wait for approval, verify, install
# For a copy running from a different location:
pnpm local-update --target /path/to/Centralu.app
```

The default target is `/Applications/Centralu.app`, exactly the copy `centralu install`
replaces. The command builds in a disposable checkout below the system temporary directory,
stamps the local version into the UI/host, Rust workspace and Tauri bundle, and runs the
release's `tauri build --bundles app` path (including host and frontend bundling). It reuses
a temporary Cargo cache for incremental updates. Dirty and unpushed source is allowed:
the signed manifest records the original commit and dirty flag, base version, reported
installed version, next release bound and a unique request id. Generated local version
changes do not change that original dirty flag. The tracked and nonignored untracked files
are copied; ignored build inputs are not. Keep the checkout still while the snapshot is taken.
No host is launched and any build subprocess receives a temporary `CC_DATA_DIR`.

**Version bounds are enforced twice**, before building and immediately before installing:
`<current>.local.N` must be strictly above the installed copy and below the next release.
For example, `0.1.0-beta.20 < 0.1.0-beta.20.local.1 < 0.1.0-beta.21` under the existing
SemVer rules. `N` is positive and increments from the installed local copy; `--version`
can request an explicit counter. Moving from `beta.19.local.128` to a `beta.20` checkout
starts at `beta.20.local.1`. The next release increments the final numeric release
identifier (`beta.20` → `beta.21`). Invalid versions, the old `-local.N` spelling,
equal/older candidates and candidates at or beyond the next release are refused. This
format needs a prerelease base: appending `.local.N` to a stable `1.2.3` is not SemVer
and is refused rather than changing the shell/keeper's version rules.

The command dispatches from `main`, so the workflow must first be merged there. A tiny job
validates the JSON and uploads only those exact bytes; its summary shows the manifest hash,
version and reported source provenance. It allows only format 1, shell 1, `darwin-arm64`,
a bounded sorted file list containing the keeper and required host entry points, safe paths,
file sizes, SHA-256 hashes and executable bits. Both validation passes read `APP_VERSION`
from `packages/protocol/src/brand.ts` in the checked-out main commit, require the reported
base to match it, and derive the next release and upper bound from it. Uploaded claims cannot
choose a future base such as `beta.999`. The signing job validates again after download,
then uses `signatureBytes` in `scripts/content-manifest.mts`, the same Ed25519 routine as
`release.yml`. It installs no dependencies and executes no uploaded code. The unmodified
workflow checks `GITHUB_REF == main` for real signing, uses the existing `CONTENT_SIGNING_KEY`,
and waits on `npm-publish` approval. That check in workflow code is advisory; the enforcement
is the environment's deployment policy, which since 2026-10-13 admits only the `main` branch
and `v*` tags (a repository setting, not in this repository's files). A branch carrying an
edited workflow cannot receive the key even after approval. Keep that policy if the
environment is ever recreated.
No npm token or private key reaches the local command; no shell identity, public keys or
keeper trust rules change.

**Local content signing (#610).** Whoever can dispatch on main and approve `npm-publish` can
get arbitrary unreviewed dirty-tree code signed with the release key. The manifest's commit,
dirty flag and installed version are self-reported; the signature proves the listed hashes,
not a reviewed source checkout. Approval is exercised with the owner's `gh` token. The
reviewed environment has one required reviewer, allows self-review, and lets administrators
bypass protection: dispatch and approval can use the same token. A local signature is not
machine-bound and verifies with the matching files on any `darwin-arm64` machine trusting
the same key whose highest-seen version is lower. See [Signed content](security-boundaries.md#local-content-signing-610)
for this trust boundary.

The command prints the run URL and waits; it never approves itself. The maintainer or their
agent reviews the validation job's summary and approves the pending deployment:

```bash
gh api repos/ijun17/centralu/actions/runs/RUN_ID/pending_deployments
# Use the npm-publish environment id from that response:
gh api --method POST repos/ijun17/centralu/actions/runs/RUN_ID/pending_deployments \
  -F 'environment_ids[]=ENVIRONMENT_ID' -f state=approved \
  -f comment='Approve the reviewed local content manifest'
```

Only `local-content-signature` is downloaded. The command verifies the exact manifest and
all local files against `packaging/shell/keys.json`, carries the existing pinned shell from
`shell.lock`, stages and checks the bundle, then copies it with `ditto` and the npm launcher's
atomic swap. Rejection, a failed run, a mismatched signature or a newly installed higher
version stops before replacement. The command keeps build artifacts in the temporary folder
it prints. An interruption may leave its `lock` directory: remove only that directory after
confirming the previous command has ended. The app and keeper are never stopped by the command.

A window running from the replaced target checks its bundle on focus and every five seconds
while visible and offers **Apply now**, even without an npm install event. Automatic apply
keeps the existing setting and idle/typing checks. Existing keeper verification and handoff
still decide what runs.

**Applying this change for the first time.** A window built before this PR only checks the
bundle after the host reports an npm install (`restart_required`). A local install emits
no such host event, and replacing files on disk cannot replace the UI code already loaded
in that window. If it already offers **Apply now**, use that button: no separate bootstrap
restart is needed. Otherwise load the newly installed window once by closing and reopening
it. With agents active, first enable Settings → Background → **Keep agents running after
Centralu quits**, and use **Quit**, not **Quit completely**; otherwise wait until they finish.
The reopened window attaches to the existing keeper; use its **Switch to this build** action
to apply the new keeper/host. This is the first application of the new window code, not an
additional **Restart completely**, a shell rebuild or a permission reset. Subsequent local
installs are detected by that window and offer **Apply now**. There is no existing CLI or
app-link endpoint for requesting the old window's relaunch; the command does not force it
to exit or forge an npm-install event.

To rehearse the workflow without the real key after it is available on the default branch:

```bash
# Use the manifest path printed by the local dry run; preserve its exact bytes.
node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.stringify({manifest:readFileSync(process.argv[1],"utf8"),dry_run:"true"}))' \
  /temporary/build/content/content-manifest.json | gh workflow run local-content-sign.yml --ref main --json
```

`dry_run` defaults to true, skips the environment and its secrets, signs with an in-memory
throwaway key, and verifies the signature inside that process. Its artifact is deliberately
untrusted and cannot be installed by `local-update`. CI steps can also be rehearsed locally:
`node --experimental-strip-types scripts/content-manifest.mts sign-local /temporary/content-manifest.json --dry-run`.

## The Node remotes run (#82)

A host the hub installs on another machine runs on a Node the hub downloads there, not on that
machine's own ([plans/remote-hub.md](plans/remote-hub.md) §10.2; Node 24 LTS, owner decision of
2026-10-08). `packaging/remote-runtime.json` is the one place it is named: the exact version, the
SHA-256 of the archive for each platform the installer serves (`linux-x64`, `linux-arm64`,
`win32-x64`), the releaser whose key signed that release's `SHASUMS256.txt`, and the
`nodejs/release-keys` commit that key is read from.

| Who | What it does with the pin |
|---|---|
| `release.yml`, `guard` job | `node scripts/node-pin.mjs`: fetches that version's `SHASUMS256.txt` and its `.sig` from nodejs.org, checks the signature with `gpgv` against the pinned releaser's key, and fails the release before anything is built if a pinned hash differs |
| `bundle:host` | Copies it beside `main.mjs` as `remote-runtime.json`, where the hub's installer reads it |
| `release-npm.mts` | Fails a package whose host carries no copy, or a copy that differs from the pin |
| `build.yml`, `host-tests-remote-node` | Runs the host, protocol and launcher tests on that version, on Linux and Windows, beside the jobs on Node 22 |

**Moving it** (a Node 24 security release, say): `node scripts/node-pin.mjs --set 24.x.y`. It reads
the current key list of `nodejs/release-keys`, checks the new `SHASUMS256.txt` against it, and writes
the pin with the signer and the commit it used. Review the diff (the signer should be a name in that
repository's README), and let CI run the host's tests on the new version in the same pull request.
Another major is a decision, not a bump: `NODE_MAJOR` in the script refuses it.

## The macOS shell (#440)

The shell (`apps/desktop/src-tauri/shell`, [plans/thin-shell.md](plans/thin-shell.md) §3) is not built
by `release.yml` and not built per release. macOS identifies it by its cdhash, so its bytes are built
**once per shell version** and pinned; every new shell version asks every person for their permissions
again.

**What a darwin release carries** (`scripts/bundle-stage.mts`, called by `release-npm.mts` after it
copied and checked the bundle, before anything is packed):

| In the bundle | What it is |
|---|---|
| `Contents/Resources/shell/Centralu.app` | the shell the window installs into `<data>/shell/` |
| `Contents/Resources/shell/shell.json` | `{ "format": 1, "version", "tree", "pinned" }`: the shell version, the hash of the shell's files the window checks its copy against, and whether these bytes are the ones `shell.lock` pins |
| `Contents/Resources/content/` | the signed content: `centralu-keeper`, `host/`, `content-manifest.json` and its `.sig` |

- **A publish** takes the asset `shell.lock` pins for the source's shell version: downloaded, its zip's
  sha256 and the bundle's cdhash checked against the entry, marked `pinned`. A pinned shell refuses
  content signed with a throwaway key, so such a publish stops.
- **Without a lock entry**, in a rehearsal, and in `pnpm app`, the shell is built on the spot
  (`cargo build -p centralu-shell --release`) and marked unpinned. The window neither installs nor opens
  an unpinned shell: it starts the keeper directly, as before, and writes why to `keeper.log`. A publish
  says so in a warning. Until shell v1 is in `shell.lock`, releases therefore behave as before the shell.
- After copying both in, the bundle is signed again ad hoc, keeping what the bundler set (identifier,
  entitlements, flags, hardened runtime), without `--deep`, so the shell and the keeper keep their bytes;
  then the content in the bundle is verified again and must still have the manifest that was signed, the
  shell's files must hash to `shell.json`, and `codesign --verify --deep --strict` must pass.
  `tooling/bundle-stage.test.ts` stages a made-up bundle the same way on every macOS test run.
- A `.dmg` made by the default local `tauri build` precedes this staging and carries neither.
  CI no longer creates it; nothing ships it.

Publishing a shell version (shell v1 is the first):

1. The source says the version: `SHELL_VERSION` in `shell/src/lib.rs` and `CentraluShellVersion` (and
   `CFBundleVersion`) in `shell/Info.plist`, merged on `main`. `tooling/shell-bundle.test.ts` keeps them
   equal.
2. Before building it for good, run the spike's probe against a local build of the shell
   ([spikes/2026-10-thin-shell-tcc.md](spikes/2026-10-thin-shell-tcc.md)): a keeper it starts is judged as
   the shell, grants hold after the shell exits, and the shell is not listed as "not responding"
   (`lsappinfo`, Activity Monitor) while it waits. This is the one check that goes through LaunchServices
   and real permission prompts, so it is done by hand.
3. Actions → **shell release** → Run workflow on `main` with that version. The `guard` job refuses a
   version that is already in `shell.lock` or already has a `shell-v<N>` release. The `build` job (macOS
   arm64, no cache) builds, ad-hoc signs, checks the signature, identity, architecture and linkage, zips
   reproducibly, and prints the zip's sha256, the cdhash and the `shell.lock` entry. `publish` creates the
   prerelease `shell-v<N>` (never marked latest) with the zip.
4. Add the printed entry to `shells` in `packaging/shell/shell.lock`, in a pull request. That entry is
   what every later release ships, and the first release with it is the one that switches people over:
   their windows install the shell and start the keeper through it, and macOS asks for the permissions
   once more, in the shell's name (plan §9 decision 5). Say so in that release's notes.
5. On the release that first carries it, check on a real Mac what the tests cannot (plan §10.2 "Checked
   by hand"): the shell is installed into `~/.centralu/shell/`, a fresh start goes through it
   (`[window] the shell started the keeper` in `keeper.log`), the window keeps focus, the Dock shows one
   icon, and Screen Recording granted once survives the next update.

Never rebuild a published version. If a run fails before `publish`, run it again. If the release exists
but its entry was never merged, nothing has shipped it: delete the `shell-v<N>` release and its tag, then
run again. Once an entry is merged, a fix is a new shell version.

`pnpm exec tsx scripts/shell-bundle.mts build --out <dir> --target-dir <dir>` makes the same bundle
locally (only for looking at it; a local build is a different identity to macOS). The CI checks of the
shell itself (unit tests and `scripts/shell-integration.mts`) run in the `keeper e2e` job.

## Adding a platform

1. Add an entry to `TARGETS` in `scripts/release-npm.mts` — bundle location, how to copy
   it, and the checks that prove the copy is intact, executable and the right machine.
   Do not skip a check because the platform has no equivalent; find what it was standing
   in for. (Linux has no code signature, so it checks the AppImage magic instead: the
   point of the signature check was "this file is what we think it is and is not
   truncated".)
2. Add `packaging/npm/<id>/package.json` with matching `os`/`cpu`/`files`. If a hub should install
   on it, also pin a Node for it in `packaging/remote-runtime.json` and add
   `packaging/npm/host-<id>/` (the host-only package, [above](#host-only-packages)), and teach the
   installer's preflight to name it.
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
| `centralu install` | Copies the folder to `%LOCALAPPDATA%\Programs\Centralu` and writes a Start-menu shortcut (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Centralu.lnk`). The new copy is assembled beside the old one and swapped in by two folder renames, so a failed copy leaves the working install untouched. The swap works while the app runs (the old copy, still in use, stays as `Centralu.old-<time>` until a later install sweeps it); it is refused only while a process's working directory is inside the folder |
| `centralu update` | `npm i -g centralu@<latest>` (through the shell, because `npm` is `npm.cmd`), then refreshes the installed copy if there is one |
| Update in the app | The same two steps run by the host without a shell ([agent-host.md](agent-host.md) §4.5), then "Restart Centralu to finish updating". Builds up to 0.1.0-beta.12 fail here with `spawn npm ENOENT`; on those, `centralu update` in a terminal once |
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

**What has been run, and what is still unproven.** On Windows 11 (2026-10-08, a temporary
npm prefix): `npm i -g centralu`, `centralu install` with its shortcut, `centralu update` from
0.1.0-beta.10 to beta.12, and the in-app update path from beta.10 to beta.12, each with a
stand-in holding the running app's handles in the installed folder. Not run: an update with
the real app open (the stand-in was an exe and the host's native modules, not the app with its
WebView2), and paths against a long profile name (about 180 characters deep under a default
npm prefix, inside `MAX_PATH` for ordinary names).

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
`release.yml` is different: publishing is already gated behind the `npm-publish`
environment, so a human already has to choose to run it.

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

1. `"centralu-linux-arm64": "<version>"` (now `@centralu/linux-arm64`) in `optionalDependencies` in
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
