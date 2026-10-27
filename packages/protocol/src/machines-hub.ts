import { z } from 'zod'
import { MachineId } from './machines.js'

/** The calls a machine makes to its hub, which only the host reads: the UI's bundle leaves them out (#1648). */

/**
 * What a hub tells a machine it links to about the reverse direction (#550, `host.hubOffer`): who it is, and whether the
 * machine's sessions may ask its projects. The hub's id is its own, made once and kept in its store; the machine shows
 * the hub to its sessions by `name`, and calls it back on the connection the offer came in on, and on no other
 */
export const HubOffer = z.object({
  hub: z.object({ id: MachineId, name: z.string().min(1).max(200) }),
  on: z.boolean(),
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
 * The calls a machine makes to a hub that linked to it (#550, the reverse direction; docs/protocol.md §1). Not RPC
 * methods: no window calls them, the router never sees them, and a hub answers them only through the handler its link
 * to that machine has, and only while that machine's switch is on
 */
export const HubMethods = {
  /** The hub's projects a machine's session may ask */
  'hub.projects': { params: z.object({}), result: z.object({ projects: z.array(HubProject) }) },
  /** An ask_project into one of them, behind the hub's card for the pair */
  'hub.askProject': { params: HubAskParams, result: HubAskResult },
} as const
export type HubMethodName = keyof typeof HubMethods
