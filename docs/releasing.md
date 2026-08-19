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
