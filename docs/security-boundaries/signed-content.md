# Signed content (#440)

With the thin shell ([plans/thin-shell.md](../plans/thin-shell.md)), the keeper and the host run from a
folder outside any signed app bundle, with the permissions the person granted to the shell. The boundary
is **what may be started from that folder**: only files signed by a key compiled into the verifier,
including release content and owner-approved local content (#610). The verifier is
`apps/desktop/content-verify` (shared by the shell and the window's diagnosis of a refusal); the writer is
`scripts/content-manifest.mts`. Its first user is the shell (`apps/desktop/src-tauri/shell`, step 3 of
the plan), which a macOS release window opens since step 4 (§10.2) when the shell it carries is the one
`shell.lock` pins.

- **Signature first.** `content-manifest.json` lists every file (path, size, sha256, executable bit) with
  the app version, platform and minimum shell version. `content-manifest.json.sig` is an ed25519 signature
  over the manifest's exact bytes, checked with `verify_strict` before anything in the manifest is parsed.
  The key is chosen by id (the first 8 bytes of SHA-256 over the public key) among the keys compiled in
  from `packaging/shell/keys.json` (`current` and `next`); an id that is not among them is refused.
- **The private keys** exist only as the `npm-publish` environment secrets, behind the same approval as
  the npm token. Within `release.yml`, `CONTENT_SIGNING_KEY` goes only to the darwin platform job;
  `local-content-sign.yml` also receives it in its approved signing job (#610).
  `release-npm.mts` takes it out of its environment before starting anything. A rehearsal has no
  environment and signs with a key generated in memory, which no keys.json holds; a publish refuses to
  sign with one (`--require-content-key`) and checks its signature against keys.json before publishing.
- **Only listed files are copied, and what is hashed is what is copied.** Each path is walked one
  component at a time with `openat` and `O_NOFOLLOW` from the content folder, and must end at a regular
  file (`fstat`); a FIFO is opened non-blocking so it cannot stall the start. The file is read once:
  every chunk is hashed and written to the copy in the same step, reading stops one chunk past the listed
  size, and the size and hash must match. Unlisted files in the source are not copied.
- **Paths** are relative and `/`-separated, with no empty, `.` or `..` component, no `\` and no control
  character, and not the manifest's own names. Paths that differ only in ASCII case, and a path that is
  also the folder of another, are refused. The writer refuses the same names (one table,
  `tests/fixtures/paths.json`, tests both).
- **Into place atomically.** The copy goes into a new `0700` folder beside the destination, is read back
  and hashed again, and everything below its top is made read-only (`0444`, `0555` for executables and
  folders). The top folder is renamed onto the destination with a rename that refuses an existing one
  (`renamex_np(RENAME_EXCL)` on macOS, `renameat2(RENAME_NOREPLACE)` on Linux) and only then made `0555`,
  through a descriptor opened before the rename: macOS refuses to rename a folder its owner cannot write
  (always on macOS 14, across parents on macOS 27). In that moment only the owner can write to it, and
  only at the top; a listing after the `fchmod` refuses any name the manifest does not account for. Any
  refusal removes the copy.
- **Other refusals:** a manifest for another platform, one that needs a newer shell, an unknown `format`,
  a manifest over 16 MiB or a signature file over 64 KiB, and a version lower than the highest this data
  folder has started unless the window asks for a rollback (`version::check_not_downgrade`).

The shell adds:

- **The keys it trusts are keys.json, compiled in.** A test build can trust one more key (the integration
  test's throwaway key, given at compile time) only behind the `test-key` feature, and a build without
  `debug_assertions` refuses to compile with it (`compile_error!` in `shell/src/keys.rs`). Nothing on the
  way to a release turns the feature on: `tooling/shell-bundle.test.ts` and
  `tooling/shell-release-workflow.test.ts` check the source, the shell's manifest and the shell release
  workflow, and `scripts/shell-integration.mts` checks that a build without the feature refuses content
  the throwaway key signed. The status file says `testBuild`, so a test build
  cannot pass for a real one.
- **It starts only from the copy.** The keeper is `<data>/content/<version>/centralu-keeper` and its host
  folder `<data>/content/<version>/host`; nothing is started from the folder the window passed. A copy
  already there for that version is used only if it verifies again where it is (`verify_in_place`: the
  signature, the same manifest bytes as the source, every listed file's size, hash, read-only mode and
  executable bit, no symlink and nothing unlisted at any depth); otherwise it is removed and copied again.
  A `--content` inside `<data>/content/` is refused (as given and resolved, and arguments may not contain
  `..`), so that removal can never reach the source.
- **The data folder is the window's.** The shell does not create or migrate it; a missing one is refused.
  `shell-status.json` is written `0600` with `O_NOFOLLOW` to a temporary name and renamed.
- **Its own bytes are pinned.** The shell is built once per shell version by
  `.github/workflows/shell-release.yml` (no cache, no feature, no secret) and recorded in
  `packaging/shell/shell.lock` (zip sha256 and cdhash); `fetchPinned` (`scripts/shell-bundle.mts`)
  refuses a download whose sha256 differs, and the release refuses a downloaded bundle whose cdhash
  differs, before it puts the shell into the window (`scripts/bundle-stage.mts`). The window installs a copy
  only if its files hash to what the release recorded beside it (`shell.json`), never replaces a higher
  installed version with a lower one, never installs or opens an unpinned shell (a local build's), and opens
  the shell through LaunchServices with absolute paths only; an old `shell-status.json` cannot answer for a
  start, because the window matches it by a fresh nonce.

**The keeper verifies nothing to run it** since #1895 step 4 PR 4: a keeper runs one build, and the next build's
content is verified and copied by the shell when the window starts it. Until then a keeper the shell started verified
and copied the next build's content itself before handing over (step 5, [plans/thin-shell.md](../plans/thin-shell.md)
§10.3), by the shell's rules: a refusal moved nothing, a version below the floor was refused on a handoff whatever the
window asked, and the window's `hostDir` was never read. What stays of the keeper's side:

- **What runs is never removed under it.** A version folder the keeper runs from, or a host runs from or will run
  from next, is never removed by the cleanup.
- **The keys are keys.json.** The keeper has no test key at all (`keeper/src/keeper/keys.rs`,
  `tooling/keeper-executable.test.ts`); its verifier only words the window's diagnosis.

The shell's refusal is **shown by the window itself, in a native dialog** (#634, `apps/desktop/src-tauri/src/refusal.rs`).

- **Why it is drawn there.** The build bar is drawn by the web UI, which the host feeds, and the host is the thing whose
  content failed to verify: it could hide the line or write another. The dialog is drawn by the window process, the signed
  app bundle, from what the window reads itself: the shell's `shell-status.json`. It does not pass through the host, and
  nothing of this is sent to or from it. It can be written by another process of the user (it is the user's file), so
  **the dialog repeats no free text from it**: it is built from the kind
  of check (a fixed list of ids, each with fixed words; an id it does not know is not repeated), the file's name (it comes from
  the signed manifest; cut to plain text of at most 200 characters), the two hashes (only if each is 64 hex characters) and the
  window's own version. The sentence the shell gave goes to `keeper.log` on one line, which "Show log" reveals.
- **One dialog at a time**: none is handed out while one is open (the dialog's own callback clears the flag), and two are
  at least 5 seconds apart.
- **What it says.** That Centralu started without the permission shell, and under Details the check that failed (an
  unknown signing key, a signature that does not match, a file whose hash differs, another platform, a version below the
  floor, a newer shell needed), the file and both hashes. The check ids are the keeper crate's (`check_id`, `file_of` in
  `keeper/content.rs`); the swap view that carried a switch's (`refusedCheck`, `refusedFile`) went with #1895 step 4 PR 4. The window reads its own content again (`keeper::content::diagnose`: the
  shell's checks, then every listed file's size and hash; it reads and hashes and starts, copies and changes nothing),
  because the shell's status carries one sentence and no hashes and its crate cannot change without a new shell version.
- **Show, do not run.** The dialog only tells. It starts, trusts and unlocks nothing; what keeps running is what already ran
  (what the window starts itself when the shell refused, §6 of the plan, unchanged), and the dialog says so: Centralu was
  started directly from the app and this start was not verified, not that nothing ran. Its two buttons are "Show log" (reveals `keeper.log`) and "Close"; it names the commands that
  fetch the build again (`npm i -g centralu@<version>`, then `centralu install --force`: `centralu update` does nothing when
  the registry's latest is the version already installed). A "run anyway" (the owner's decision of 2026-10-14 on #634) is not
  built: the shell and keeper still verify by default and there is no override.
- **Only verification failures** (`content`, `downgrade`, `shell-too-old`) are shown this way. A copy that failed, a folder in
  use, a shell that would not open and the like stay in the build bar, which is the host's to draw and can be hidden by it.
- **Once per refusal** in a window's life; a later start that is refused again is shown again.

Limits:

- Another process of the same user can change the copy after it is verified, or start whatever it likes
  with the same `node` and agent CLIs the keeper uses; the plan says so (§4). This protects against
  running content the project did not sign, a partial or corrupted update, and a file dropped into
  Centralu's folders inheriting the grants, not against the user's own processes.
- Whoever holds a signing key can sign anything; rotating means moving `next` to `current` in a new shell
  version, which is why the shell carries both.
- Windows has no verifier copy yet (`verify_and_copy` is Unix only); it has no shell either (§8), so no refusal arises there
  and the dialog is never shown.
- The dialog is drawn by the window process, which runs as the same user as everything else here: another process of the
  user could draw over it or close it, or write `shell-status.json`; it cannot make the dialog say more than the check, the
  file, the hashes and the version, and it cannot suppress a refusal the shell made. One that reaches the keeper's socket
  cannot ask it for other content at all: `switch` and `upgrade` answer `gone` since #1895 step 4 PR 4. What it protects against is the host hiding or rewriting a refusal, not the user's
  own processes.
- The text of the shell's refusal is the shell's (pinned) and the window's diagnosis reads the content again: a content changed
  between the shell's refusal and the diagnosis is described as it is then, or, when it verifies then, by the shell's sentence.

## Local content signing (#610)

Whoever can dispatch `local-content-sign.yml` on `main` and approve `npm-publish` can have
**arbitrary unreviewed dirty-tree code signed with the release key**. The manifest supplies file
hashes, not source code for CI to rebuild or review. Its `commit`, `dirty` and installed version
are self-reported; signing does not attest that the code came from that commit or was reviewed.
CI treats the manifest as data and never executes the uploaded code, but the resulting signature
grants that code the same content trust as a release.

Both validation passes read the base version as data from the checked-out workflow commit (the
dispatched `main` commit for this workflow): the newest release tag reachable from it
(`readReleaseBase`; since #1501 no file holds the version, and both jobs check out the whole history
for its tags). Tags are pushed only by maintainers, as main is. The uploaded `local.baseVersion`
must equal it, and the next release and upper bound are derived from it.
A manifest claiming `beta.999` cannot advance the shell's highest-seen floor when main is on
`beta.20`. The reported installed version is not an attestation of any machine's state.

Approval uses the owner's `gh`-authenticated token. At the #610 security review, `npm-publish`
has one required reviewer, self-review is allowed, and administrators can bypass protection;
the same owner token can dispatch and approve. This is not an independent two-person review.
The workflow's `GITHUB_REF == main` check is advisory. The enforcement is the environment's
deployment policy: since 2026-10-13 `npm-publish` admits only the `main` branch and `v*` tags, so
a branch with an edited workflow cannot receive the key even after approval. This is a GitHub
setting, not a file in the repository; anyone who can push to `main` or create a `v*` tag (today
only the owner, the sole collaborator) can still run an edited workflow with the key after
approval. The check in workflow code is not a substitute for that policy.

**The signature is not machine-bound.** A signed local manifest and its matching files verify
on any `darwin-arm64` machine trusting the same key whose highest-seen version is lower. No
machine identity, target path or owner account is part of the signature's authorization. The
local command's selected install target is a convenience, not a restriction on redistribution.
