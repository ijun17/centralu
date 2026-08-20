# Centralu

Every Claude Code and Codex CLI session you have running, in one window.

<!--
  SCREENSHOT NEEDED HERE.

  It has to show the thing the app is for, which is triage, not chat. That means the
  sidebar with several sessions in different states at once — one waiting for approval,
  one waiting for input, one still working — the inbox count, and one session open in
  the focus view with an approval card on screen.

  A single idle session proves nothing; that shot would look like every other chat UI.
-->

Beta. See [where it runs](#where-it-runs).

Your conversations stay on your machine, in `~/.centralu/store.db`. Nothing is sent
anywhere. There's no account and nothing to sign into.

[한국어 README](README.ko.md)

## What you get

Three agents running. One's blocked on a command it wants approved, one finished a
while back and is sitting idle, one's still going. With terminal tabs, you find that
out by clicking through all three.

Centralu shows them together and points at the one that needs you.

- Approve a command or answer a question without leaving the window
- Get a sound and a dock badge when something starts waiting, even with the app buried behind your editor
- See "blocked on approval" apart from "finished, waiting on you" — the first is costing you time, the second can sit all afternoon
- Search anything anyone ever said, including from before the last restart
- Run an orchestrator session that reads your other sessions and hands them work

It doesn't write code. And it won't approve anything on your behalf — the moment
something needs approval is exactly the moment a person should be looking.

## What you need

Centralu drives the CLIs you already have rather than running agents itself. Without
them it starts up fine and then has nothing to open a session with.

| | |
|---|---|
| **Node 22 or newer** | the host sidecar runs on it. If it's missing or too old, the app says so on startup and names the version it wants |
| **`claude` CLI**, logged in | for Claude Code sessions — `npm i -g @anthropic-ai/claude-code` |
| **`codex` CLI**, logged in | for Codex sessions — `npm i -g @openai/codex`. Skip it if you don't use Codex |

Either one on its own is enough. The first-run screen tells you which it found and
prints the command for whatever's missing.

## Install

```bash
npm i -g centralu   # beta — centralu@beta pins you to the beta line
centralu            # run it
centralu install    # add it to /Applications, so Spotlight and Launchpad find it
centralu update     # when a newer version exists
```

`install` is its own command on purpose. Writing into someone's `/Applications` from a
postinstall hook, uninvited, isn't something this project does. `centralu uninstall`
puts it back and leaves your conversations alone.

> **Why npm instead of a download.** macOS never looks at an app and decides it seems
> dangerous. It checks for a `com.apple.quarantine` tag, and whatever fetched the file
> is what puts the tag there. Browsers do. npm doesn't. So the same build, downloaded,
> greets you with "Apple could not verify it is free of malware", and installed through
> npm it just opens. We measured that rather than assuming it —
> [beta release checklist §2](docs/plans/beta-release-checklist.md) has the numbers.

## Where it runs

| | |
|---|---|
| **macOS, Apple Silicon** | on npm, and what we use every day |
| **Linux, x86-64** | on npm since 0.1.0-beta.2. Nobody has reported running it yet — you may be first |
| **Windows · Linux arm64 · Intel Macs** | don't build at all ([#14](https://github.com/ijun17/centralu/issues/14), [#29](https://github.com/ijun17/centralu/issues/29)) |

That Linux row deserves a note. Nobody here has a Linux machine, so the package on npm
has been built and checked in CI, but never started by a person. Compiling and running
aren't the same claim, and only the first one has been shown.

If you're on Linux, `npm i -g centralu` gets you the AppImage — tell us how it went in
[#14](https://github.com/ijun17/centralu/issues/14). Including if it did nothing at all.

## Licence

[MIT](LICENSE). Issues and pull requests are welcome; please read
[CONTRIBUTING.md](CONTRIBUTING.md) first, as there is a CLA.

## Documentation

[docs/product-spec.md](docs/product-spec.md) is the spec everything else answers to, and
[docs/README.md](docs/README.md) maps the rest. Some of `docs/` is still in Korean —
[#27](https://github.com/ijun17/centralu/issues/27) tracks the translation.
