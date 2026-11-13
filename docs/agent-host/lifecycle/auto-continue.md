# Continuing a turn once its cause clears (#1415, #2238, #1693)

A turn the provider's capacity, the network or a usage limit stopped goes on by itself once that cause clears. One owner
does it for all three: `sessions/turn-continue.ts` (`TurnContinue`). Each cause is a row; what differs is **when** the cause
has cleared, never **how** the turn goes on: always through Centralu's own channel (`deliverMail`, a note the history
read-back knows as Centralu's, `isCentraluNote`), never a message of the person's. Nothing the person wrote is sent again.

Owner decisions: #1415 (2026-10-26) both settings on by default, the scope, what never continues, the wait on screen with
**Continue now** and **Don't continue**, the asking session told once; #2238 (2026-11-13) option A, every turn the network
ended continues once the network is back, whether or not it had made tool calls (this replaces #698's "Nothing is resent
by itself" for these two causes only); #1693 (2026-10-28) the overload retry stays as built.

## The causes

| Cause | Stop | Clears when | Tries in a row |
|---|---|---|---|
| `overloaded` (#1693) | Codex's `serverOverloaded` error is held: the turn stays `working`, a `retry` notice says when | after `DELAYS_MS` (30 s, 2, 5, 10 min), unchanged | 4 (the delays) |
| `network` | a turn ends in an error the network caused (`interruption.reason: 'network'`, [turn-endings-and-mail.md](turn-endings-and-mail.md)) | the tool's API host answers a probe | 5 |
| `limit` | a turn ends on the account's usage limit: the tool's `limit_reached`, or an error in the tools' own limit words ("You've hit your … limit", "Claude AI usage limit reached", `isPlanLimit`; `interruption.reason: 'limit'`). A 429, a gateway's quota or a plan upgrade notice is not one: nothing says it resets for the account | the reset the tool said, plus `RESET_MARGIN_MS` (60 s): its data's first (`limit_reached.resumeAt`), else its words' (`planLimitResetAt`: Codex's 429 "… try again at 6:17 PM.", Claude's "resets 7:50pm", on the computer's clock); no reset said: 30 minutes after the stop | 3 |

**Why those N.** Overloaded keeps its four delays (#1693). Network: an outage can flap, and each continue is made only after
the API answered, so a sixth failure in a row says the turn itself fails there, not the network. Limit: one reset can be
followed by the weekly window, or a reset time that was not one (the 30-minute retry of a limit with no time); a fourth stop
on the limit says the account will not run it now. The count starts over when a turn finishes or the person acts. When the
tries are spent the stop is left as it is, with a `continue` notice saying how often Centralu continued it.

**Never continued**: a turn the person or an Assistant stopped (no interruption is set); `refused`, `other`, auth and model
errors (they set no `network` or `limit` reason); a Codex credits or spend limit (`limit_reached.credits`: they do not reset
with time; kept on the session's `limit.credits`, so it holds whether Codex says it before or after the turn's error, and a
credits notice after the wait is set takes the wait away); a compaction turn; a stop whose setting is off; a stop while the host is leaving.

**Known limits.**
- *A Codex credits stop seen only as its 429.* Codex says a credits or spend limit in `account/rateLimits/updated` (`rateLimitReachedType`, `spendControlReached`), and the host keeps it (`limit.credits`). Its 429 error carries no such type: `codexErrorInfo` is `usageLimitExceeded` for both (`adapters/codex/generated/v2/CodexErrorInfo.ts`), and no recording holds the words of a credits 429. A credits stop that comes with the error alone is taken as a plan limit and continued at the time it says; each continue fails the same way, so it ends at the limit's cap (3) with the notice.
- *Codex while the connection is refused.* Codex retries by itself without end ("Reconnecting... waiting for network"): the turn stays `working`, and after 5 minutes the session shows `reconnecting` (#698), with no wait. This engine arms only when Codex gives up and ends the turn with an error (measured on Codex 0.160.0, macOS). Claude Code gives up after its own retries (about three minutes), so its network stops arm.

## Decisions

| Decision | Why |
|---|---|
| **The network is back** is a probe: an HTTP `HEAD` of the tool's API base (`AgentAdapter.apiUrl`: Claude `env.ANTHROPIC_BASE_URL` of its user `settings.json`, then the environment's, then `https://api.anthropic.com` (`adapters/claude/api-url.ts`), Codex `chatgpt_base_url` of its user `config.toml` (a plain top-level line only: no TOML parser in the host), then `OPENAI_BASE_URL`, then `https://chatgpt.com` (`adapters/codex/api-url.ts`); both files read through the OS layer), 10 s timeout, redirects not followed. **Any** HTTP answer counts, a 401 or 404 included (`sessions/api-answers.ts`) | Reachability is the question, not the account: the probe carries no credential and costs no quota. The tool's own base URL is what its turns use, so a proxy or a gateway is probed as the turn would reach it |
| Probes run per tool, not per session, at 15 s, 30 s, 1, 2 min and then every 5 min (`PROBE_STEPS_MS`), while any network wait of that tool stands. A wait starts the probe at the step of its tries (the first stop at 15 s, a second in a row at 30 s, …): five tries take about 9 minutes, not 75 s | Several stopped sessions of a tool share one probe. The steps back off so a long outage costs a request every 5 minutes. A proxy that answers the probe while the API calls fail would otherwise spend the tries in a minute and a quarter (the #2239 review) |
| **A probe that never answers** ends at `MAX_FAILED_PROBES` (80 failures in a row, about 6 hours awake): the tool's network waits end, as **Don't continue** ends them, with a `continue` notice "Centralu could not reach this tool's API for hours, …" | A base URL the probe does not know (a project's own settings, a tool with no `apiUrl`) must not leave a wait standing forever |
| **Every continue counts**, a failed one too: the note it hands the tool stays in the tool's history | The cap and the per-try backoff bound those notes: at most five in a row, minutes apart (the #2239 review's "notes pile up") |
| **A sleeping computer** is a wake: a tick of the 5 s timer that comes 30 s or more late probes every tool at once | No OS signal is needed (none reaches the host on every platform); timers do not run during sleep, so a late tick is the wake |
| Another turn of the same tool finishing releases that tool's network waits at once | That turn reached the API just now; no probe can say more |
| **Staggering**: continues of one tool go at least `STAGGER_MS` (5 s) apart, in the order their causes cleared | A reset or a network return clears many sessions at once (#1913 saw many wakes at once). The tool stands for the account: the host does not know which account a session runs under, and one tool's sessions on one computer share one in practice |
| **Survives a host restart without a store step**: the wait is a field of the session's stored interruption (`Interruption.autoContinue: {at?, tries}`, the `sessions.interruption` JSON column). A host that starts takes every stored wait up again (`restore`, the end of `HostTenure.restoreAtStart`); a limit whose reset passed while no host ran continues within seconds | The stop and its reset are already stored with the session; an older build reads the field as an extra and drops it (stored-shapes.md), so a rollback leaves a plain stop |
| The overloaded case stores nothing, as built | Its turn is held `working`: a host that leaves ends it with its error (`stopAll`), as #1693 decided |
| **What cancels a wait**: the person's Stop (`agents.interrupt`), any message into the session (it carries the work on itself), a turn that starts any other way (mail the mailbox delivers: `observe` sees the session go `working` before the interruption is cleared), **Don't continue** (`sessions.stopContinue`), turning the cause's setting off (`settingsChanged`, at once, not when the wait comes due; a continue already on its way is stopped by the send's one gate, which reads the setting right before the hand-off), the trash or a delete. Each is honoured until the note is handed to the tool: the send is gated on the wait still standing | The same rules as the overload retry's (`cancel`, `supersede`); after the hand-off the tool runs an ordinary turn, which Stop stops like any |
| **Continue now** sends the person's Continue ("Continue where you stopped. …", `CONTINUE_WORDS`), which takes the wait away as any message does | One Continue, the same sentence everywhere: the inbox, the header, the line above the composer |
| **Linked hosts**: a session continues on the host that runs it. A hub never sees a linked machine's session events in its own `SessionEvents` (they pass to its windows), so its engine has no wait for it; **Don't continue** and Stop on a linked session are routed to the machine that owns it (`links/routes.ts`) | No double continue: one engine per session, the owner's |
| **Who is told**: a stop with a wait releases what it held but tells nobody yet (`StopTold.held`). When the wait ends (`StopNotices.stopWaitEnded`) the senders of what that stop released and nobody answered yet are told once: that the work continued, with the session that started it on the first continue; or, when it ends without one (Stop, a message, a turn the mailbox started, **Don't continue**, the trash, the setting off, the tries or the probe spent, a continue the tool refused after it was handed), the ordinary stop notice they would have had at the stop (#1948). When the work goes on in a turn of its own instead (the person's Continue: Continue now or the inbox's, the message `CONTINUE_WORDS`, told once it went in; or mail the mailbox delivered), they read "<name> lost the network, and its work has gone on.", not that Centralu continued it: one wording per way it went on. A Continue that does not go in is told as the stop. Any other message of the person's is them taking the work over: told as the stop. Woken only from a turn | The owner's "told once, when the work continues". A notice at the stop and another at the continue told twice, and the first said the work had stopped while it was about to go on (the #2239 review). The released questions stay open, so the continued turn's answer still answers them |
| **The settings** are two booleans of the person's preferences (`continueAfterLimit`, `continueOnNetwork`; absent reads as on), rows under Settings › Background & updates › Agents, and `set_preferences` takes them | Per computer: a linked machine keeps its own (follow-up if one switch should reach both) |
| **The update-cut continue** (#1618, [continue-after-update.md](continue-after-update.md)) keeps its own delivery and shares the words (`CONTINUE_WORDS`) and the note's recognition (`isCentraluNote`) | Its trigger is a list the leaving host writes and its delivery waits for the session's resume at start; moving it into this engine would change #1618's rules for no gain. One sentence, one recognition |

## Where it shows

The interruption the host sends says the wait (`autoContinue`); the screen draws it and works nothing out. The session's
**header** (owner, 2026-10-26) reads "Usage limit · continues at 01:20" or "Network lost · continues when the network is
back", with **Continue now** and **Don't continue** (`Button`, `features/session/AutoContinueWait.tsx`); it fades in and
out (`usePresence`, `cc-fade` / `cc-fade-out`, design-system.md §9). The line above the composer says the stop as before
this change, and shows its **Continue** only when no wait stands, so no button shows twice; the button fades out as a wait comes and back in as it goes. One test says whether a wait stands for all three places (`waitStands`, `components/primitives.tsx`). The inbox row says the wait in the
header's words, and its Continue reads **Continue now** then. When the continue goes in, the conversation shows "The network is back, so Centralu continued this turn." or
"The usage limit reset, so Centralu continued this turn.".

## Tests

`sessions/auto-continue.test.ts` (fake timers and a stubbed `fetch`: the probe, a wake, another turn releasing the wait, the
cap, every cancel, the settings, a restart, a limit's reset, credits, staggering), `sessions/turn-continue.test.ts` (the
overload cases, unchanged), `mail/stop-notices.test.ts` (who is told), `sessions/interruptions.test.ts` (which ends are limit
stops), `features/inbox/inboxLabel.test.ts` (the row's words), `e2e/fixtures/interrupted-sessions.ts` (the header's wait, its buttons, the line and the inbox row).
