import { RpcMethods, type RpcMethodName } from '@cc/protocol'
import { decodeNumber, encodeNumber, splitQualified } from './machine-ids.js'
import type { Qualifier } from './qualifier.js'
import { ROUTES, type Route } from './routes.js'
import { isObj, type Obj } from '../json-value.js'
import { rpcError } from '../rpc-error.js'

/**
 * The hub's request router (docs/plans/remote-hub.md §5): one function in front of
 * `HostServer.onRpc` that sends a call to the machine it names and leaves every other call to the
 * hub's own handler, untouched.
 *
 * The router holds no state of its own. Which machines exist, whether they are reachable, and what
 * they last said all live in `RoutedMachine`, so the same router serves a hub with no links (every
 * call goes to `local`, exactly as before) and one with several.
 */

/** Which window's connection a call came in on (transport/server.ts). Passed to the hub's own handler, never forwarded */
type RpcContext = { client: number }
export type RpcHandler = (method: string, params: unknown, ctx?: RpcContext) => Promise<unknown>

/** One linked machine, as the router needs it (linked-machine-connection.ts implements it) */
export interface RoutedMachine {
  readonly id: string
  readonly name: string
  readonly q: Qualifier
  /** The link is up and answered hello: calls go through */
  readonly reachable: boolean
  /** One call on the remote, in the remote's terms */
  call(method: string, params: unknown): Promise<unknown>
  /**
   * The remote's own lists, as it last gave them (raw, the remote's terms), for when it cannot be
   * asked: the headers mirror (mirror.ts). Null when the hub has never seen them.
   */
  lastKnown(kind: 'sessions' | 'projects'): unknown[] | null
  /** The remote's lists as just read (raw), so the mirror and the hidden set follow them */
  observe(kind: 'sessions' | 'projects', list: unknown[]): void
  /** A session of the remote the hub does not show: its orchestrator and coordinators (§3.4) */
  hides(session: unknown): boolean
}

/**
 * The person's project order across machines (#734), in the hub's terms: hub ids and machine-qualified ids in one list.
 * Each machine keeps the order of its own projects too, but only the hub knows where one machine's stand among
 * another's, so the hub keeps this list in its own store (links/stored.ts).
 */
export interface ProjectOrder {
  read(): string[]
  write(orderedIds: readonly string[]): void
}

export type RouterOptions = {
  local: RpcHandler
  machines: () => Iterable<RoutedMachine>
  /** Absent: the order is per machine, the hub's own projects first (as before #734) */
  order?: ProjectOrder
}

export class MachineUnreachableError extends Error {
  readonly code = 'internal'
  readonly retryable = true
  readonly data: { machine: string; reason: 'unreachable' }
  constructor(machine: RoutedMachine) {
    super(`${machine.name} is not reachable right now; this works again once its link is back`)
    this.data = { machine: machine.id, reason: 'unreachable' }
  }
}

export class NotOnRemoteError extends Error {
  readonly code = 'internal'
  readonly retryable = false
  constructor(method: string) {
    super(`${method} is not available for a project on another machine yet`)
  }
}

export class AcrossMachinesError extends Error {
  readonly code = 'internal'
  readonly retryable = false
  constructor(method: string) {
    super(`An app view reaches only the machine it is open on; ${method} named another machine too`)
  }
}

export class Router {
  constructor(private readonly opts: RouterOptions) {}

  /** The `onRpc` the server calls */
  readonly handle: RpcHandler = async (method, params, ctx) => {
    const route: Route | undefined = (ROUTES as Record<string, Route>)[method]
    // Unknown names go to the hub's handler, which answers "Unknown method" as it always has
    if (!route) return this.opts.local(method, params, ctx)
    switch (route.kind) {
      case 'hub':
      case 'internal':
        return this.opts.local(method, params, ctx)
      case 'session':
        return this.byKey(method, params, 'sessionId', route, ctx)
      case 'project':
        return this.byKey(method, params, route.key ?? 'projectId', route, ctx)
      case 'terminal':
        return this.byKey(method, params, 'terminalId', route, ctx)
      case 'view':
        return this.byView(method, params, route, ctx)
      case 'noRemote': {
        if (this.owner(isObj(params) ? params[route.key] : undefined)) throw new NotOnRemoteError(method)
        return this.opts.local(method, params, ctx)
      }
      case 'machine':
        return this.byMachine(method, params, route, ctx)
      case 'merge':
        return this.merge(method as RpcMethodName, params)
    }
  }

  /** The linked machine an id names, or null for the hub's own (an unprefixed id, or a prefix no link has) */
  private owner(value: unknown): RoutedMachine | null {
    if (typeof value !== 'string') return null
    const split = splitQualified(value)
    if (!split) return null
    for (const m of this.opts.machines()) if (m.id === split.machine) return m
    return null
  }

  private machineById(id: unknown): RoutedMachine | null {
    if (typeof id !== 'string') return null
    for (const m of this.opts.machines()) if (m.id === id) return m
    return null
  }

  private async forward(m: RoutedMachine, method: string, params: unknown): Promise<unknown> {
    if (!m.reachable) throw new MachineUnreachableError(m)
    return m.call(method, params)
  }

  private async byKey(
    method: string,
    params: unknown,
    key: string,
    route: { params?: (p: Obj, q: Qualifier) => Obj; result?: (r: unknown, q: Qualifier) => unknown; orMachine?: boolean },
    ctx?: RpcContext,
  ): Promise<unknown> {
    if (!isObj(params)) return this.opts.local(method, params, ctx)
    if (route.orMachine && (params[key] === null || params[key] === undefined) && typeof params.machine === 'string') {
      // A linked machine's user-folder app, named by `machine` since it has no project (plan §11)
      const m = this.machineById(params.machine)
      if (!m) throw rpcError(`No linked machine ${params.machine}`)
      const { machine: _machine, ...rest } = params
      const r = await this.forward(m, method, route.params ? route.params(rest, m.q) : rest)
      return route.result ? route.result(r, m.q) : r
    }
    const m = this.owner(params[key])
    if (!m) return this.opts.local(method, params, ctx)
    const { machine: _machine, ...own } = params
    let p: Obj = { ...(route.orMachine ? own : params), [key]: m.q.strip(params[key], 'The id') }
    if (route.params) p = route.params(p, m.q)
    const r = await this.forward(m, method, p)
    return route.result ? route.result(r, m.q) : r
  }

  /**
   * An app view's call, which can name its machine by any of several ids (plan §11): a view of a linked machine's
   * user-folder app has no project to say so, only its instance, and a view's message names its conversation as well.
   * Every id it names must point at one machine. An unprefixed id names the hub, so a view of this computer sending
   * to a remote conversation is refused just as the reverse is: the instance and the conversation live on two hosts,
   * and neither could check the other.
   */
  private async byView(
    method: string,
    params: unknown,
    route: { keys: readonly string[]; result?: (r: unknown, q: Qualifier) => unknown; orMachine?: boolean },
    ctx?: RpcContext,
  ) {
    if (!isObj(params)) return this.opts.local(method, params, ctx)
    let target: RoutedMachine | null | undefined
    for (const key of route.keys) {
      const value = params[key]
      if (typeof value !== 'string') continue
      const m = this.owner(value)
      if (target === undefined) target = m
      else if (target !== m) throw new AcrossMachinesError(method)
    }
    // A linked machine's user-folder app, named by `machine` since it has no project (plan §11.9); it must agree with the ids
    if (route.orMachine && typeof params.machine === 'string') {
      const named = this.machineById(params.machine)
      if (!named) throw rpcError(`No linked machine ${params.machine}`)
      if (target === undefined) target = named
      else if (target !== named) throw new AcrossMachinesError(method)
    }
    if (!target) return this.opts.local(method, params, ctx)
    const { machine: _machine, ...own } = params
    const p: Obj = route.orMachine ? own : { ...params }
    for (const key of route.keys) if (typeof p[key] === 'string') p[key] = target.q.strip(p[key], 'The id')
    const r = await this.forward(target, method, p)
    return route.result ? route.result(r, target.q) : r
  }

  private async byMachine(
    method: string,
    params: unknown,
    route: { result?: (r: unknown, q: Qualifier) => unknown; sharesAccount?: boolean },
    ctx?: RpcContext,
  ): Promise<unknown> {
    if (!isObj(params) || params.machine === undefined || params.machine === null) return this.opts.local(method, params, ctx)
    const m = this.machineById(params.machine)
    if (!m) throw rpcError(`No linked machine ${String(params.machine)}`)
    const { machine: _machine, ...rest } = params
    if (route.sharesAccount && m.reachable) {
      const shared = await this.sameAccountAnswer(m, method, rest, ctx)
      if (shared) return route.result ? route.result(shared, m.q) : shared
    }
    const r = await this.forward(m, method, rest)
    return route.result ? route.result(r, m.q) : r
  }

  /**
   * A tool logged in to the same account on the hub and on `m` has one set of limits, so the hub's reading answers for
   * both (#726). The remote may have no session to read them from, and reading them there would only repeat what the
   * hub already shows. Each host fingerprints its own login and only the fingerprints meet here; `undefined` when the
   * accounts are not known to be the same, or the hub's own reading failed, and the remote is then asked as usual.
   * The prompt cache figures stay the remote's: they count its requests, not the hub's.
   */
  private async sameAccountAnswer(m: RoutedMachine, method: string, params: Obj, ctx?: RpcContext): Promise<Obj | undefined> {
    const tool = params.tool
    if (typeof tool !== 'string' || params.limits === false) return undefined
    try {
      const [mine, theirs] = await Promise.all([this.opts.local('agents.account', { tool }), m.call('agents.account', { tool })])
      const a = isObj(mine) ? mine.fingerprint : null
      const b = isObj(theirs) ? theirs.fingerprint : null
      if (typeof a !== 'string' || a === '' || a !== b) return undefined
      const own = await this.opts.local(method, { tool }, ctx)
      if (!isObj(own) || own.supported !== true || !own.usage) return undefined
      const there = await m.call(method, { tool, limits: false })
      const cache = isObj(there) ? there.cache : undefined
      return { supported: true, usage: own.usage, sameAccountAsHub: true, ...(cache ? { cache } : {}) }
    } catch {
      // A remote that predates `agents.account` (or `limits`), or a call that failed: it is asked as usual
      return undefined
    }
  }

  // ── Merges ──────────────────────────────────────────────────────────────────────────────

  /**
   * Asks every machine at once. A machine that cannot answer is left out, except for the two
   * lists the UI rebuilds itself from after a reconnect: sessions and projects come from the
   * mirror for it, marked `unreachable` and with `live` as last known, so the UI neither drops
   * them nor tries to wake them (§5, "Recovery").
   */
  private async merge(method: RpcMethodName, params: unknown): Promise<unknown> {
    const machines = [...this.opts.machines()]
    switch (method) {
      case 'sessions.list':
        return this.mergeLists(machines, 'sessions', params)
      case 'projects.list':
        return this.mergeLists(machines, 'projects', params)
      case 'projects.reorder':
        return this.reorderProjects(machines, params)
      case 'approvals.deleteRule':
        return this.deleteRule(machines, params)
      default:
        return this.mergeSimple(method, machines, params)
    }
  }

  private async mergeLists(machines: RoutedMachine[], kind: 'sessions' | 'projects', params: unknown): Promise<unknown> {
    const method = kind === 'sessions' ? 'sessions.list' : 'projects.list'
    const [local, ...remote] = await Promise.all([
      this.opts.local(method, params) as Promise<unknown[]>,
      ...machines.map((m) => this.listOf(m, kind)),
    ])
    const all = [...local, ...remote.flat()]
    return kind === 'projects' && machines.length > 0 ? this.inPersonsOrder(all) : all
  }

  /** One machine's list in the hub's terms: asked when it can be, else its mirror, marked `unreachable` */
  private async listOf(m: RoutedMachine, kind: 'sessions' | 'projects'): Promise<unknown[]> {
    if (m.reachable) {
      try {
        const list = (await m.call(kind === 'sessions' ? 'sessions.list' : 'projects.list', {})) as unknown[]
        if (Array.isArray(list)) {
          m.observe(kind, list)
          return this.present(m, kind, list, false)
        }
      } catch {
        // Fell through to the mirror below
      }
    }
    return this.present(m, kind, m.lastKnown(kind) ?? [], true)
  }

  /**
   * The projects in the order the person last gave across machines (#734). A project that order does not name yet
   * (one added since, or a newly linked machine's) goes at the end, in the order the machines gave it: nothing that
   * was out of sight jumps ahead of what the person placed.
   */
  private inPersonsOrder(list: unknown[]): unknown[] {
    const saved = this.opts.order?.read() ?? []
    if (saved.length === 0) return list
    const rank = new Map(saved.map((id, i) => [id, i]))
    const at = (p: unknown) => {
      const id = isObj(p) ? p.id : undefined
      return typeof id === 'string' ? (rank.get(id) ?? Infinity) : Infinity
    }
    return list
      .map((p, i) => ({ p, i, r: at(p) }))
      .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
      .map((x) => x.p)
  }

  private present(m: RoutedMachine, kind: 'sessions' | 'projects', list: unknown[], unreachable: boolean): unknown[] {
    const mark = (x: unknown) => (unreachable && isObj(x) ? { ...x, unreachable: true } : x)
    if (kind === 'projects') return list.map((p) => mark(m.q.project(p)))
    return list.filter((s) => !m.hides(s)).map((s) => mark(m.q.session(s)))
  }

  /**
   * The person's project order, split per machine: each machine keeps the order of its own. A
   * machine that cannot take it does not fail the rest, which has already been saved: its projects
   * come back from the mirror as they were, marked `unreachable`, the way `projects.list` gives them.
   *
   * The whole list is kept on the hub as well (#734), so one machine's projects can stand between another's: the
   * answer, and every `projects.list` after it, comes back in that order once a machine is linked. The answer holds
   * every machine's projects, a machine the request named none of too, since the window replaces its list with it.
   *
   * A window that did not know some project (one added, or a machine come back, since it last read the list) sends an
   * order without it. That project keeps its place after the one it followed in the kept order instead of dropping
   * out of it: a stale window cannot move what it never saw. The kept order forgets a project the hub no longer lists,
   * unless it is a linked machine's, which may only be out of reach.
   */
  private async reorderProjects(machines: RoutedMachine[], params: unknown): Promise<unknown> {
    // Checked before anything is kept or sent, as the hub's own handler would check it
    const { orderedIds } = RpcMethods['projects.reorder'].params.parse(params)
    const kept = this.opts.order?.read() ?? []
    const full = keepUnseen(orderedIds, kept)
    const perMachine = new Map<RoutedMachine, string[]>()
    const local: string[] = []
    for (const id of full) {
      const m = this.owner(id)
      if (!m) local.push(id)
      else perMachine.set(m, [...(perMachine.get(m) ?? []), m.q.strip(id, 'A project')])
    }
    const [mine, ...theirs] = await Promise.all([
      this.opts.local('projects.reorder', { ...(isObj(params) ? params : {}), orderedIds: local }) as Promise<unknown[]>,
      ...machines.map(async (m) => {
        const ordered = perMachine.get(m)
        // A machine the order names none of is not asked to reorder anything; its list still belongs in the answer
        if (!ordered) return this.listOf(m, 'projects')
        try {
          return m.q.projects(await this.forward(m, 'projects.reorder', { orderedIds: ordered })) as unknown[]
        } catch {
          return this.present(m, 'projects', m.lastKnown('projects') ?? [], true)
        }
      }),
    ])
    const all = [...mine, ...theirs.flat()]
    if (this.opts.order) {
      const listed = new Set(all.map((p) => (isObj(p) ? p.id : undefined)))
      this.opts.order.write(full.filter((id) => listed.has(id) || this.owner(id) !== null))
    }
    return machines.length > 0 ? this.inPersonsOrder(all) : all
  }

  private async deleteRule(machines: RoutedMachine[], params: unknown): Promise<unknown> {
    const id = isObj(params) ? params.id : undefined
    const folded = typeof id === 'number' ? decodeNumber(id) : null
    if (!folded) return this.opts.local('approvals.deleteRule', params)
    const m = machines.find((x) => x.q.slot === folded.slot)
    if (!m) throw rpcError('That rule belongs to a machine that is no longer linked')
    return this.forward(m, 'approvals.deleteRule', { id: folded.n })
  }

  /** The other merges: every reachable machine, each answer in the hub's terms, combined by kind */
  private async mergeSimple(method: RpcMethodName, machines: RoutedMachine[], params: unknown): Promise<unknown> {
    const local = await this.opts.local(method, params)
    const missed: RoutedMachine[] = machines.filter((m) => !m.reachable)
    const answers = await Promise.all(
      machines
        .filter((m) => m.reachable)
        .map(async (m) => {
          try {
            return { m, r: await m.call(method, params) }
          } catch {
            // One machine failing does not fail the list; it is simply not in it this time
            missed.push(m)
            return null
          }
        }),
    )
    let out = local
    for (const a of answers) {
      if (!a) continue
      const { m, r } = a
      out = combine(method, out, r, m.q)
    }
    /*
     * Emptying is an act, not a list (#841 item 4): a machine left out made "the trash is empty" true of the hub alone.
     * Each one not reached is a failure of its own, named, so the report says what stayed.
     */
    if (method === 'trash.empty' && missed.length && isObj(out)) {
      const failed = Array.isArray(out.failed) ? out.failed : []
      out = { ...out, failed: [...failed, ...missed.map((m) => ({ sessionId: m.id, name: m.name, error: 'this machine could not be reached, so its trash was not emptied' }))] }
    }
    // The trash's list says whose trash is not in it: read as the whole trash, it hid what a machine still holds
    if (method === 'trash.list' && missed.length && isObj(out)) out = { ...out, unreached: missed.map((m) => ({ machineId: m.id, name: m.name })) }
    return out
  }
}

/** One remote answer folded into the merged one, for the merges `mergeSimple` handles */
function combine(method: RpcMethodName, acc: unknown, r: unknown, q: Qualifier): unknown {
  const list = (x: unknown) => (Array.isArray(x) ? x : [])
  switch (method) {
    case 'messages.search':
      return [...list(acc), ...list(q.hits(r))]
    case 'apps.list':
      return [...list(acc), ...list(r).map((a) => q.app(a))]
    case 'projectConsents.list':
      return [...list(acc), ...list(r).map((c) => q.consent(c))]
    case 'approvals.rules':
      return [...list(acc), ...list(r).map((x) => q.rule(x, (n) => encodeNumber(q.slot, n)))]
    case 'trash.list': {
      const a = isObj(acc) ? acc : { sessions: [], bytes: 0 }
      const b = isObj(r) ? r : { sessions: [], bytes: 0 }
      // A machine's app-agent run records (#378) are listed with its sessions, named by machine for reading and deleting there
      const runs = [...list(a.runs), ...list(b.runs).map((t) => q.trashedRun(t))]
      return {
        ...a,
        sessions: [...list(a.sessions), ...list(b.sessions).map((t) => q.trashed(t))],
        ...(runs.length ? { runs } : {}),
        bytes: (typeof a.bytes === 'number' ? a.bytes : 0) + (typeof b.bytes === 'number' ? b.bytes : 0),
      }
    }
    case 'trash.empty': {
      const a = isObj(acc) ? acc : { purged: 0, failed: [] }
      const b = isObj(r) ? r : { purged: 0, failed: [] }
      return {
        ...a,
        purged: (typeof a.purged === 'number' ? a.purged : 0) + (typeof b.purged === 'number' ? b.purged : 0),
        failed: [...list(a.failed), ...list(b.failed).map((f) => (isObj(f) ? { ...f, sessionId: q.maybeId(f.sessionId) } : f))],
      }
    }
    default:
      return acc
  }
}

/**
 * `ordered`, with each id of `kept` it lacks put back after the id it followed in `kept` (at the front when nothing
 * before it is in the list), so what a window did not know about keeps its place among what it did (#734)
 */
export function keepUnseen(ordered: readonly string[], kept: readonly string[]): string[] {
  const out = [...ordered]
  const present = new Set(out)
  let previous: string | null = null
  for (const id of kept) {
    if (!present.has(id)) {
      out.splice(previous === null ? 0 : out.indexOf(previous) + 1, 0, id)
      present.add(id)
    }
    previous = id
  }
  return out
}
