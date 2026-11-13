import { randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { errorMessage, LinkedAppCallResult, LinkedAppsResult, oneLineText, type ExternalAppInfo, type LinkedApp } from '@cc/protocol'
import { NOT_REACHABLE } from '../adapters/contract.js'
import type { AppCallOutcome, AppRef } from '../apps/external/runtime.js'
import { LOOKUP_MS, awayRefusal } from './machine-reach.js'
import { qualify, splitQualified } from './machine-ids.js'

/**
 * The calling session's side of a project's app on another machine (#1938, docs/plans/remote-hub.md §13.3): what the
 * app's host last listed for a session here, and the one call across the link. The session's apps, its approval and its
 * card stay in `Attachment` (session-apps.ts), which calls here only in place of the local runtime, so a local and a
 * remote call are one path.
 *
 *   - **Names.** An app there is known here by its project qualified with that host's id (`<host>.<project>`, as the hub
 *     names a machine's projects and a machine a hub's, links/machine-ids.ts), so a ref says by itself where it runs. A
 *     local project id never holds a dot.
 *   - **The last list only names.** It is kept per linked host and session, fetched again when the session lists or finds
 *     apps; an entry grants nothing, as the app's host decides again at every call (`LinkedAppCalls`).
 *   - **A call outlives the link's wait.** It is asked in waits of its own (`CHUNK_MS`), the same call id each time, so
 *     the link's timeout never cuts a long call, asking again within it is never a second run, and the run id is known
 *     early. A link lost during a call ends it as maybe done; it is never sent again by itself.
 *   - **Never a local copy.** A host that cannot be reached answers that it cannot, naming it, and nothing ran. What the
 *     hub that started a session gave it is remembered with the session (`remember`), so after a restart, before that hub
 *     is back, its apps keep their names and answer that the hub is away, and the checkout's copy stays withheld (§13.5).
 */

/** A linked host whose apps a session here may use */
export type AppsPeer = {
  id: string
  name: string
  reachable: boolean
  /** It said it answers app calls on this connection (`apps` on the offer or its answer); false: a Centralu from before it */
  answers: boolean
  /** Its apps are the session's own, with no attach step: a hub's, for a session it started here (§13.5) */
  gives: boolean
  /** `apps`, `appCall`, `appCancel` or `appNotice` on the link: `host.*` from a hub, `hub.*` from a machine */
  call(method: 'apps' | 'appCall' | 'appCancel' | 'appNotice', params: unknown, timeoutMs: number): Promise<unknown>
}

export type LinkedAppsDeps = {
  /** How long a list may take before that host counts as away for it (`LOOKUP_MS`). For tests */
  lookupMs?: number
  /** How long one wait of a call lasts (`CHUNK_MS`). For tests */
  chunkMs?: number
  /** What a hub that started a session here last gave it, kept with the session (`hubAppsMemory`, links/apps-across.ts) */
  remember?: {
    read(sessionId: string): HubGave | null
    write(sessionId: string, gave: HubGave): void
  }
}

/** The apps a hub gave a session it started here, as remembered: the hub, and the apps without their tools */
export type HubGave = { hub: { id: string; name: string }; apps: LinkedApp[] }

/** A tool as the runtime lists one (MCP `Tool`): what `Attachment` reads of a remote app's list too */
export type LinkedTool = LinkedApp['tools'] extends (infer T)[] | null ? T : never

/** How long a session's last list is used before a listing asks again */
export const LINKED_FRESH_MS = 30_000
/** One wait of a call on the app's host; the first is short, so the run id is known before an early return needs it */
const FIRST_MS = 5_000
const CHUNK_MS = 60_000
/** What the link's timeout adds to a wait: the app's host answers by the wait, so only a lost link outlasts it */
const SLACK_MS = 30_000
/**
 * How long a list that starts an app there is waited for: past the answering host's own bound on starting it (15 s,
 * sessions/session-apps.ts `TOOL_LIST_WAIT_MS`, not imported: session-apps.ts imports this module), with `SLACK_MS`
 */
const START_LIST_MS = 15_000 + SLACK_MS

const older = (err: unknown) => /Unknown method/i.test(errorMessage(err))
const LOST_KEPT = 500

export class LinkedApps {
  /** `<host id>\0<session id>` → what that host last listed for the session */
  private lists = new Map<string, { apps: LinkedApp[]; at: number }>()
  /** A linked host's project by its qualified id → `<host>/<project>`, as last listed to any session: how an app there is named */
  private labels = new Map<string, string>()
  /** Runs whose call lost its link: `run_status` asks the app's host about them. The oldest go past `LOST_KEPT` */
  private lost = new Set<string>()

  /** The linked hosts a session here may use apps of (`appsPeers`): none until the links are wired (`usePeers`) */
  private peers: (sessionId: string) => AppsPeer[] = () => []

  constructor(private readonly deps: LinkedAppsDeps = {}) {}

  /** The hosts this one links and is linked by, once they exist: main.ts makes this before them */
  usePeers(peers: (sessionId: string) => AppsPeer[]): void {
    this.peers = peers
  }

  /** Whether a ref names an app of a linked host: its project is qualified */
  static owns(ref: Pick<AppRef, 'projectId'>): boolean {
    return ref.projectId !== null && splitQualified(ref.projectId) !== null
  }

  /** The apps the session's linked hosts last listed for it, as the session's apps read them */
  infos(sessionId: string): ExternalAppInfo[] {
    return this.peersOf(sessionId).flatMap((peer) => this.listed(peer, sessionId).map((a) => info(peer, a)))
  }

  /** A session was deleted: what its hosts listed for it goes */
  forget(sessionId: string): void {
    for (const k of this.lists.keys()) if (k.endsWith(`\0${sessionId}`)) this.lists.delete(k)
  }

  /**
   * The session's linked hosts, and the hub that started it as remembered when that hub has not offered since this host
   * started (or withdrew): away, so its apps keep their names and answer that it is away, never the checkout's copy
   */
  private peersOf(sessionId: string): AppsPeer[] {
    const peers = this.peers(sessionId)
    const gave = this.deps.remember?.read(sessionId)
    if (!gave || peers.some((p) => p.id === gave.hub.id)) return peers
    const away: AppsPeer = { id: gave.hub.id, name: gave.hub.name, reachable: false, answers: true, gives: true, call: () => Promise.reject(new Error(`${gave.hub.name} is ${NOT_REACHABLE}`)) }
    return [...peers, away]
  }

  /** What a host last listed for the session; for the hub that started it, what it gave, remembered across restarts */
  private listed(peer: AppsPeer, sessionId: string): LinkedApp[] {
    const kept = this.lists.get(key(peer.id, sessionId))
    if (kept) return kept.apps
    if (!peer.gives) return []
    const gave = this.deps.remember?.read(sessionId)
    return gave && gave.hub.id === peer.id ? gave.apps : []
  }

  /**
   * The projects of the session's linked hosts that have an app it may reach, as `ask_project` names projects
   * (`matchProjects`): the qualified id, the name there, and the host
   */
  projects(sessionId: string): { id: string; name: string; machine: string; machineId: string }[] {
    const seen = new Map<string, { id: string; name: string; machine: string; machineId: string }>()
    for (const peer of this.peersOf(sessionId)) {
      for (const a of this.listed(peer, sessionId)) {
        const id = qualify(peer.id, a.projectId)
        if (!seen.has(id)) seen.set(id, { id, name: oneLineText(a.project, 120) || a.projectId, machine: peer.name, machineId: peer.id })
      }
    }
    return [...seen.values()]
  }

  /** How an app's project there is named to an agent: `<host>/<project>`, which `attach_app` reads back; undefined if never listed */
  label(qualifiedProjectId: string): string | undefined {
    return this.labels.get(qualifiedProjectId)
  }

  /** Whether the app is the session's own (a started agent's parent project's, §13.5): given, never attached */
  gives(sessionId: string, ref: AppRef): boolean {
    const hit = this.where(sessionId, ref)
    return !!hit && hit.peer.gives
  }

  knownTools(sessionId: string, ref: AppRef): LinkedTool[] | null {
    return this.where(sessionId, ref)?.app.tools ?? null
  }

  /** An app's tools there, asked again when the list is old; one that never listed them is started there to list them */
  async tools(sessionId: string, ref: AppRef): Promise<LinkedTool[]> {
    await this.refresh(sessionId, this.knownTools(sessionId, ref) ? LINKED_FRESH_MS : 0, ref)
    return this.knownTools(sessionId, ref) ?? []
  }

  /**
   * Asks each linked host of the session for its list, in parallel and each bounded, unless one younger than `maxAgeMs`
   * is kept. A host that is away or older keeps the list it gave last, and is named under `away`; one that did not answer
   * is not asked again within `maxAgeMs` either. `start`: only that app's host is asked, and starts it to list its tools.
   * `host`: only that host is asked
   */
  async refresh(sessionId: string, maxAgeMs = 0, start?: AppRef, host?: string): Promise<{ away: { name: string; why: string }[] }> {
    const away: { name: string; why: string }[] = []
    const there = start?.projectId ? splitQualified(start.projectId) : null
    const only = there?.machine ?? host
    const peers = this.peersOf(sessionId).filter((p) => !only || p.id === only)
    await Promise.all(
      peers.map(async (peer) => {
        const k = key(peer.id, sessionId)
        const kept = this.lists.get(k)
        if (kept && Date.now() - kept.at < maxAgeMs) return
        if (!peer.reachable) return void away.push({ name: peer.name, why: NOT_REACHABLE })
        if (!peer.answers) return void away.push({ name: peer.name, why: `it runs a Centralu from before this; update it there to use its apps from here` })
        try {
          const params = { session: sessionId, ...(there && start ? { start: { projectId: there.id, appId: start.appId } } : {}) }
          const r = LinkedAppsResult.safeParse(await peer.call('apps', params, there ? START_LIST_MS : (this.deps.lookupMs ?? LOOKUP_MS)))
          if (r.success) {
            this.lists.set(k, { apps: r.data.apps, at: Date.now() })
            for (const a of r.data.apps) this.labels.set(qualify(peer.id, a.projectId), `${peer.name}/${oneLineText(a.project, 120) || a.projectId}`)
            if (peer.gives) this.deps.remember?.write(sessionId, { hub: { id: peer.id, name: peer.name }, apps: r.data.apps.map((a) => ({ ...a, tools: null })) })
            return
          }
          away.push({ name: peer.name, why: 'its answer could not be read' })
        } catch (err) {
          away.push({ name: peer.name, why: older(err) ? 'it runs a Centralu from before this; update it there to use its apps from here' : NOT_REACHABLE })
        }
        // Not asked again within `maxAgeMs`, so a host that hangs does not hold every call of the session; the list it gave last stays
        this.lists.set(k, { apps: this.listed(peer, sessionId), at: Date.now() })
      }),
    )
    return { away }
  }

  /**
   * One call of the session's on an app there, through `appCall` until it ends. `signal` withdraws it there (`appCancel`).
   * A link lost on the way ends it here as maybe done, with its run id, and `run_status` asks the app's host again
   */
  async call(sessionId: string, ref: AppRef, tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; onRun?: (runId: string) => void; notListed?: true } = {}): Promise<AppCallOutcome> {
    const hit = this.where(sessionId, ref)
    if (!hit) return failed('', 'That app is not offered to this session from its computer now. Nothing ran.')
    const { peer, app } = hit
    const what = `${app.name} on ${peer.name}`
    if (!peer.reachable) return failed('', awayRefusal(peer.name, NOT_REACHABLE, `${what} was not called; nothing ran`))
    if (!peer.answers) return failed('', `Update Centralu on ${peer.name} to use its apps from here. Nothing ran.`)
    const call = randomUUID()
    let runId = ''
    const cancel = () => void peer.call('appCancel', { call }, this.deps.lookupMs ?? LOOKUP_MS).catch(() => {})
    opts.signal?.addEventListener('abort', cancel, { once: true })
    try {
      for (let wait = Math.min(FIRST_MS, this.deps.chunkMs ?? CHUNK_MS); ; wait = this.deps.chunkMs ?? CHUNK_MS) {
        if (opts.signal?.aborted) return { runId, status: 'cancelled', result: null, error: 'The call was cancelled', durationMs: 0 }
        const params = { call, session: sessionId, projectId: app.projectId, appId: ref.appId, tool, args, waitMs: wait, ...(opts.notListed ? { notListed: true as const } : {}) }
        let raw: unknown
        try {
          raw = await peer.call('appCall', params, wait + SLACK_MS)
        } catch (err) {
          if (opts.signal?.aborted) return { runId, status: 'cancelled', result: null, error: 'The call was cancelled', durationMs: 0 }
          if (older(err)) return failed(runId, `Update Centralu on ${peer.name} to use its apps from here. Nothing ran.`)
          // Sent, and no answer: it may have run there. Never sent again by itself
          if (runId) this.keepLost(runId)
          const again = runId
            ? ` Its run id there is ${runId}: run_status asks about it once the link is back.`
            : ' Its run id there is not known; check what it does before calling it again.'
          return failed(runId, `${peer.name}: ${oneLineText(errorMessage(err), 500)}. ${what} may or may not have done this.${again}`)
        }
        const r = LinkedAppCallResult.safeParse(raw)
        if (!r.success) return failed(runId, `${peer.name} answered in a form this computer does not read; it may or may not have done this.`)
        if (r.data.runId && !runId) {
          runId = r.data.runId
          opts.onRun?.(runId)
        }
        if (r.data.status !== 'running') return outcome(r.data, peer.name)
      }
    } finally {
      opts.signal?.removeEventListener('abort', cancel)
    }
  }

  /** Whether this side has the run's outcome, or never had a call of it lose its link; false: `run_status` asks the app's host */
  knows(runId: string): boolean {
    return !this.lost.has(runId)
  }

  private keepLost(runId: string): void {
    this.lost.add(runId)
    for (const id of this.lost) if (this.lost.size > LOST_KEPT) this.lost.delete(id)
  }

  /** The app's host's answer on one of this session's runs there */
  async runStatus(sessionId: string, ref: AppRef, runId: string): Promise<AppCallOutcome | 'running'> {
    const hit = this.where(sessionId, ref)
    if (!hit) return failed(runId, 'That app is not offered to this session from its computer now.')
    if (!hit.peer.reachable) return failed(runId, awayRefusal(hit.peer.name, NOT_REACHABLE, `run ${runId} cannot be looked up`))
    try {
      const raw = await hit.peer.call('appCall', { call: randomUUID(), session: sessionId, projectId: hit.app.projectId, appId: ref.appId, tool: 'run_status', args: { run_id: runId }, waitMs: 1_000 }, this.deps.lookupMs ?? LOOKUP_MS)
      const r = LinkedAppCallResult.safeParse(raw)
      if (!r.success) return failed(runId, `${hit.peer.name} answered in a form this computer does not read.`)
      if (r.data.status === 'running') return 'running'
      this.lost.delete(runId)
      return outcome(r.data, hit.peer.name)
    } catch (err) {
      return failed(runId, `${hit.peer.name}: ${oneLineText(errorMessage(err), 500)}`)
    }
  }

  /** The host and its listed app a ref names, for this session */
  private where(sessionId: string, ref: AppRef): { peer: AppsPeer; app: LinkedApp } | null {
    const split = ref.projectId === null ? null : splitQualified(ref.projectId)
    if (!split) return null
    const peer = this.peersOf(sessionId).find((p) => p.id === split.machine)
    const app = peer && this.listed(peer, sessionId).find((a) => a.projectId === split.id && a.appId === ref.appId)
    return peer && app ? { peer, app } : null
  }
}

const key = (peer: string, sessionId: string) => `${peer}\0${sessionId}`

/** An app there as a session's apps read one: its project qualified by its host, the host named, its words cut to size */
function info(peer: AppsPeer, a: LinkedApp): ExternalAppInfo {
  return {
    appId: a.appId,
    projectId: qualify(peer.id, a.projectId),
    dir: '',
    name: oneLineText(a.name, 120) || a.appId,
    version: null,
    description: a.description,
    home: null,
    trusted: true,
    status: 'stopped',
    error: peer.reachable ? null : `${peer.name} is ${NOT_REACHABLE}`,
    warnings: [],
    machine: peer.id,
    // Listed by its host as one this session may reach: shared with it, or its project's root app
    shared: true,
    ...(a.root ? { root: true } : {}),
  }
}

/** The app's answer as the runtime gives one: a content block this computer does not read makes it a failed call, never passed on */
function outcome(r: LinkedAppCallResult, host: string): AppCallOutcome {
  const status = r.status === 'running' ? 'error' : r.status
  if (!r.result) return { runId: r.runId, status, result: null, error: r.error, durationMs: r.durationMs }
  const content = r.result.content
  if (!content.every(isContent)) return failed(r.runId, `${host} answered with content this computer does not read; it may or may not have done this.`)
  const result: CallToolResult = { content, ...(r.result.structuredContent ? { structuredContent: r.result.structuredContent } : {}), ...(r.result.isError !== undefined ? { isError: r.result.isError } : {}) }
  return { runId: r.runId, status, result, error: r.error, durationMs: r.durationMs }
}

type Content = CallToolResult['content'][number]

/** An MCP content block as the agent's CLI reads one: its kind and the fields that kind needs */
function isContent(c: { type: string } & Record<string, unknown>): c is { type: string } & Content {
  const str = (k: string) => typeof c[k] === 'string'
  switch (c.type) {
    case 'text':
      return str('text')
    case 'image':
    case 'audio':
      return str('data') && str('mimeType')
    case 'resource_link':
      return str('uri') && str('name')
    case 'resource':
      return typeof c.resource === 'object' && c.resource !== null && typeof Reflect.get(c.resource, 'uri') === 'string'
    default:
      return false
  }
}

function failed(runId: string, error: string): AppCallOutcome {
  return { runId, status: 'error', result: null, error, durationMs: 0 }
}
