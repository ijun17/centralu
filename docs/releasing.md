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
- `.github/workflows/release.yml` — **the release.** A `v*` tag push publishes every
  package, in order, from one run. `workflow_dispatch` rehearses the same thing without a
  tag (`dry_run`, default on). See below.

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
version up to ten times, 30 s apart, before it gives up. 0.1.0-beta.14's shim job failed once on
packages its platform jobs had published moments before and the registry did not show yet. A
rehearsal asks once and warns, since it published nothing.

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
- The `.dmg` that CI builds is made by `tauri build` before any of this and carries neither; nothing ships
  it.

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
