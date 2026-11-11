import { z } from 'zod'

/* The shapes of `facts`, what only Centralu writes about a message (mailbox.ts, docs/plans/mailbox.md §5.4), and the release reasons one names */

/**
 * Why Centralu stopped watching a row. `stopped` to `uncontinued` after `waiting` are the stops of a session (docs/plans/turn-owned-by-no-one.md §4.1):
 * the person's Stop, an error, a usage limit, the network, the tool's own interrupt, a quit or a shutdown, and a cut turn Centralu could not continue.
 * A build that does not know a word reads it as null
 */
export const RELEASE_WHY = ['reminders', 'waited', 'working', 'waiting', 'stopped', 'error', 'gone', 'lost', 'limit', 'network', 'interrupted', 'quit', 'shutdown', 'uncontinued'] as const
export type ReleaseWhy = (typeof RELEASE_WHY)[number]

/** What only Centralu writes about a message (§5.4). Every key optional; a key a newer build added is kept */
export const MailFacts = z.looseObject({
  outcome: z.enum(['finished', 'failed', 'stopped', 'paused', 'waiting']).optional(),
  about: z.object({ session: z.string() }).optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
  paused: z.number().optional(),
  waitingOn: z.number().optional(),
  update: z.number().optional(),
  personNote: z.boolean().optional(),
  /** On a last response (#1948 step 3): the person wrote in the session after the task was given; the task arrived after the response was written */
  personSince: z.boolean().optional(),
  after: z.boolean().optional(),
  answer: z.string().optional(),
  quiet: z.boolean().optional(),
  needsOwner: z.boolean().optional(),
  covers: z.array(z.string()).optional(),
  clarifies: z.string().optional(),
  hostCap: z.boolean().optional(),
  /** On Centralu's warning to the person (#2014): the pair of sessions whose mail started more turns in the hour than it warns at, and how many */
  pairTurns: z.object({ sessions: z.array(z.string()), turns: z.number() }).optional(),
  /** On Centralu's warning to the person (#2024): the session that went through more compaction cycles (`compact_self` with `then`) in the hour than it warns at, and how many */
  compactCycles: z.object({ session: z.string(), count: z.number() }).optional(),
  /** On Centralu's warning to the person (#1684): a send a guard refused (`repeat`, `rate_limited`, `ask_rate`), and whose */
  guardRefused: z.object({ sender: z.string(), reason: z.string() }).optional(),
  answerHeld: z.object({ question: z.string(), answer: z.string() }).optional(),
  refused: z.object({ tool: z.string(), target: z.string(), firstLine: z.string(), projectId: z.string() }).optional(),
  trusted: z.object({ project: z.string(), refused: z.array(z.string()) }).optional(),
  reminder: z.union([z.literal(1), z.literal(2)]).optional(),
  of: z.array(z.string()).max(10).optional(),
  /** A `why` this build does not know reads as null, alone: the element and the list stay */
  unanswered: z.array(z.object({ id: z.string(), recipient: z.string(), why: z.enum(RELEASE_WHY).nullable().catch(null) })).optional(),
  asker: z.string().optional(),
  handedOver: z.boolean().optional(),
  legacyKind: z.string().optional(),
  /** The recipients an older build's person released a moved message to: never held again for them (§6.3) */
  releasedTo: z.array(z.string()).optional(),
  /** On a chain's root: how the person last closed the chain (Mark done `finished`, Drop `dropped`), which the window shows while it stays done */
  closed: z.object({ outcome: z.enum(['finished', 'failed', 'stopped', 'dropped']), at: z.number() }).optional(),
  /** On Centralu's notice to a session whose work the person closed in the Inbox: the chain, how it was closed, and the person's requests in it that were withdrawn (at most ten) */
  chainClosed: z.object({ root: z.string(), outcome: z.enum(['finished', 'failed', 'stopped', 'dropped']), withdrawn: z.array(z.string()).max(10) }).optional(),
  chain: z.array(z.object({ host: z.string(), address: z.string() })).optional(),
  /** On a request to the Assistant: the person's message in the sender's conversation that Centralu checked it cites (docs/plans/cited-requests.md §3) */
  cites: z.object({ seq: z.number(), at: z.number() }).optional(),
  /** On the person's task a script started (§8.1, #1468): the label the host wrote from the script's connection (`scriptLabel`), so no reader takes it for the person's words */
  fromScript: z.object({ credential: z.string() }).optional(),
  /** On the person's answer to a session's question (#1630): it is one of the choices the question offered, pressed in the window; the host decides it, so a session reads it as Centralu's word */
  picked: z.boolean().optional(),
})
export type MailFacts = z.infer<typeof MailFacts>
