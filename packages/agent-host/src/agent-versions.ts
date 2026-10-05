import { runsOlderCli, type AgentVersions, type NormalizedEvent, type SessionInfo, type ToolName } from '@cc/protocol'
import type { SessionIdle } from './idle.js'

/**
 * Moving sessions to a newly installed agent CLI (#297).
 *
 * Every session runs its own agent process, started from the CLI installed at the time. An update
 * to `claude` or `codex` reaches a session only when its process starts again, and with the keeper
 * (#280) that can be never: the keeper holds the processes across app restarts. This service knows
 * both sides, the installed version (read here, periodically and when a window gains focus) and the
 * version each session runs (`SessionInfo.agentVersion`, from the process itself), and restarts a
 * session on the installed CLI:
 *
 *   - when the person asks, for every session that is idle right now (`applyNow`, the header's action);
 *   - by itself, with `autoApply` on (the default, the owner's decision of 2026-10-05), once a
 *     session has been fully idle for `quietMs`.
 *
 * The restart is the manager's "Restart agent" (`restartSession`): the process is disposed and the
 * session resumes in a new one, so the conversation continues. Under the keeper that disposal stops
 * the held child and the resume spawns a new one; nothing is re-attached.
 */

/** What this needs from the session manager */
export type VersionSessions = {
  listSessions(): SessionInfo[]
  sessionIdle(sessionId: string): SessionIdle
  restartSession(sessionId: string): Promise<{ resumed: boolean; reason?: string }>
  /** Writes one line into the conversation saying the session moved, so a restart is never silent */
  noteAgentMoved?(sessionId: string, from: string, to: string): void
}

/** A tool as this service reads it: its adapter's `installedVersion` */
export type VersionedTool = { tool: ToolName; installedVersion?: () => Promise<string | null> }

/** One installed CLI that changed version, for the capability check (#270) */
export type ToolVersionChange = { tool: ToolName; from: string; to: string }

export type AgentVersionDeps = {
  tools: () => VersionedTool[]
  sessions: VersionSessions
  publish: (status: AgentVersions) => void
  readAutoApply?: () => boolean
  writeAutoApply?: (enabled: boolean) => void
  /** The installed versions last seen, kept across host restarts so an update made while the app was closed counts as a change */
  readSeen?: () => Record<string, string>
  writeSeen?: (seen: Record<string, string>) => void
  /**
   * **The seam for #270's capability check.** Called once for every installed CLI whose version
   * changed (not for the first sighting). #270 proposes re-running the probes for what a tool could
   * not do ("`/goal` needs the interactive CLI") when its version moves; nothing implements that
   * yet, so the default writes one line to host.log saying so.
   */
  capabilityCheck?: (change: ToolVersionChange) => void
  now?: () => number
  quietMs?: number
}

/**
 * How often the installed versions are read while the host runs. Ten minutes: reading is a file
 * per tool (npm's `package.json`), and an update made in a terminal should not take an hour to
 * reach the header. The window gaining focus asks too, which is when someone who just updated
 * comes back.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000

/** A focus inside this window answers with the last reading: switching windows back and forth is not a reason to read again */
const FOCUS_FRESH_MS = 30 * 1000

/**
 * How long a session must have been quiet before it is moved by itself. A turn that just ended is
 * the moment the person reads the answer and starts typing the next message; a restart then would
 * land in the middle of it. A minute of nothing from the session (no event of any kind) says the
 * moment has passed. Asking by hand (`applyNow`) does not wait.
 */
const QUIET_MS = 60 * 1000

/**
 * The events after which a session may have become restartable, or changed the version it runs: the end of a turn or
 * of a wait, background work changing, a process coming or going. Only these schedule a look. Everything else (a
 * streaming chunk, a tool card) only moves the quiet period along: it arrives mid-turn, many times a second, and a look
 * already scheduled re-reads the quiet period when it fires.
 */
const MAY_SETTLE: ReadonlySet<NormalizedEvent['type']> = new Set([
  'agent_version',
  'state_change',
  'turn_complete',
  'background_tasks',
  'approval_resolved',
  'question_resolved',
  'limit_reached',
  'error',
  'session_created',
])

/** Why a session is or is not restarted now — a value, so the rule is tested as data */
export type RestartDecision =
  | { restart: true }
  | { restart: false; why: 'not_live' | 'current' | 'recent' | 'restarting' | Extract<SessionIdle, { idle: false }>['reason'] }

/**
 * Whether to restart one session on the installed CLI now.
 *
 * Only a live session whose process runs an older version than the installed one (unknown on
 * either side is not older: nothing is restarted on a guess), that is fully idle by the shared rule
 * (`sessionIdle`, idle.ts), and that has been quiet for `quietMs`.
 */
export function restartDecision(input: {
  session: Pick<SessionInfo, 'live' | 'agentVersion'>
  installed: string | null | undefined
  idle: SessionIdle
  quietFor: number
  quietMs: number
}): RestartDecision {
  if (!input.session.live) return { restart: false, why: 'not_live' }
  if (!runsOlderCli(input.session.agentVersion, input.installed)) return { restart: false, why: 'current' }
  if (!input.idle.idle) return { restart: false, why: input.idle.reason }
  if (input.quietFor < input.quietMs) return { restart: false, why: 'recent' }
  return { restart: true }
}

export class AgentVersionService {
  private status: AgentVersions
  private readonly deps: Required<AgentVersionDeps>
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<AgentVersions> | null = null
  /** When each session last said anything — the quiet period counts from here */
  private lastEvent = new Map<string, number>()
  /** One pending look per session, so a burst of events schedules one */
  private looks = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions being restarted by this service right now */
  private restarting = new Set<string>()
  /**
   * When this host started hearing. A session it has not heard from since counts as quiet from here, not from the
   * beginning of time: a host that just replaced another (a restart, a switched build) does not know what the person
   * was doing a second ago.
   */
  private readonly since: number

  constructor(deps: AgentVersionDeps) {
    this.deps = {
      readAutoApply: () => true,
      writeAutoApply: () => {},
      readSeen: () => ({}),
      writeSeen: () => {},
      capabilityCheck: ({ tool, from, to }) =>
        console.error(`[agent-versions] ${tool} ${from} -> ${to}; no capability check runs yet (#270)`),
      now: Date.now,
      quietMs: QUIET_MS,
      ...deps,
    }
    this.status = { installed: {}, autoApply: this.deps.readAutoApply(), checkedAt: null }
    this.since = this.deps.now()
  }

  current(): AgentVersions {
    return { ...this.status, installed: { ...this.status.installed } }
  }

  /** The version installed of one tool as last read, or null — what a process started now runs, until it says */
  installedNow(tool: ToolName): string | null {
    return this.status.installed[tool] ?? null
  }

  start(): void {
    void this.check(true)
    this.stop()
    this.timer = setInterval(() => void this.check(true), CHECK_INTERVAL_MS)
    // A version check is no reason to keep the host alive
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const t of this.looks.values()) clearTimeout(t)
    this.looks.clear()
  }

  /**
   * Reads the installed versions, or answers with the last reading when `force` is off and it is
   * fresh (a window gaining focus). Never throws: a tool that cannot be read reads as null.
   */
  async check(force: boolean): Promise<AgentVersions> {
    if (this.inFlight) return this.inFlight
    if (!force && this.status.checkedAt !== null && this.deps.now() - this.status.checkedAt < FOCUS_FRESH_MS) return this.current()
    this.inFlight = this.read()
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async read(): Promise<AgentVersions> {
    const tools = this.deps.tools().filter((t) => t.installedVersion)
    const read = await Promise.all(tools.map(async (t) => [t.tool, await t.installedVersion!().catch(() => null)] as const))
    const installed: Record<string, string | null> = Object.fromEntries(read)
    const seen = this.deps.readSeen()
    const nextSeen = { ...seen }
    for (const [tool, version] of read) {
      if (!version) continue
      const before = seen[tool]
      if (before && before !== version) {
        try {
          this.deps.capabilityCheck({ tool, from: before, to: version })
        } catch (err) {
          console.error(`[agent-versions] the capability check for ${tool} failed: ${(err as Error).message}`)
        }
      }
      nextSeen[tool] = version
    }
    if (JSON.stringify(nextSeen) !== JSON.stringify(seen)) this.deps.writeSeen(nextSeen)
    this.status = { ...this.status, installed, checkedAt: this.deps.now() }
    this.deps.publish(this.current())
    if (this.status.autoApply) for (const s of this.deps.sessions.listSessions()) this.lookSoon(s.id)
    return this.current()
  }

  setAutoApply(enabled: boolean): AgentVersions {
    if (this.status.autoApply !== enabled) {
      this.status = { ...this.status, autoApply: enabled }
      this.deps.writeAutoApply(enabled)
      this.deps.publish(this.current())
    }
    if (enabled) for (const s of this.deps.sessions.listSessions()) this.lookSoon(s.id)
    else for (const t of this.looks.values()) clearTimeout(t)
    if (!enabled) this.looks.clear()
    return this.current()
  }

  /**
   * Restarts every live session that runs an older CLI and is idle right now — the person asked, so
   * the quiet period does not apply. The rest are listed as busy.
   */
  async applyNow(): Promise<{ restarted: string[]; busy: string[] }> {
    const restarted: string[] = []
    const busy: string[] = []
    for (const s of this.deps.sessions.listSessions()) {
      const d = this.decide(s, 0)
      if (d.restart) {
        if (await this.restart(s)) restarted.push(s.id)
        else busy.push(s.id)
      } else if (d.why !== 'not_live' && d.why !== 'current') busy.push(s.id)
    }
    return { restarted, busy }
  }

  /**
   * Hears every session event. A session that just said something is not quiet; one that may have
   * become idle is looked at again once the quiet period has passed. A process reporting a version
   * newer than the last reading means the CLI was updated since: read again.
   */
  observe(e: NormalizedEvent): void {
    if (!e.sessionId) return
    this.lastEvent.set(e.sessionId, this.deps.now())
    if (e.type === 'session_deleted') {
      this.lastEvent.delete(e.sessionId)
      const t = this.looks.get(e.sessionId)
      if (t) clearTimeout(t)
      this.looks.delete(e.sessionId)
      return
    }
    if (e.type === 'agent_version') {
      const tool = this.deps.sessions.listSessions().find((s) => s.id === e.sessionId)?.tool
      if (tool && runsOlderCli(this.status.installed[tool], e.version)) void this.check(true)
    }
    if (this.status.autoApply && MAY_SETTLE.has(e.type)) this.lookSoon(e.sessionId)
  }

  private decide(s: SessionInfo, quietMs: number): RestartDecision {
    if (this.restarting.has(s.id)) return { restart: false, why: 'restarting' }
    let idle: SessionIdle
    try {
      idle = this.deps.sessions.sessionIdle(s.id)
    } catch {
      return { restart: false, why: 'not_live' }
    }
    return restartDecision({
      session: s,
      installed: this.status.installed[s.tool],
      idle,
      quietFor: this.deps.now() - (this.lastEvent.get(s.id) ?? this.since),
      quietMs,
    })
  }

  /** Looks at a session once it has been quiet long enough; a later event pushes the look back */
  private lookSoon(sessionId: string): void {
    const s = this.deps.sessions.listSessions().find((x) => x.id === sessionId)
    if (!s || !s.live || !runsOlderCli(s.agentVersion, this.status.installed[s.tool])) return
    const prev = this.looks.get(sessionId)
    if (prev) clearTimeout(prev)
    const wait = Math.max(0, this.deps.quietMs - (this.deps.now() - (this.lastEvent.get(sessionId) ?? this.since)))
    const t = setTimeout(() => {
      this.looks.delete(sessionId)
      void this.lookNow(sessionId)
    }, wait)
    t.unref?.()
    this.looks.set(sessionId, t)
  }

  private async lookNow(sessionId: string): Promise<void> {
    if (!this.status.autoApply) return
    const s = this.deps.sessions.listSessions().find((x) => x.id === sessionId)
    if (!s) return
    const d = this.decide(s, this.deps.quietMs)
    if (d.restart) await this.restart(s)
    // Still quiet but not yet past the period (an event landed between scheduling and now): look again then
    else if (d.why === 'recent') this.lookSoon(sessionId)
  }

  private async restart(s: SessionInfo): Promise<boolean> {
    const from = s.agentVersion
    const to = this.status.installed[s.tool]
    this.restarting.add(s.id)
    try {
      const r = await this.deps.sessions.restartSession(s.id)
      if (!r.resumed) {
        console.error(`[agent-versions] could not move ${s.id.slice(0, 8)} to ${s.tool} ${to}: ${r.reason ?? 'unknown'}`)
        return false
      }
      if (from && to) this.deps.sessions.noteAgentMoved?.(s.id, from, to)
      return true
    } catch (err) {
      console.error(`[agent-versions] could not move ${s.id.slice(0, 8)} to ${s.tool} ${to}: ${(err as Error).message}`)
      return false
    } finally {
      this.restarting.delete(s.id)
    }
  }
}
