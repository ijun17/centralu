# Code signing policy

Centralu has applied to [SignPath Foundation](https://signpath.org) for free code signing of its Windows binaries
(#2524). Until that is approved and wired into the release, **Windows binaries are not signed**, and Windows' Smart
App Control blocks them. Once it is, signed files carry: *Free code signing provided by
[SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).*

## What is signed

- **Only Windows binaries built from this repository's source by the `release` workflow**
  ([`.github/workflows/release.yml`](../.github/workflows/release.yml)), on GitHub-hosted runners (`windows-2022`, the
  `win32-x64` job). This covers every PE file of the Windows npm packages: the desktop executable, the host's files,
  and the native modules beside them.
- **Nothing built anywhere else**: not on a maintainer's computer, a fork or a self-hosted runner.
- **Not other projects' files without their consent.** Some files arrive prebuilt from the projects Centralu depends
  on (node-pty's ConPTY files, better-sqlite3's native module). Whether SignPath's terms let them be signed with
  Centralu's files is being settled with SignPath (#2524). A file its publisher already signed keeps that signature.
- A release is published the way [releasing.md](releasing.md#releasing-a-version) describes: a tag on a `main` commit
  whose own CI is green, a rehearsal, then approval.

## Roles

| Role | Who | What they do |
|---|---|---|
| Authors | Anyone, by pull request. Most changes are written by coding agents working for the maintainer, under the maintainer's account | Propose changes. A pull request runs CI, and `pnpm pre-pr` before it ([CONTRIBUTING.md](../CONTRIBUTING.md#before-opening-a-pull-request)) |
| Reviewers | The maintainer, and review sessions the maintainer runs | Review each change as its risk tier asks ([CONTRIBUTING.md](../CONTRIBUTING.md#review-before-you-say-done)). Changes to CI, releases, the store or security boundaries get the deep review |
| Approvers | The maintainer (the repository owner) | Approve each release's publication on the `npm-publish` environment, and each signing request on SignPath |

Today one person holds all three roles beside the agents. This page names the role, not the account; the
repository's owner is the maintainer.

## Multi-factor authentication

Everyone with write access to this repository must use multi-factor authentication on GitHub, and everyone with access
to the SignPath project must use it on SignPath.

## Approval per release

No release is signed automatically. Each release's signing request on SignPath is approved by hand by an approver,
after the release's CI evidence is checked ([releasing.md](releasing.md#release-ci-evidence)). The signing policy
accepts requests from `main` only.

## Privacy

Centralu has **no server of its own** and sends **no telemetry, analytics or crash reports**. No such library is in
its packages. What it sends over the network, and when:

| What | To | When | Can it be turned off? |
|---|---|---|---|
| An update check: a plain request for the newest version's record, with no identifier added | `registry.npmjs.org` | When the host starts, every 6 hours, and when you click "Check now". The `centralu` command checks once each time it starts the app | The host's check: yes, "Automatic updates" in Settings (on by default). The command's check: no |
| Installing an update: npm downloads the packages, with npm's own request headers (npm, Node and OS versions) | `registry.npmjs.org` | When you install an update, or by itself when idle with "Automatic updates" on | Yes |
| Linked machines: everything goes through your own `ssh` to the computers you added | Those computers | While a machine is linked | Yes: unlink it |
| Installing Centralu on a linked machine: that machine downloads Node and Centralu's packages | `nodejs.org`, `registry.npmjs.org` | When you install or update it, or by itself with "Automatic updates" on | Yes |
| Checking that the network is back: a request with no credentials, only to see that the address answers | The coding agent's API address (`api.anthropic.com`, `chatgpt.com`, or the address in your agent's settings) | Only while a turn waits after the network dropped, at most 80 times | Yes: "Continue when the network is back" in Settings |
| Installing the Antigravity agent: a fixed, checksum-checked archive | `dl.google.com` | When you ask Centralu to install it | Not applicable |
| GitHub through your own `gh` and `git`, with your own credentials: a pull request's state, `git fetch` when a worktree starts, a push or clone you ask for | GitHub, or the remote your repository names | A pull request's state after turns end in a worktree session, and for pull requests you or an agent watch; the rest when it happens | Yes: without `gh` nothing is asked; push and clone happen only when asked |
| Importing an app: its archive | The address you give | When you import it | Not applicable |

**The coding agents.** Centralu starts the coding agents you choose (Claude Code, Codex and others) as separate
programs. Each sends your prompts, the files it reads and its tool results to its vendor, under that vendor's terms
and your account with it. Centralu does not add anything to that traffic or read it on the way.

**Apps.** An app's server runs with your rights and may use the network as any program you run can. Its window gets
no network access unless its manifest declares the addresses
([security-boundaries/](security-boundaries/README.md)).

**The window** loads nothing from the internet: fonts and images are bundled, and its content policy lets it reach
only the local host. A link opens in your browser only when you click it.
