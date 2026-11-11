# Asking another project (#371 part B)

`ask_project` is the one way an ordinary session acts outside its own project. Under `auto`,
consent and trust refusals are open and logged; the agent depth is not (#867), it refuses under every preset. The existing target session keeps its own
preset; session creation in another project is forbidden under every preset (#614). Under `safe`
and `normal` it has these controls ([agent-host/delegation/ask-project.md](../agent-host/delegation/ask-project.md)):

- **The person's consent per pair of projects**, asked as a card in the caller's session the first
  time X asks Y; only "always" is remembered (store `project_consents`), and Settings revokes it.
  The card names the selected session as well as its project. Without consent no task is delivered.
  The card is the boundary, not the tool's description: a caller steered by injected text can at most raise a card.
  The card's names (projects, the session, the machine, an app) are JSON-quoted on one line, as the handoff card's
  are, and the task is one line that says how many characters it has in all when it is cut at 160 (#838): a name
  could otherwise read as the card's own words, and a cut task looked like the whole of it. start_agent's card quotes
  its project and branch the same way.
- **What the delegated session runs is gated by its own project's permissions.** The existing session keeps its own
  preset and project trust; its approvals stand as cards in that session. Under a person's global bypass it runs as freely as that person's
  own sessions there — the owner's decision is that the delegated session may change code in its own
  project. The task arrives framed as sent by another session, never as the person.
- **The agent depth** (#867). A session handling an active cross-project task is one level deeper than its asker, so
  at the default depth of 1 it cannot ask a third project, and two projects that consented to each other cannot pass a
  task back and forth without a person. No preset opens it. The same holds across machines (#838 item 12): a hub asking
  a linked machine's session sends the depth that session works at (`host.send`'s `ask`, the caller's depth plus one),
  and the machine counts it until that turn ends (`hubAskDepthKey`), so the session refuses start_agent and ask_project
  as one asked on its own machine would. A machine or hub from before this change neither sends nor reads it: there,
  a linked ask still counts the asked session as one the person started.
- **Trust** (owner decision 2026-10-11, #382). A session in a project the person has not trusted cannot
  ask at all, the rule `attach_app` follows: text in that repository could be the one asking, and the
  card would then be the only thing between a planted instruction and another project. An untrusted
  project *can* be asked, and the card says so ("Let X ask Y (not trusted) to …", and a line on what
  that means): the selected session there reads none of its settings or instruction files and runs none
  of its apps, but works on its files under the person's own permission settings. A remembered
  "always" for the pair still skips the card, also after the target loses trust. Trust and depth are read
  again once the card is answered, and again before a queued ask goes in.
- **Existing sessions only** (#614). Selection by name or id is confined to ordinary sessions in the
  named target project. Without a selector, exactly one is required; ambiguity lists names, states
  and last activity, and no session refuses until the person opens one. Builders, app agents and
  assistants cannot be targets. No preset permits cross-project child creation. Old ask-created
  sessions remain ordinary sessions without cross-project ownership. A session busy with a turn that
  is not the caller's returns the choices and receives nothing (#677): a note into that turn only
  from an `auto` caller whose target takes tracked mid-turn input, or a queue for a new turn; never a
  fork, which would create a session in another project. Another delegation's watcher cannot be
  overwritten. Delivered input is visible in conversation with the
  asking session's `from`; waits follow its completion receipt, including queued turns. Caller Stop
  reaches a target only during an active wait. If the task joined the person's running turn, caller
  Stop/cancellation ends only that caller's wait, leaving the turn, receipts and other observers
  running. A bounded call that already returned does not confer a right to stop the target.
- **The answer is someone else's words**, JSON-quoted for the caller like a worker's preview.
- **Files come back by name, and only from inside the target project.** A named path is granted
  to the caller only if it exists inside the target project's folder after resolving symlinks
  (`canonicalPath`, so the grant and a later read compare in one spelling; the grant is kept as it
  was made and never resolved again, so a link swapped in for a granted folder opens nothing new), and
  never the project root itself; a file opens that file, a folder what is under it. A path outside
  is listed and not opened (Claude then asks the person before reading it; Codex does not restrict
  reads at all, so for a Codex caller the grant changes nothing and the residual is the same as any
  Codex read).
- **Residual:** within an allowed pair, the task text comes from the calling model, so injected text
  in the caller's context can reach the target project as a task. The target's approvals, the
  visible session and Stop are the controls left; revoking the pair ends it.

## A linked machine's session asking this computer (#550)

The reverse direction of linked machines ([plans/remote-hub.md](../plans/remote-hub.md) §12.7). The plan treats a linked
machine as the less trusted side: a compromised server must not reach the person's computer by default (remote-hub.md §3.2). So:

- **Off by default, per machine, on this computer.** Only the hub's Settings → Machines turns it on, and the switch is
  read at every call; off refuses at once and forgets the pairs. It is stored on the machine's row and goes with it.
- **An allowlist of two calls**, `hub.projects` and `hub.askProject`, answered only through the handler the hub's link
  to that machine was given. A machine cannot reach any RPC method, the router, a session's conversation, a file, an
  app or the Assistant through it; anything else is "Unknown method". The machine is the link's own, never what a
  call says, and at most 16 of its calls run at once. A build without the handler drops such a call.
- **Mail is the one exception to the switch** (#2067, owner decision 2026-11-09: every agent may mail every other,
  across machines): `hub.mail`, `hub.mailRows` and `hub.find` are answered whatever the switch says. A message is
  written by the recipient's host through its one send, guards included, from the sender the link names (a machine's
  session is qualified with the link's machine id, never with what the call says), and the recipient reads it as
  another session's text, never as the person's (`cite` is refused across). A machine's notice is that machine's
  message, never the hub's Centralu's, and is taken only for a session that mailed one of its sessions. A machine may tell what became of mail only
  for rows of its own sessions, read off the message stored on the hub, never off the sender the row names: a receipt
  only for its session's own row, a withdrawal only of its session's own message. A hub's rows are checked the same way
  on the machine. On the machine, `host.mail` and `host.mailRows` are taken only on a connection a hub
  offered on, and only from that hub's addresses. Mail out of an untrusted project is refused across rather than held.
- **The hub's card for each pair**, raised in the hub's session that would get the task, so only the hub's windows can
  answer it, and raised whatever that session's preset: `auto` there answers no card of another machine (#550 review).
  It names the machine and the asking session there, quoted on one line;
  turning the switch off closes it. Approving it is remembered for the
  pair until withdrawn (owner decision 2026-10-18): the person approves each session of the machine once per project.
- **The same rules as an ask here** for what runs: an existing ordinary session only, never created; a busy one gets
  nothing; the task framed as from that session on that machine, never as the person or an Assistant (so a seat that
  directs would get it as someone else's words); the agent depth counted across the link; once the pair is approved, the
  target session works under its own preset, trust and approvals (its `auto`, if it has it, then applies to its tool
  calls, never to the pair's card); the answer cut to size; paths in it listed on the machine and none opened.
- **Residual:** the machine names the asking session itself. A compromised machine can use any pair approved for any of
  its sessions, and so reach every project of this computer that a session of that machine was approved for; that is
  what the switch and each approval consent to, and withdrawing a pair or turning the switch off ends it. While the
  switch is on, it can also raise this computer's card as often as its calls allow (16 at once), under names it chose;
  the card says which machine asks, and turning the switch off refuses every call from then on. The task text
  is the machine's agent's words, as for any ask (the residual above). The machine reads its own trust and depth gates
  before it asks; a caller there losing trust while this computer's card stands does not withdraw the card.

JSON framing prevents ambiguous transcript-line assembly; it does **not** make text safe
for an LLM to obey or eliminate prompt injection. Tool scopes and typed approval checks
remain the deterministic authorization boundaries.
