import { z } from 'zod'
import { MachineId } from './machines.js'
import { AppId } from './entities/ids.js'
import { LinkedAppCallResult, LinkedAppsResult } from './linked-apps.js'

// The calls a machine makes to its hub (docs/protocol.md §1 "reverse direction", §3 host row); only the host reads
// them, so the UI's bundle leaves them out (#1648).

/**
 * `host.hubOffer`. The machine calls the hub back on the connection the offer came in on and no other. `mail` holds
 * whatever `on` says; without `you`, a machine's session mails only its `parent`.
 */
export const HubOffer = z.object({
  hub: z.object({ id: MachineId, name: z.string().min(1).max(200) }),
  on: z.boolean(),
  mail: z.boolean().optional(),
  you: MachineId.optional(),
  apps: z.boolean().optional(),
  /** Oldest first; the hub deletes those the machine `lacks`. An older machine answers no `lacks` and all are kept */
  open: z.array(z.string().min(1).max(200)).max(500).optional(),
})
export type HubOffer = z.infer<typeof HubOffer>
export const HubProject = z.object({ id: z.string().min(1).max(200), name: z.string().max(500) })
export type HubProject = z.infer<typeof HubProject>
/**
 * The hub knows the machine from the link the call came in on, never from these parameters. Without `task`, the call
 * waits again for the task that session already gave
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
  /** The caller's depth on its machine, plus one (#867) */
  depth: z.number().int().min(1).max(64),
})
export type HubAskParams = z.infer<typeof HubAskParams>
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
    /** With `working`, the report comes later (`host.mail { report }`); with `done`, the answer is the report */
    taskId: z.string().min(1).max(200).optional(),
  }),
])
export type HubAskResult = z.infer<typeof HubAskResult>
/** The most tasks a report across names as covered (`TaskReport.covers`): the newest, when a giver left more open */
export const TASK_REPORT_COVERS_MAX = 100
/** How a crossed task's turn ended: the mailbox's `TurnReport` without its words */
export const TaskReport = z.object({
  outcome: z.enum(['finished', 'failed', 'stopped', 'paused', 'waiting']),
  answer: z.string().max(2_000).optional(),
  error: z.string().max(200).optional(),
  reason: z.string().max(200).optional(),
  paused: z.number().int().min(0).max(10_000).optional(),
  waitingOn: z.number().int().min(0).max(10_000).optional(),
  personSince: z.literal(true).optional(),
  after: z.literal(true).optional(),
  /** The same giver's other open tasks this report settles too; the receiver settles only its own (docs/protocol.md §3.3) */
  covers: z.array(z.string().min(1).max(200)).max(TASK_REPORT_COVERS_MAX).optional(),
})
export type TaskReport = z.infer<typeof TaskReport>
/**
 * The hub qualifies `sessionId` with the machine the call came in on and finds the parent in its own record, never in
 * these parameters (docs/plans/linked-mail.md §3)
 */
export const HubMailParams = z.object({
  sessionId: z.string().min(1).max(200),
  // The hub checks the length as for its own sessions, and refuses it in its words
  text: z.string().min(1).max(200_000),
  needsReply: z.boolean().optional(),
  urgent: z.boolean().optional(),
  /** As the hub names it (`session:<hub id>/<id>`); none: the session that started the sender */
  to: z.string().min(1).max(300).optional(),
  replyTo: z.string().min(1).max(200).optional(),
  name: z.string().max(500).optional(),
  /** Written as the machine's notice, never the hub's, and only to a session that mailed one of the machine's sessions */
  notice: z.boolean().optional(),
  /** Picked by the sender; a second send of it is the one already kept, so a send whose answer was lost can be retried */
  id: z.string().min(1).max(200).optional(),
  /** With `to: 'person'` (#1987); an older hub refuses `person` as `bad_address` */
  subject: z.string().max(500).optional(),
  choices: z.array(z.string().max(500)).max(10).optional(),
  /** With `sessionId: 'centralu'`, `replyTo` the task; taken only from the machine the task went to */
  report: TaskReport.optional(),
})
export type HubMailParams = z.infer<typeof HubMailParams>
/** A refusal writes nothing; `not_yours`: this hub did not start that session (another hub may have) */
export const HubMailResult = z.union([
  // `address`: the recipient as the hub names it, which the sender's copy is kept under
  z.object({ ok: z.literal(true), messageId: z.string().min(1).max(200), to: z.string().max(500), address: z.string().max(300).optional() }),
  z.object({ ok: z.literal(false), why: z.string().min(1).max(100), text: z.string().max(4000) }),
])
export type HubMailResult = z.infer<typeof HubMailResult>
/**
 * Taken only on a connection a hub offered on, and only from that hub's addresses (docs/plans/linked-mail.md §6).
 * `from: 'person'` is the hub's person answering from its Inbox; an older machine refuses it (`not_allowed`)
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
  /** As `HubMailParams.id` */
  id: z.string().min(1).max(200).optional(),
  /**
   * Work a hub's session gives (#1948). `forPerson`: the hub's Assistant's `send_to_session`, acting for the person
   * (#2258), read only from the hub on whose link it came
   */
  task: z
    .object({
      origin: z.enum(['start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project']),
      note: z.literal(true).optional(),
      forPerson: z.literal(true).optional(),
      /** The hub's caller's depth, plus one (#867) */
      depth: z.number().int().min(1).max(64).optional(),
    })
    .optional(),
  /** On a task this machine's session gave the hub; taken only from the hub the task went to */
  report: TaskReport.optional(),
})
export type HostMailParams = z.infer<typeof HostMailParams>
/** A hub's handoff moved `from`'s tasks here to `to`; the machine moves only tasks that hub's link brought */
export const MailMoveParams = z.object({ from: z.string().min(1).max(300), to: z.string().min(1).max(300), ids: z.array(z.string().min(1).max(200)).min(1).max(500) })
export type MailMoveParams = z.infer<typeof MailMoveParams>
/** One recipient row of a message that crossed a link, as the sender knows it; the other side only merges it forward */
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
  /** As the hub names it: a hub passes a row of mail between two machines on by it */
  sender: z.string().max(300).optional(),
})
export type MailRowState = z.infer<typeof MailRowState>
export const MailRowsParams = z.object({ rows: z.array(MailRowState).max(500) })
/** One session a directory search found (docs/plans/linked-mail.md §8) */
export const DirectoryEntry = z.object({
  address: z.string().min(1).max(300),
  name: z.string().max(500),
  project: z.string().max(500).nullable(),
  machine: z.string().max(200).nullable(),
  role: z.string().max(40),
  state: z.string().max(40),
  busy: z.boolean(),
  /** When it last waited or started, ms */
  at: z.number(),
})
export type DirectoryEntry = z.infer<typeof DirectoryEntry>
/** `exact`: a name looked up by `mail send` */
export const HubFindParams = z.object({ query: z.string().max(500), limit: z.number().int().min(1).max(50), exact: z.boolean().optional() })
export type HubFindParams = z.infer<typeof HubFindParams>
/** `away`: the machines that could not be read, each with why */
export const HubFindResult = z.object({
  entries: z.array(DirectoryEntry).max(50),
  matched: z.number().int().min(0),
  total: z.number().int().min(0),
  away: z.array(z.object({ name: z.string().max(200), why: z.string().max(300) })).max(50),
})
export type HubFindResult = z.infer<typeof HubFindResult>
// A project's app used across a link (docs/plans/remote-hub.md §13.3). `session` is the caller's id on its own host;
// the app's host qualifies it by the link the call came on, never by what the call says.

/** `start`: start that app first if it has not listed its tools yet, as attaching one here does */
export const LinkedAppsParams = z.object({
  session: z.string().min(1).max(200),
  start: z.object({ projectId: z.string().min(1).max(200), appId: AppId }).optional(),
})
export type LinkedAppsParams = z.infer<typeof LinkedAppsParams>
/** The same `call` again is waited on again, never a second run. Answered within `waitMs`, or `running` */
export const LinkedAppCallParams = z.object({
  call: z.string().min(1).max(200),
  session: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  appId: AppId,
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()),
  waitMs: z.number().int().min(1_000).max(600_000),
  /** Not in the session's list when its agent called: refused there and recorded, never run */
  notListed: z.literal(true).optional(),
})
export type LinkedAppCallParams = z.infer<typeof LinkedAppCallParams>
/** A run already ended stays recorded */
export const LinkedAppCancelParams = z.object({ call: z.string().min(1).max(200) })
export type LinkedAppCancelParams = z.infer<typeof LinkedAppCancelParams>
/** `session` by the receiver's id, the app by the sender's project id */
export const LinkedAppNoticeParams = z.object({
  session: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  appId: AppId,
  name: z.string().max(500),
  text: z.string().min(1).max(8_000),
})
export type LinkedAppNoticeParams = z.infer<typeof LinkedAppNoticeParams>

/**
 * Not RPC methods: the router never sees them, and a hub answers them only through its link's handler, while that
 * machine's switch is on; `hub.mail` whatever the switch says
 */
export const HubMethods = {
  'hub.projects': { params: z.object({}), result: z.object({ projects: z.array(HubProject) }) },
  /** Behind the hub's card for the pair */
  'hub.askProject': { params: HubAskParams, result: HubAskResult },
  'hub.mail': { params: HubMailParams, result: HubMailResult },
  'hub.mailRows': { params: MailRowsParams, result: z.object({ ok: z.literal(true) }) },
  'hub.find': { params: HubFindParams, result: HubFindResult },
  'hub.apps': { params: LinkedAppsParams, result: LinkedAppsResult },
  'hub.appCall': { params: LinkedAppCallParams, result: LinkedAppCallResult },
  'hub.appCancel': { params: LinkedAppCancelParams, result: z.object({ ok: z.literal(true) }) },
  'hub.appNotice': { params: LinkedAppNoticeParams, result: z.object({ ok: z.literal(true) }) },
} as const
export type HubMethodName = keyof typeof HubMethods
