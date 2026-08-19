# A-4: verifying the design promise (2026-08-15)

> The promise: **"add one adapter and ui, core and protocol stay as they are"** (architecture.md axis of change C3)
>
> **Verdict: the promise held.** Every change outside the adapter was of kind ②(a new feature); there were no ①(forced in order to attach the adapter).

## Classification

By the criterion plan A-4 set, changes outside `adapters/codex/**` are split into two kinds.

### ① Changes that were unavoidable in order to attach the adapter — **none**

`core` **did not change by a single line.** The state machine, inbox ordering, read rules and approval policy
accepted Codex events as they were. Whatever consumes `NormalizedEvent` does not know a tool was added.

`platform/ports` is unchanged too — not one method was added to `AgentPort` for Codex.

### ② Changes because Codex brought new capabilities — 4 places (normal)

| Change | Why |
|---|---|
| `protocol`: added the `compaction` event | Codex gives `thread/compacted`. This was the unimplemented part of the compaction marker FR-14 asked for, and the Claude adapter can use the same event later |
| `ui`: new `NewSessionDialog` | With two tools there had to be **a screen to choose on** (FR-7). With one tool the screen had no reason to exist |
| `ui/store`: `createSession` takes tool, model and preset | Same reason as above. It used to be fixed at `'normal'` with no model passed |
| `platform/mock`: record `lastCreateParams` | A verification device so tests can see "does the chosen value get passed through" |

## Conclusion and follow-up

There is **no reason to change** the design document (architecture.md C3). If anything there is one more piece of evidence for it:
the adapter interface and `NormalizedEvent` normalisation did absorb the differences between tools.

One thing to state precisely, though: **"the UI does not change" was never the promise.** That adding a tool requires a screen to choose on
is a feature addition, not a design failure. What C3 defends against is "having to tear up **the existing structure** because of a new tool",
and that did not happen.

## Things that surfaced along the way

- Codex's `thread/name/updated` does not arrive in short sessions. FR-18 (automatic names) is already satisfied by the first
  prompt so this is not a problem, but the verification criterion that assumed a title event was wrong — the criterion was fixed.
- Introducing the session creation dialog exposed a **defect where the starting prompt was not visible in the conversation view** (E2E caught it).
  It is a path that did not exist before, when it was only ever sent through the input box.
