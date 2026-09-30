# M1 Result (2026-08-15)

> Phase 0–6 complete. Automated gates G0, G2 and G3 passed. **All that remains is G5 (human check).**

## Gates passed

| Gate | Method | Result |
|---|---|---|
| G0 scaffold | automated (lint, depcruise) | ✅ 0 boundary-rule violations, 9 tests verifying the rules themselves |
| G2 core | automated (FR-12 table → tests) | ✅ the 6 states, transitions and urgency match the spec 1:1 |
| G3 real session | run automatically by the agent | ✅ completed a full approval round trip with the real Claude SDK |
| **G5 feel of the control loop** | **human** | **⏳ pending — see how to run it below** |

## Test status

- Unit + integration, **180** (`pnpm verify`): protocol golden 22, core 69, agent-host 56, platform contract 24, boundary 9
- E2E, **14** (`pnpm e2e`): includes the control-loop scenario, 1.5 seconds
- Real-SDK smoke (`pnpm smoke`): approval request → allow → turn complete → persisted

## Performance (T6-2, 1st measurement)

| Metric | Target (§7.1) | Measured |
|---|---|---|
| Idle CPU (host) | < 1% | **0.02%** ✅ |
| host RSS | — | 273MB (dev run under tsx; expected to drop after bundling) |
| Web bundle | — | 295KB (gzip 89KB) |
| UI idle CPU / memory | target exists | to be measured on the real thing after the Tauri migration (M1.5) |

## What was implemented in M1 scope

FR-1 sidebar + focus view / FR-2 visibility of concurrent sessions / FR-3 conversation + approval (keyboard, banner) /
FR-12 splitting the 2 status types, counters, jump to the next pending item / FR-15 inbox / FR-16 read/unread /
FR-17 shortcuts (⌘I, ⌘⇧A, y/n/a, d) / FR-18 automatic naming / FR-20 archive /
Along the way: the context gauge (FR-14), the limit badge (part of FR-9)

## Decisions made during implementation (proceeded without a human check)

1. **User hooks and plugins are not loaded**: ClaudeAdapter does not specify `settingSources`, so Centralu sessions start without the user's hooks or plugins. Reasoning: a control tool becomes unpredictable if it runs the user's personal hooks (notifications, automations). To reverse this, add `settingSources: ['user']` in the adapter.
2. **The UI (core) is the authority on session status**: agent-host does not import core (boundary rule), so it only records a "hint" for storage. The live status is computed by the UI's reducer.
3. **Directory selection in web dev is a path input**: the browser has no directory picker, so it is a text field. This will be replaced with the dialog plugin under Tauri.
4. **`limited` is excluded from the inbox**: hitting a limit is not something requiring an action from the person, so it shows only in the sidebar and header, not in the inbox (the to-do list).
5. **zustand selectors go through a useMemo hook**: a selector that returns a new object causes an infinite re-render loop (hit this in practice). Derived computations are memoized inside `use*` hooks.

## How to run G5 (what the person does)

```bash
# Same shell — the agent host and the web UI share the same temporary token
CC_HOST_TOKEN="$(openssl rand -hex 16)" || exit 1
[ -n "$CC_HOST_TOKEN" ] || exit 1
CC_HOST_TOKEN="$CC_HOST_TOKEN" pnpm host --port 5175 >/dev/null &
HOST_PID=$!
trap 'kill "$HOST_PID" 2>/dev/null || true' EXIT

VITE_HOST_TOKEN="$CC_HOST_TOKEN" pnpm dev   # http://127.0.0.1:5174
```

Verification scenario (does the §1.3 loop actually turn):

1. Register 2 projects (+ Project → enter an absolute path)
2. Create a session in each and give it a task that needs approval (e.g. "add a line to the README")
3. Pretend to step away, then open the inbox with **⌘I** to see the pending list
4. Jump with Enter → approve with **y** → automatically moves to the next item
5. Once the result has been read, archive the session with **d** to clear the inbox
6. Try cycling through only the pending sessions with **⌘⇧A**

The test: **"is this better than 3 terminal tabs?"** Whatever complaints come out of this become the M1.5 backlog.

## Known limitations (out of M1 scope — intentional)

- Restart recovery is not implemented (M1.5): stopping and restarting the host loses the session processes. The conversation record stays in SQLite.
- No Codex adapter (M2). No git panel, file tree, code viewer or attachments (M2).
- The "always allow" approval rule lives only in session memory and does not survive a restart (wired to store rules in M1.5).
- No virtual scrolling for the conversation (needed in M1.5 once messages run into the hundreds).

## Fixes made afterward (found while attempting G5)

1. **Tailwind was not generating classes** — v4's automatic source detection works from the Vite root (`apps/web`), so it never found the `packages/ui` components in the monorepo. CSS came out as only the 4KB base styles, and the screen rendered unstyled. Fixed by adding two `@source` lines in `packages/ui/src/styles/index.css` (back to a normal 13.7KB). E2E verifies with `data-testid`, not classes, so it never caught this defect — a reminder that visual regressions sit outside the scope of these tests.
2. **A raw stack trace on port conflict** — `ws` re-emitted the http server's error on its own instance, which killed the process. It now reports the cause and 3 ways to fix it, then exits.

## G5 measurement (2026-08-15, against one real project repository, run by an agent on the person's behalf)

Ran the control loop end to end with a real host and a real Claude session. Result: **the loop turns.**
Project registration (including a non-git directory) → session creation → receiving an approval request → reject/allow →
cycling the inbox → cleanup with `d` all worked in practice, and the cwd, context gauge and git status display were all accurate.

3 defects found and fixed (all with regression tests added):

1. **Inbox shortcuts were swallowed by the composer** — right after sending a message, focus stays in the composer, and the inbox key handler was set to ignore keys when the target is a `TEXTAREA`, so `d`, `j` and `k` got typed into the message body instead. This reproduces 100% of the time in real usage order, but E2E tests were hiding it by clicking `body` first.
   → Fixed by treating the inbox as a modal that takes focus when it opens.
2. **A send failure was swallowed silently** — sending a message to a session with no live process (restored after a host restart) left only the message bubble on screen, with the error logged only to the console. The user would wait forever for a reply.
   → On failure, the bubble is removed and a toast tells the person what to do.
3. **A restored session's past conversation was empty** — the record was there in SQLite, but nothing loaded it.
   → The stored conversation is now loaded when a session gets focus (`messagesToChat` is finally used for something).

A false lead: the agent initially tried to write a file to the home directory, which looked like a cwd bug, but checking `pwd` showed the session cwd was correct. The model had simply interpreted "this directory" in its own way.

Lesson: all 16 E2E tests were passing while these 3 defects still lived. When tests do not reproduce the real order of use (focus state, a dead session, after a restart), a passing suite means nothing on its own.
