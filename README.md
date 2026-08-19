# Centralu

Run, watch and steer several agent coding tools — Claude Code, Codex CLI — from one
window.

<!--
  SCREENSHOT NEEDED HERE.

  It has to show the thing the app is for, which is triage, not chat. That means the
  sidebar with several sessions in different states at once — one waiting for approval,
  one waiting for input, one still working — the inbox count, and one session open in
  the focus view with an approval card on screen.

  A single idle session proves nothing; that shot would look like every other chat UI.
-->

Beta. See [where it runs](#where-it-runs).

Your conversations stay on your machine. They are written to `~/.centralu/store.db` and
sent nowhere. There is no account and no server to sign into.

[한국어 README](README.ko.md)

## What it is

Using agent coding tools in earnest means running several of them at once, across
several projects. The problem that creates is not that you cannot watch them all —
it is that the terminal tabs scatter, and you lose track of which one is blocked on
you. Opening an IDE per project to see what changed costs more RAM and battery than
the work is worth.

Centralu is a control tower for that. It does not write code. It shows you what the
agents are doing, and picks out the one that needs you now.

It keeps two kinds of waiting apart, because they cost you different amounts:
**waiting for approval** means an agent is stuck and burning nothing until you answer;
**waiting for input** means a turn finished and can sit there all afternoon. Collapsing
those into one badge is how you end up checking everything and trusting nothing.

The rule it is built on is **do not block, make visible**. Centralu does not take
options away from you or from the agent, and does not impose a workflow — it tells you
what is happening and what is waiting on your judgement. The scarce resource here is
your attention, not tokens.

## What you need

Centralu does not run agents itself; it drives the CLIs you already have. Without these
it will open, and then be unable to start a session.

| | |
|---|---|
| **Node 22 or newer** | the host sidecar runs on it. If it is missing or too old, the app says so at startup and names the version it needs |
| **`claude` CLI**, logged in | for Claude Code sessions — `npm i -g @anthropic-ai/claude-code` |
| **`codex` CLI**, logged in | for Codex sessions — `npm i -g @openai/codex`. Skip it if you do not use Codex |

Either CLI on its own is enough to start. The first-run screen checks for both, says
which one it found, and prints the command to install or log into whatever is missing.

## Install

```bash
npm i -g centralu   # beta — centralu@beta pins you to the beta line
centralu            # run it
centralu install    # add it to /Applications, so Spotlight and Launchpad find it
centralu update     # when a newer version exists
```

`centralu install` is a separate command on purpose: writing to someone's
`/Applications` from a postinstall hook without being asked is not a thing this project
does. `centralu uninstall` reverses it and leaves your conversations alone.

> **Why npm, and not a download.** macOS does not inspect an app and decide it looks
> dangerous. It looks for a `com.apple.quarantine` tag, and that tag is attached by
> whatever fetched the file — browsers attach it, npm does not. The same build of
> Centralu, downloaded, opens with "Apple could not verify it is free of malware"; installed
> through npm it just opens. That is measured, not assumed: the numbers and the method
> are in [the beta release checklist §2](docs/plans/beta-release-checklist.md).

## Where it runs

| | |
|---|---|
| **macOS, Apple Silicon** | published to npm, and what the project is developed on daily |
| **Linux, x86-64** | builds in CI. Not published, and never yet launched by anybody |
| **Windows · Linux on arm64 · Intel Macs** | do not build at all ([#14](https://github.com/ijun17/centralu/issues/14), [#29](https://github.com/ijun17/centralu/issues/29)) |

Linux is the row that needs the longer answer. Nobody on this project owns a Linux
machine, so CI is not a convenience there — it is the only place a Linux bundle has ever
existed. It does get built on every push:
[run 32289487033](https://github.com/ijun17/centralu/actions/runs/32289487033) produced a
78 MB AppImage and a 5.1 MB `.deb`, and both are downloadable as run artifacts.

What has never happened is anyone starting one. Compiling and running are different
claims, and only the first has been demonstrated. So `centralu-linux-x64` is not on the
npm registry — an unlisted platform makes npm answer "not supported yet", which beats
installing something that may not open. The CI artifact is the only way to get it today,
and because GitHub artifacts are zips, you will need to `chmod +x` the AppImage after
unzipping.

If you run Linux and are willing to be the first,
[#14](https://github.com/ijun17/centralu/issues/14) is where to report what happened —
including if it did nothing at all.

## Licence

[MIT](LICENSE). Issues and pull requests are welcome; please read
[CONTRIBUTING.md](CONTRIBUTING.md) first, as there is a CLA.

## Documentation

[docs/product-spec.md](docs/product-spec.md) is the spec that everything else answers to.
[docs/README.md](docs/README.md) maps the rest. Most of `docs/` is still in Korean; the
translation is tracked in
[#27](https://github.com/ijun17/centralu/issues/27).
