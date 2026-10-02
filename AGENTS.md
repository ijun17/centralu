# Working in this repository

Rules for coding agents (Claude Code, Codex and others) working here. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first; this file only points at the parts an agent most
often gets wrong. `CLAUDE.md` imports this file, so there is one copy of these rules.

## Language

Everything written down is in **English**: code comments, test titles, documents, commit
messages, issues, issue comments, pull requests and review comments (see "Language" in
CONTRIBUTING.md). Existing Korean comments stay until someone translates them with the
reasoning intact (#27); do not add new ones. You may talk to the person in whatever language
they use — this rule is about what lands in the repository and on GitHub.

## Commits

Commit messages follow [docs/commit-conventions.md](docs/commit-conventions.md):
Conventional Commits, `<type>(<scope>): <description>`, with a body when the reason does not
fit the subject. Read it before the first commit; do not copy the style of recent history.
From mid-September to early October 2026, agents wrote plain sentences instead, against the
document (the owner confirmed the document on 2026-10-03).

## Pull requests

Use the template in `.github/pull_request_template.md` (Why / What changed / Verified /
Not exercised / Closes). **Not exercised** is the field reviewers read first: name the
surfaces you did not actually run — the packaged app, another platform, a live model
session, a logged-out tool.

## Tests

- A new test must fail when the fix it guards is disabled. Disable it, watch the test fail,
  quote the failure in the commit or PR, then restore. A test that still passes with the
  fix removed is not testing the fix.
- `pnpm verify` must pass. Run `pnpm e2e` for anything the UI shows.
- Some defects only show in the packaged app or in WebKit (the desktop app is WKWebView).
  If a UI bug does not reproduce in Chromium, try `test.use({ browserName: 'webkit' })`.

## Data

Tests and scripts never write to the person's real data folder (`~/.centralu`). Point
`CC_DATA_DIR` at a temporary folder; when a host is started with `--db`, set `CC_DATA_DIR`
too, or user-folder apps, attachments and worktrees still land in the real folder.

## Documents

When a change moves the design, fix the document in the same pull request as the code
(`docs/README.md` is the map). If the document and the code disagree, the document is wrong.
