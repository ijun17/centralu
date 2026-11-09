import { z } from 'zod'
import { MachineId } from './machines.js'

/** The calls a machine makes to its hub, which only the host reads: the UI's bundle leaves them out (#1648). */

/**
 * What a hub tells a machine it links to about the reverse direction (#550, `host.hubOffer`): who it is, and whether the
 * machine's sessions may ask its projects. The hub's id is its own, made once and kept in its store; the machine shows
 * the hub to its sessions by `name`, and calls it back on the connection the offer came in on, and on no other.
 * `mail`: the hub takes mail from the sessions it started on the machine to the session that started each (`hub.mail`,
 * #2067), whatever `on` says. Additive: a hub from before it leaves it out, and a machine from before it drops it.
 * `you`: the machine's own id at this hub, so it reads `session:<hub id>/<you>.<id>` as its own session (#2067 item 2,
 * docs/plans/linked-mail.md §6). A hub that sends it takes mail from any session there to any session it can reach;
 * without it, only `parent`
 */
export const HubOffer = z.object({
  hub: z.object({ id: MachineId, name: z.string().min(1).max(200) }),
  on: z.boolean(),
  mail: z.boolean().optional(),
  you: MachineId.optional(),
})
export type HubOffer = z.infer<typeof HubOffer>
/** One of a hub's projects as a machine's session may name it (#550, `hub.projects`) */
export const HubProject = z.object({ id: z.string().min(1).max(200), name: z.string().max(500) })
export type HubProject = z.infer<typeof HubProject>
/**
 * An ask_project of a machine's session into a hub's project (#550, `hub.askProject`). `caller` is the asking session as
 * that machine names it, its project's name and its agent depth there; the hub knows the machine itself from the link
 * the call came in on, never from these parameters. Without `task`, the call waits again for the task that session
 * already gave
 */
export const HubAskParams = z.object({
  caller: z.object({
    sessionId: z.string().min(1).max(200),
    name: z.string().max(500),
    project: z.string().max(500),
  }),
  project: z.string().min(1).max(500),
  session: z.string().max(500).optional(),
  task: z.string().max(200_000).optional(),
  /** The depth the asked session works at: the caller's on its machine, plus one (#867, #838) */
  depth: z.number().int().min(1).max(64),
})
export type HubAskParams = z.infer<typeof HubAskParams>
/** What a hub answers `hub.askProject` (#550): the asked session's last words, or that it still works, or why not */
export const HubAskResult = z.union([
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({
    ok: z.literal(true),
    state: z.enum(['done', 'working']),
    project: z.string(),
    sessionId: z.string(),
    sessionName: z.string(),
    answer: z.string().optional(),
    notice: z.string().optional(),
  }),
])
export type HubAskResult = z.infer<typeof HubAskResult>
/**
 * A message from a session the hub started on the machine to the session that started it (#2067, `parent`;
 * docs/plans/linked-mail.md §3). `sessionId` is the sender as the machine names it; the hub qualifies it with the machine
 * the call came in on and finds the parent in its own record, never in these parameters
 */
export const HubMailParams = z.object({
  sessionId: z.string().min(1).max(200),
  // The hub checks the length as for its own sessions, and refuses it in its words
  text: z.string().min(1).max(200_000),
  needsReply: z.boolean().optional(),
  urgent: z.boolean().optional(),
  /** The recipient, as the hub names it (`session:<hub id>/<id>`); none: the session that started the sender (item 2, additive) */
  to: z.string().min(1).max(300).optional(),
  /** The message this answers, by its id, which both sides keep (item 2) */
  replyTo: z.string().min(1).max(200).optional(),
  /** The sender's name, as the recipient reads it */
  name: z.string().max(500).optional(),
  /**
   * A notice to `to` rather than the session's message (the "no longer watched" notice, item 2). The hub writes it as the
   * machine's, never as its own Centralu's, and only to a session that sent mail to one of that machine's sessions
   */
  notice: z.boolean().optional(),
})
export type HubMailParams = z.infer<typeof HubMailParams>
/**
 * What a hub answers `hub.mail`: the stored message's id and the parent's name, or a refusal with the hub's reason and
 * words, after which nothing is written there. `not_yours`: this hub did not start that session (another hub may have)
 */
export const HubMailResult = z.union([
  // `address`: the recipient as the hub names it, which the sender's copy is kept under (#2067 item 2, additive)
  z.object({ ok: z.literal(true), messageId: z.string().min(1).max(200), to: z.string().max(500), address: z.string().max(300).optional() }),
  z.object({ ok: z.literal(false), why: z.string().min(1).max(100), text: z.string().max(4000) }),
])
export type HubMailResult = z.infer<typeof HubMailResult>
/**
 * A message from the hub's side to a session of the machine (#2067 item 2, `host.mail`; docs/plans/linked-mail.md §6):
 * `from` is an address as the hub names it (one of its sessions, another machine's, or `centralu` for a notice), `to`
 * the machine's own session id. The machine takes it only on a connection a hub offered on, and only from that hub's ids
 */
export const HostMailParams = z.object({
  from: z.string().min(1).max(300),
  name: z.string().max(500).optional(),
  to: z.string().min(1).max(200),
  text: z.string().min(1).max(200_000),
  needsReply: z.boolean().optional(),
  urgent: z.boolean().optional(),
  replyTo: z.string().min(1).max(200).optional(),
  notice: z.boolean().optional(),
})
export type HostMailParams = z.infer<typeof HostMailParams>
/**
 * The state of one recipient row of a message that crossed a link (#2067 item 2, `hub.mailRows`, `host.mailRows`): the
 * recipient as the hub names it, and what the side that sends it knows. Merged forward only on the other side
 */
export const MailRowState = z.object({
  messageId: z.string().min(1).max(200),
  recipient: z.string().min(1).max(300),
  deliveredAt: z.number().nullable(),
  readAt: z.number().nullable(),
  settled: z.string().max(40).nullable(),
  settledAt: z.number().nullable(),
  answerId: z.string().max(200).nullable(),
  releasedAt: z.number().nullable(),
  releasedWhy: z.string().max(40).nullable(),
  /** The message's sender, as the hub names it: a hub passes a row of mail between two machines on by it */
  sender: z.string().max(300).optional(),
})
export type MailRowState = z.infer<typeof MailRowState>
export const MailRowsParams = z.object({ rows: z.array(MailRowState).max(500) })
/** One session a directory search found (#2067 item 3, docs/plans/linked-mail.md §8): what the ranking and the answer read */
export const DirectoryEntry = z.object({
  address: z.string().min(1).max(300),
  name: z.string().max(500),
  project: z.string().max(500).nullable(),
  machine: z.string().max(200).nullable(),
  role: z.string().max(40),
  state: z.string().max(40),
  /** Working now */
  busy: z.boolean(),
  /** When it last waited or started, ms */
  at: z.number(),
})
export type DirectoryEntry = z.infer<typeof DirectoryEntry>
/** A search of a hub's directory: the words, how many it returns at most, and `exact` for a name looked up by `mail send` */
export const HubFindParams = z.object({ query: z.string().max(500), limit: z.number().int().min(1).max(50), exact: z.boolean().optional() })
export type HubFindParams = z.infer<typeof HubFindParams>
/** What a hub found: the best `limit` entries, how many matched in all, and the machines that could not be read, each with why */
export const HubFindResult = z.object({
  entries: z.array(DirectoryEntry).max(50),
  matched: z.number().int().min(0),
  total: z.number().int().min(0),
  away: z.array(z.object({ name: z.string().max(200), why: z.string().max(300) })).max(50),
})
export type HubFindResult = z.infer<typeof HubFindResult>
/**
 * The calls a machine makes to a hub that linked to it (#550, the reverse direction; docs/protocol.md §1). Not RPC
 * methods: no window calls them, the router never sees them, and a hub answers them only through the handler its link
 * to that machine has, and only while that machine's switch is on; `hub.mail` whatever the switch says
 */
export const HubMethods = {
  /** The hub's projects a machine's session may ask */
  'hub.projects': { params: z.object({}), result: z.object({ projects: z.array(HubProject) }) },
  /** An ask_project into one of them, behind the hub's card for the pair */
  'hub.askProject': { params: HubAskParams, result: HubAskResult },
  /** A message of a session the hub started on the machine to the session that started it (#2067). Additive */
  'hub.mail': { params: HubMailParams, result: HubMailResult },
  /** The rows of messages that crossed, as the machine knows them (#2067 item 2). Additive */
  'hub.mailRows': { params: MailRowsParams, result: z.object({ ok: z.literal(true) }) },
  /** A search of the hub's directory of sessions, its machines' included (#2067 item 3). Additive */
  'hub.find': { params: HubFindParams, result: HubFindResult },
} as const
export type HubMethodName = keyof typeof HubMethods
