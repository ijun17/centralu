import { z } from 'zod'
import { RpcMethods, errorMessage } from '@cc/protocol'
import type { WindowRpc } from './sessions/window-rpc.js'
import { plainQuoted } from './sessions/tool-answers.js'

/**
 * What a host request's generic card shows (#1405 slice 3, host-requests.ts): the call as it will run, and what it acts
 * on, by name.
 *
 * - **As it runs.** The parameters are parsed by the method's own schema first, and the parsed ones are what the card
 *   shows and what runs. A field the schema does not know is dropped before the card, so a caller cannot put text on it
 *   that has no effect ("the person asked for this"), and a call the method would refuse is refused before it asks.
 * - **By name.** A session, project, app or linked machine is named as the window's lists name it (`sessions.list`,
 *   `projects.list`, `apps.list`, `machines.list`, read through the router, so a linked machine's rows are there), with
 *   the machine it lives on, as the session archive's card names its rows. An id that names nothing is refused: the person would
 *   have nothing to judge. What a delete loses is said in a sentence of its own (`EFFECTS`).
 */

/** A call parsed as its method will run it, or why it would not run */
export function asItRuns(method: string, params: unknown): { ok: true; params: unknown } | { ok: false; why: string } {
  const schema = methodParams(method)
  if (!schema) return { ok: false, why: `${method} is not a method this host knows` }
  const parsed = schema.safeParse(params ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : ''
    return { ok: false, why: `its parameters do not fit ${method}${where}: ${issue?.message ?? 'not valid'}` }
  }
  return { ok: true, params: parsed.data }
}

function methodParams(method: string): z.ZodType | null {
  const methods: Record<string, { params: z.ZodType } | undefined> = RpcMethods
  return Object.hasOwn(methods, method) ? (methods[method]?.params ?? null) : null
}

/** What a delete loses, said on its card; a method not named here gets only the card's general sentence */
const EFFECTS: Record<string, (p: Record<string, unknown>) => string> = {
  'agents.deleteSession': (p) =>
    'The session moves to the session archive' +
    (p.deleteWorktree === true ? ', and its worktree is marked to be deleted when the session is deleted from the archive for good' : '') +
    (p.deleteExternal === true ? ", and the tool's own conversation file with it" : '') +
    '.',
  'agents.archiveIfAtRest': () => 'The session moves to the session archive if that loses nothing it holds.',
  'agents.deleteAgentChild': (p) =>
    `The session moves to the session archive, and the worktree on the branch ${plainQuoted(str(p.worktreeBranch), 120)} is deleted when nothing in it would be lost.`,
  'agents.deleteOrchestratorSkill': (p) => `The orchestrator skill ${plainQuoted(str(p.name), 120)} is deleted.`,
  'projects.delete': () => "Centralu's records of the project are erased: its sessions, their conversations, its search index and approval rules. Its folder stays.",
  'apps.remove': () => "The app's folder moves to app-trash in the data folder, and it is taken off every session it was attached to.",
  'machines.remove': () => "The machine is unlinked: its sessions and projects leave this computer's lists.",
  'machines.uninstall': () => 'The host there stops, and what this computer installed there is removed.',
}

/** The sentence saying what the call loses, or '' */
export function effectOf(method: string, params: unknown): string {
  const effect = Object.hasOwn(EFFECTS, method) ? EFFECTS[method] : undefined
  return effect ? `${effect(fields(params))} ` : ''
}

const Named = z.object({ id: z.string(), name: z.string(), machine: z.string().nullable().optional() })
const ProjectRow = Named.extend({ path: z.string() })
const AppRow = z.object({ appId: z.string(), projectId: z.string().nullable(), name: z.string().nullable(), machine: z.string().nullable().optional() })

/**
 * What a call acts on, named: "the session "Fix the parser" on the linked machine "Laptop"", and so on, joined. '' when
 * it names nothing (`machines.add`, `updates.apply`). Not ok when an id it carries names nothing the lists have.
 */
export async function namedTargets(rpc: WindowRpc, params: unknown): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  const p = fields(params)
  const parts: string[] = []
  const list = async <T>(method: string, schema: z.ZodType<T>, args: unknown = {}): Promise<T[]> => {
    const rows = z.array(z.unknown()).safeParse(await rpc(method, args))
    return rows.success ? rows.data.flatMap((r) => { const one = schema.safeParse(r); return one.success ? [one.data] : [] }) : []
  }
  const on = (machine: string | null | undefined): string => (machine ? ` on the linked machine ${quoted(machine)}` : '')
  let machineNamed = false
  try {
    if (typeof p.sessionId === 'string') {
      const s = (await list('sessions.list', Named)).find((r) => r.id === p.sessionId)
      if (!s) return { ok: false, why: 'it names a session this computer does not have' }
      parts.push(`the session ${quoted(s.name)}${on(s.machine)}`)
      machineNamed ||= !!s.machine
    }
    if (typeof p.projectId === 'string' && typeof p.appId !== 'string') {
      const r = (await list('projects.list', ProjectRow)).find((x) => x.id === p.projectId)
      if (!r) return { ok: false, why: 'it names a project this computer does not have' }
      parts.push(`the project ${quoted(r.name)} (${plainQuoted(r.path, 300)})${on(r.machine)}`)
      machineNamed ||= !!r.machine
    }
    if (typeof p.appId === 'string') {
      const machine = typeof p.machine === 'string' ? p.machine : undefined
      const projectId = typeof p.projectId === 'string' ? p.projectId : null
      const a = (await list('apps.list', AppRow, machine ? { machine } : {})).find((x) => x.appId === p.appId && x.projectId === projectId)
      if (!a) return { ok: false, why: 'it names an app this computer does not have' }
      parts.push(`the app ${quoted(a.name ?? a.appId)} [${a.appId}]${on(a.machine)}`)
      machineNamed ||= !!a.machine
    }
    const machineId = typeof p.machineId === 'string' ? p.machineId : !machineNamed && typeof p.machine === 'string' ? p.machine : null
    if (machineId !== null) {
      const m = (await list('machines.list', Named)).find((x) => x.id === machineId)
      if (!m) return { ok: false, why: 'it names a linked machine this computer does not have' }
      parts.push(`the linked machine ${quoted(m.name)}`)
    }
  } catch (e) {
    return { ok: false, why: `what it names could not be read (${errorMessage(e)})` }
  }
  return { ok: true, text: parts.join(', ') }
}

const quoted = (name: string): string => plainQuoted(name, 120)

function fields(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
