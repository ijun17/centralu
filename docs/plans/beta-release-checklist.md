# Beta release checklist

> Written 2026-08-18. Before deciding **to** release, write down first what is blocking it.
> The 'Current state' below is not a guess — it is a value confirmed directly from the
> repository and the build artifacts.

## Current state (confirmed)

| Item | Value | How confirmed |
|---|---|---|
| Signing | Ad hoc (valid) + hardened runtime, not notarized | `codesign -dvv <app>` |
| Architecture | arm64 only (Mach-O arm64) | `file <app>/Contents/MacOS/centralu` |
| Native add-ons | `better_sqlite3.node` and `pty.node`, both arm64 | `file …/node_modules/**/*.node` |
| Runtime | `system-node` — **the user's Mac needs Node already present** | `resources/host/bundle-info.json` |
| Node floor | esbuild target `node22` | `scripts/bundle.mjs` |
| Remote repository | None | `git remote -v` (empty output) |
| LICENSE | None | `ls LICENSE*` |
| Auto-update | Not configured | No `plugins.updater` in `tauri.conf.json` |
| Version | `0.1.0` / `0.1.0` / `0.0.0` (three places disagree) | tauri.conf.json, Cargo.toml, apps/desktop/package.json |
| Distribution channel | **npm** (decided by measurement in §2) — no quarantine flag attached, so no warning | An `npm pack` round trip + confirming launch with `open` |

## 1. What blocks release (if this does not work, nothing else matters)

### 1-1. Signing and notarization

**Notarization requires a paid certificate.** There is no free workaround:

| Method | Cost | Distribution |
|---|---|---|
| Free Apple ID → Apple Development certificate | Free | ❌ Development / my-own-device only, cannot notarize |
| Self-signed | Free | ❌ Gatekeeper trusts only an Apple-issued Developer ID |
| Apple Developer Program → Developer ID Application | $99/year | ✅ Can notarize |

#### Already solved for free (`4f405fe`)

With no `signingIdentity`, Tauri **skips** codesign. So only the half-signature the linker
attaches was left, verification failed, and on another Mac this is what showed:

> "손상되었기 때문에 열 수 없습니다. 휴지통으로 이동해야 합니다." ("It cannot be opened because it
> is damaged. It should be moved to the trash.")

Changing one line to `signingIdentity: "-"` changes the message (measured):

> "Apple은 … 악성 코드가 없음을 확인할 수 없습니다." ("Apple cannot confirm that … is free of
> malicious software.")

The first is a **dead end** (verification failure), and the second is macOS's **standard
unnotarized path**. Hardened runtime turns on with it too, so the precondition for notarizing
later is already in place.

#### When to go paid

- A private beta (a few known people, all developers) → **ad hoc is enough.** Defer the $99.
  On top of that, handing it out through the npm path decided in §2 means **no warning appears
  at all** (measured) — ad hoc's limit never reaches the user's eyes
- Public release / a brew tap / a browser download / the moment a stranger receives it →
  notarize. From that point on, the cost of looking like a "suspicious app" is greater than
  $99. What notarization buys is exactly **"no warning, however it is received."**

- [ ] (for a public release) Join the Apple Developer Program ($99/year)
- [ ] Issue a Developer ID Application certificate
- [ ] Wire the signing environment variables into the Tauri build
      (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
- [ ] Notarize with `notarytool` + staple the ticket with `stapler`
- [ ] Download and verify on **a different Mac** — on the Mac that built it, quarantine never attaches, so it passes trivially

### 1-2. Repository and license

- [ ] Create the remote repository (`git remote` is empty right now, so there is no release
      URL at all). It goes under the personal account — GitHub's terms allow only one free
      account per person, and if a brand is needed later, **transferring** it to an Organization
      then carries the stars, issues and URL along with it
- [x] Add LICENSE — MIT. The contributor CLA is in `CONTRIBUTING.md` (now, before
      contributions pile up, is the only time to leave a path open toward a paid company
      license later)
- [x] State plainly that conversation history is stored **only locally** (`~/.centralu/store.db`) — in the README's opening

## 2. Channel — ship through npm (a decision reversed by measurement)

> The first note here said "npm does not fit a GUI app." That judgment was made **before
> accounting for the quarantine flag**, and measuring again showed it was wrong. Everything
> below was measured directly on this Mac on 2026-08-19.

### 2-1. What triggers the warning is the flag, not the app

macOS does not open an app and decide it is "dangerous." It checks the developer's identity
**only when `com.apple.quarantine` is attached** to the file. And that flag is attached **by
the program that brought the file in.**

| Path it arrives by | Quarantine flag | What shows on first run |
|---|---|---|
| `npm i -g` · `curl` · `git clone` | **None** | **Nothing shows** |
| Browser download (.dmg/.zip) | Attached | "Cannot confirm it is free of malicious software" |
| AirDrop · messaging apps · email attachments | Attached | Same as above |
| `brew install --cask` | Attached (**by default**) | Same as above. The user has to type `--no-quarantine` themselves |

Measured:

```
curl -fsSL -o probe.txt …             → 0 quarantine attributes
~/Downloads/<file downloaded via browser> → 0281;6a847c46;Aside;DBB9C93A-…
```

### 2-2. Can a `.app` be shipped through npm — yes

The whole path was run end to end: put the `.app` in a package, `npm pack` → unpack → run:

| What was checked | Result |
|---|---|
| Size | 11MB → **4.2MB tarball** |
| Symlinks inside the bundle | **0** (nothing for the tar round trip to break) |
| `codesign --verify --deep --strict` after unpacking | `valid on disk` · `satisfies its Designated Requirement` |
| Execute bit | `-rwxr-xr-x` preserved |
| Quarantine flag | None |
| **Launched via LaunchServices** (`open` = the same path as double-clicking) | Starts with no warning (`[agent-host] started`) |

The last row is the key. **Calling the executable directly from a terminal never involves
Gatekeeper in the first place, so it proves nothing.** It only measures the double-click path
when launched with `open`.

`spctl -a -t exec` still judges this app `rejected`. And yet it launches — **because that
judgment is only consulted when the quarantine flag is present.** The rest of this document
turns on exactly this point.

### 2-3. Why this fits this project specifically

This is not a claim that npm fits GUI apps in general. The conditions line up for this app specifically:

- **Node 22 is already a precondition** (the `system-node` runtime). Every target user already has npm — zero additional prerequisite
- The target audience are people who installed `claude` and `codex` through npm. It is the most familiar path
- It creates an update path: `npm i -g …@latest`. Right now reinstalling is the only path
- Better than `curl … | sh` — it does not demand "trust this script," and pinning a version or uninstalling is done with standard tooling

### 2-4. The cost, and the conditions that must hold

- **It does not show up in Launchpad or Spotlight** (because it lives inside `node_modules`).
  It has to be launched by command every time
  → the `centralu install` subcommand copies it into `/Applications`. **This is never done
  quietly through postinstall** (pnpm blocks that by default, and silently writing into
  someone else's `/Applications` erodes trust)
- An arm64-only binary must not install on an Intel Mac → the `os`/`cpu` fields plus a
  per-architecture optional dependency (the same structure esbuild and swc use)
- **The distribution path has to stay singular.** The moment a user zips up the `.app` and
  hands it over by messaging app or AirDrop, the flag attaches there, and whoever receives it
  sees the warning. The instructions are kept to one line: `npm i -g …`
- **npm avoids the warning; it does not earn trust.** Once it starts spreading to strangers,
  §1-1's $99 remains exactly as much of a problem as before

### 2-5. To do

- [x] Package name — **`centralu`** (measured 2026-08-19: an npm 404, so it is free).
      The old name already had an owner on npm (an HTTP 200), and also collided with a macOS
      system feature name. The GitHub account name `centralu` already has an owner, but that
      does not matter since the repository goes under the personal account
- [x] The per-architecture optional dependency structure — `centralu` (the shell) +
      `@centralu/darwin-arm64` (the payload). The `os`/`cpu` fields mean the payload does not
      install on a mismatched Mac, and the CLI states the reason when that happens
- [x] The `bin` launch script — launches with `open -a` (it has to go through LaunchServices
      for the Dock and single-instance behavior to work). If it is installed in `/Applications`,
      that copy is used first
- [x] `install` / `uninstall` subcommands — copies with `ditto` to preserve the signature.
      Uninstall **tells the person that conversation history is left behind**
- [x] The release script `pnpm release:npm` — defaults to a rehearsal (`npm pack --dry-run`)
      and requires `--publish` separately. Before publishing it checks a clean working tree,
      verify, signing, the execute bit and arm64, and takes the version from `brand.ts` to write
      into both `package.json` files. The architecture package is published **first** (doing it
      the other way round creates a moment where a dependency points at nothing)
- [x] **Actually published** (2026-08-19) — `centralu@0.1.0-beta.1`,
      `centralu-darwin-arm64@0.1.0-beta.1`. Confirmed all the way from a registry download to
      running it: no quarantine flag, valid signature, execute bit intact, and the startup
      banner stamped `build d791d04` (**no `-dirty`**) — meaning the binary is built exactly
      from the published commit. What blocked it twice, and why, is recorded below.
      **A prerelease requires a tag** — npm refuses a publish with no `--tag`
      ("You must specify a tag using --tag when publishing a prerelease version"). Blocking it
      is correct: otherwise the beta would become `latest`, and someone who installs without a
      second thought would get the beta. So it is pushed under the `beta` tag, but **while there
      is no stable release yet**, `--also-latest` makes `latest` point at the same place too
      (skip this and `npm i -g centralu` dies with "No matching version found"). This option
      must not be used once a stable release exists. The payload package goes out
      **unscoped**, as `centralu-darwin-arm64`. Scoping it `@centralu/…` would require creating
      an npm organization first, and since that name is never shown to the user, there is no
      reason to let it hold up publishing (changing it later is one line in the shell's
      optionalDependencies)
- [ ] Keep GitHub Releases' `.dmg` as **a secondary path only**. State alongside it that receiving it that way shows the warning
- [ ] Defer a brew tap until after signing — a cask attaches quarantine by default, so adding one now only widens the failure experience

### 2-6. Blocked twice while publishing (npm was right both times)

| What blocked it | What npm required | Why it is right |
|---|---|---|
| A prerelease with no `--tag` | `--tag beta` | Otherwise `0.1.0-beta.1` becomes `latest`, and someone who installs without a second thought gets the beta |
| Publishing with no 2FA | Account 2FA or a bypass token | If the account is compromised, a malicious package goes straight out |

Both stopped **with nothing published at all** — there was no half-published, ambiguous state.

And even after turning on 2FA, it caught once more: this account is registered with a
**passkey (Touch ID)**, so it uses **browser approval** rather than a 6-digit code. That wait
is interactive, so it cannot be satisfied from a non-TTY context (npm just prints the URL and
exits with EOTP). Publishing from an automated environment needs either registering an
authenticator app (TOTP) as well, to use `--otp=`, or a person running it directly from a
terminal.

- [ ] Do not forget to **remove** `--also-latest` at the first stable release (the beta would overwrite the stable one)

## 3. User prerequisites (must go in the install docs)

This app cannot run on its own. These are things that, missing, mean it **just does not work, with no explanation**:

- [ ] Node 22 or newer (the `system-node` runtime — without it the host cannot start at all)
- [ ] The `claude` CLI installed and logged in
- [ ] The `codex` CLI installed and logged in (if codex sessions are used)
- [x] **What the app says** when Node is missing — the startup screen states what is
      missing, where it looked, and what to do about it. An old version is distinguished as
      "needs upgrading," not "missing"
- [x] The wording when claude or codex is missing — the first-run screen shows what is
      missing together with the install command (`npm i -g @anthropic-ai/claude-code` /
      `@openai/codex`), and checks again with "Check again". **Project registration stays
      open** even with no tool installed at all (the first screen is never blocked just because
      a CLI is missing)

> The Node dependency is the biggest friction in distribution. In the long run, bundling
> Node is the better move (SEA and the like). Finding it, at least, is fixed already — it used
> to check only the two homebrew locations and `/usr/bin`, so **a Node installed through nvm,
> mise or volta went unfound even though it was present.** Now it asks the login shell directly
> (the same approach as claude/codex discovery).

## 4. Architecture decision

It is arm64 only. And **this is not just a matter of the Rust target** — the bundled
`better_sqlite3.node` and `pty.node` are arm64 prebuilds. Going universal would mean bundling
the x64 prebuilds of both add-ons as well and merging them with `lipo`.

- [ ] Decide whether to go arm64-only, and if so **state it in the release notes** ("Apple Silicon only")
- [ ] If universal is needed, schedule it as a separate piece of work that includes the native add-ons

## 5. Cleanup before release

- [x] The version matches in all three places (`tauri.conf.json`, `Cargo.toml`,
      `apps/desktop/package.json`) — 0.1.0. `tooling/brand.test.ts` catches a mismatch
- [x] For a beta, `0.1.0-beta.1` — let the version state the expectation up front. Confirmed
      that Tauri takes the prerelease string to produce `Centralu_0.1.0-beta.1_aarch64.dmg`,
      that it carries straight into Info.plist's `CFBundleShortVersionString`, and that the app
      starts normally. Apple's own convention does expect 1–3 numeric segments in that field —
      harmless for direct distribution, but if the App Store is ever on the table, only the
      numbers can remain there (the current path is not the App Store)
- [x] Prerequisites, install steps and known limits in the README / [ ] screenshots still pending
- [x] Auto-update — **the Tauri updater is not used.** It would fight npm (if the app
      replaces itself inside node_modules, that disagrees with the version npm knows about).
      Instead **the registry is the update channel**: one GET to
      `registry.npmjs.org/centralu/latest`. No signing key and no update server needed.
      `centralu update` does the upgrade, and if an `/Applications` copy exists, that is
      updated too. On launch, it notifies **after** the app is already up (launch must never be
      delayed for the check)
- [ ] An in-app banner — right now it only notifies through the terminal. Someone who opens it from Launchpad never sees that line
- [ ] A bug-report channel + **ask the person to attach `~/.centralu/host.log`**
      (the startup banner has the build commit baked in, so which build it was is immediately clear)

## 6. Dogfooding exit criteria

On 2026-08-18, the app was in a state where **no session would run at all**, and three
causes were fixed that same day (`e7ac9d2` stuck in "working" after a restart, `f924257` a
conversation opened somewhere else, `15bff4f` disappearing logs). All three surfaced not from
automated tests but from **actually using it.** So this is cut off by events, not by a clock:

- [ ] Several days of continuous use with no session getting stuck or dropping into error
- [ ] A session comes back normally across multiple app restarts
- [ ] The fork prompt still shows correctly when a codex session is open in VS Code at the same time
- [ ] Nothing unexpected accumulates in `host.log`
- [ ] If a new defect appears during that period, **fix it and restart the counter**

## 7. Release day

- [ ] `pnpm verify` + `pnpm e2e` pass
- [ ] Build from a clean clone (checking it does not lean on the state of my own machine)
- [ ] Confirm the build is stamped with a commit hash and no `-dirty` (the `host.log` startup banner)
- [ ] Download the signed, notarized `.dmg` on **a different Mac** and install and run it
- [ ] Install into `/Applications` and run it — keeping it under `~/Desktop` means macOS
      asks again for protected-folder access on every rebuild, and the host stalls at `open()`
      until that is answered (measured)
