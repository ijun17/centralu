# Feature maps

Where one feature lives, across the packages: the screen parts, the host's functions, the protocol's shapes, what it
stores, its documents and its tests. A session about to change a feature reads its map first, so the brief does not
have to name every file, and nothing that holds part of the feature is missed.

| Map | The feature |
|---|---|
| [turn-stop-note.md](turn-stop-note.md) | What a session and the person are told when a turn stopped without anyone asking |
| [store-update.md](store-update.md) | The store moved to a new build's step, the copy kept before a breaking step, and the work a step does at start |
| [worktrees.md](worktrees.md) | A session in a git worktree of its own: made, taken over, archived and restored, removed, swept |
| [mail-delivery.md](mail-delivery.md) | Mail between sessions: sent, delivered into a turn, answered by the report at a turn's end, shown on screen |

## The format

One page per feature, under about 60 lines: a sentence on what the feature is, the rule documents that govern it, and
one table with these rows, in this order:

| Part | Where |
|---|---|
| Screen | the UI's components, selectors and strings |
| Host | the agent host's modules and the functions or classes that own the feature |
| Protocol | the shapes, events and methods it crosses the wire in |
| Store | what it keeps: tables and columns, settings, files in the data folder |
| Documents | the documents and the headings that hold its rules |
| Tests | unit tests, then e2e specs |

A cell is a list of paths from the repository's root, each with the names that matter in it:
`packages/agent-host/src/mail/stop-notices.ts` (`StopNotices.sessionsStopped`). The owner of the feature comes first.
A row names where a thing is, never what the rule is: the rule stays in the code's comment and the rule document, so
the map cannot disagree with them. A data-folder file is written `<data>/name`.

## Keeping a map current

A pull request that adds, moves, renames or removes a file a map names updates that map in the same pull request.
`tooling/feature-maps.test.ts` fails when a map names a repository path that is not there; a file the map should name
and does not is for the author and the review to catch. A feature changed often enough that a brief had to list its
files is a feature that gets a map.
