import { BackgroundTask, HostReadSessionResult, HostRecallHit, HostSessionRow, SessionId, ToolName } from '@cc/protocol'
import type { SessionInfo } from '@cc/protocol'
import { NOT_REACHABLE, type LinkedProject, type LinkedSessions, type OrchestratedSession, type RecallHit } from '../adapters/contract.js'
import { trustedJsonText } from '../sessions/orchestrator-tools.js'
import { splitQualified } from './machine-ids.js'
import type { RoutedMachine, RpcHandler } from './router.js'
import { isObj } from './obj.js'

/** Without a router (the reading tests), nothing that acts is reachable */
const notRouted: RpcHandler = async (method) => {
  throw Object.assign(new Error(`${method} cannot reach a linked machine here`), { code: 'internal' })
}

/**
 * The linked machines' sessions as the hub's orchestrator reads them (#82 phase 4, docs/plans/remote-hub.md §12).
 *
 * Each machine answers for its own sessions with the orchestrator's own code (`host.sessions`, `host.readSession`,
 * `host.recall`, the manager's `hostReader`), so a row, a conversation and a hit read the same from any machine. This
 * side asks every machine at once, qualifies what comes back, and names the machine on it.
 *
 * **What a machine says is fenced here, not trusted.** The orchestrator acts on this host, and a machine is the side
 * the plan treats as less trusted (§3.2): a name with a newline in it would otherwise read as one more list line of
 * ours, and an id that is not id-shaped would go back into a tool call the model makes. So names and states come as one
 * line, ids must be ids, and a conversation line that is not already one line is quoted as one. Previews and snippets
 * are JSON-quoted by the renderer, as a worker's text already is (#121).
 */

/** Long enough for any name a person or the auto-namer gives (60 characters plus a suffix), short enough to stay a label */
const LABEL_MAX = 200

/** What breaks a line, or is not text: the control characters, and the two separators a reader may take for a break */
// eslint-disable-next-line no-control-regex
const NOT_ONE_LINE = /[\u0000-\u001f\u007f\u2028\u2029]+/g

/** One line of a machine's text: no line breaks or control characters, cut to a label's length */
function oneLine(value: unknown, max = LABEL_MAX): string {
  const text = String(value ?? '').replace(NOT_ONE_LINE, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A machine's line of a conversation: kept when it is one line, as the machine's code makes it; quoted as one otherwise */
function fencedLine(line: string): string {
  return line.replace(NOT_ONE_LINE, '') === line ? line : trustedJsonText(line)
}

/**
 * How long a name is resolved against a machine's project list before that machine is counted as not answering. A
 * name is looked up on every ask_project call, so one slow or half-open link must not hold up the asks that name a
 * project on this computer or on another machine; the link's own call timeout is much longer
 */
const LOOKUP_MS = 4000

/** What to tell the model when a machine could not answer: its own words for a refusal, a plain cause otherwise */
function cause(m: RoutedMachine, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // A machine on a Centralu from before phase 4 (connected anyway, on one protocol)
  if (message.startsWith('Unknown method: host.')) return `${m.name} runs a Centralu too old for the orchestrator to reach; update it there`
  return oneLine(message, 300)
}

/**
 * `route` is the hub's router (`router.ts`): a call in the hub's terms, sent to the machine its ids name and answered
 * qualified. The reads and `host.send` go to each machine directly; acting on a session or a project goes through the
 * router, so it is the same call, with the same rewriting, that the hub's window makes.
 */
export function linkedSessions(
  machines: () => Iterable<RoutedMachine>,
  route: RpcHandler = notRouted,
  /** This computer, as a machine names who sent an instruction (`host.send`): the orchestrator is not that machine's own */
  hubName?: string,
  /** How long resolving a project name waits for one machine's project list (`lookupMs`); tests shorten it */
  options: { lookupMs?: number } = {},
): LinkedSessions {
  const lookupMs = options.lookupMs ?? LOOKUP_MS
  const owner = (sessionId: string): RoutedMachine | null => {
    const split = splitQualified(sessionId)
    if (!split) return null
    for (const m of machines()) if (m.id === split.machine) return m
    return null
  }
  const machineById = (id: string): RoutedMachine | null => {
    for (const m of machines()) if (m.id === id) return m
    return null
  }
  /** The router's call, its refusal as the sentence the model reads */
  const attempt = async <T>(m: RoutedMachine, run: () => Promise<T>): Promise<({ ok: true } & T) | { ok: false; error: string }> => {
    if (!m.reachable) return { ok: false, error: `${m.name} is ${NOT_REACHABLE}; try again once its link is back` }
    try {
      return { ok: true, ...(await run()) }
    } catch (err) {
      return { ok: false, error: cause(m, err) }
    }
  }
  /** A project row a machine answered, in the hub's terms; null when it is not a project row */
  const projectOf = (m: RoutedMachine, raw: unknown): LinkedProject | null => {
    const p = m.q.project(raw)
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.path !== 'string' || !SessionId.safeParse(p.id).success) return null
    const tool = ToolName.nullable().safeParse(p.defaultTool ?? null)
    if (!tool.success) return null
    return {
      id: p.id,
      name: oneLine(p.name),
      path: oneLine(p.path, 4096),
      defaultTool: tool.data,
      machine: m.name,
      machineId: m.id,
      ...(typeof p.trusted === 'boolean' ? { trusted: p.trusted } : {}),
    }
  }

  /** The machine's rows as it answered them, in the hub's terms. A row that does not parse, or whose id is not an id, is left out */
  const rows = (m: RoutedMachine, answer: unknown): OrchestratedSession[] => {
    if (!Array.isArray(answer)) return []
    const out: OrchestratedSession[] = []
    for (const raw of answer) {
      const r = HostSessionRow.safeParse(raw)
      if (!r.success || !SessionId.safeParse(r.data.sessionId).success) continue
      const s = r.data
      out.push({
        sessionId: m.q.id(s.sessionId),
        name: oneLine(s.name),
        project: oneLine(s.project),
        state: oneLine(s.state, 40),
        tool: oneLine(s.tool, 40),
        ...(s.merged ? { merged: true } : {}),
        ...(s.pr ? { pr: { number: s.pr.number, state: oneLine(s.pr.state, 20) } } : {}),
        preview: s.preview,
        ...(s.lastActive ? { lastActive: oneLine(s.lastActive, 40) } : {}),
        machine: m.name,
      })
    }
    return out
  }

  /**
   * What the hub last knew of a machine it cannot ask: the headers mirror, the same rows its window keeps (§5). No
   * preview: the mirror holds headers only
   */
  const lastKnown = (m: RoutedMachine, away: string): OrchestratedSession[] => {
    const projects = new Map<string, string>()
    for (const p of m.lastKnown('projects') ?? []) if (isObj(p) && typeof p.id === 'string') projects.set(p.id, oneLine(p.name))
    const out: OrchestratedSession[] = []
    for (const s of m.lastKnown('sessions') ?? []) {
      if (!isObj(s) || m.hides(s) || typeof s.id !== 'string' || !SessionId.safeParse(s.id).success) continue
      out.push({
        sessionId: m.q.id(s.id),
        name: oneLine(s.name),
        project: typeof s.projectId === 'string' ? (projects.get(s.projectId) ?? '(project no longer exists)') : '(none)',
        state: oneLine(s.state, 40),
        tool: oneLine(s.tool, 40),
        preview: '',
        machine: m.name,
        away,
      })
    }
    return out
  }

  return {
    async send(sessionId, text, fromName) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => {
        await m.call('host.send', { sessionId: m.q.strip(sessionId, 'The session'), text, from: { name: hubName ? `${fromName} on ${hubName}` : fromName } })
        return {}
      })
    },

    async updateSettings(sessionId, s) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => ({ info: (await route('agents.updateSettings', { sessionId, ...s, by: 'orchestrator' })) as SessionInfo & { applied?: string } }))
    },

    async findProjects(ref) {
      const wanted = ref.trim()
      const found = await Promise.all(
        [...machines()].map(async (m) => {
          if (!m.reachable) return []
          try {
            const list = await m.call('projects.list', {})
            return (Array.isArray(list) ? list : [])
              .map((raw) => projectOf(m, raw))
              .filter((p): p is LinkedProject => p !== null && (p.id === wanted || p.name === wanted))
          } catch {
            return []
          }
        }),
      )
      return found.flat()
    },

    async projects() {
      const away: { machine: string; machineId: string; why: string }[] = []
      const perMachine = await Promise.all(
        [...machines()].map(async (m): Promise<LinkedProject[]> => {
          /** What the headers mirror last held of the machine's projects, each marked with why it could not be asked */
          const mirrored = (why: string): LinkedProject[] => {
            away.push({ machine: m.name, machineId: m.id, why })
            return (m.lastKnown('projects') ?? []).map((raw) => projectOf(m, raw)).filter((p): p is LinkedProject => p !== null).map((p) => ({ ...p, away: why }))
          }
          if (!m.reachable) return mirrored(NOT_REACHABLE)
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const slow = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`did not answer within ${lookupMs % 1000 === 0 ? `${lookupMs / 1000} s` : `${lookupMs} ms`}`)), lookupMs)
            })
            const list = await Promise.race([m.call('projects.list', {}), slow])
            return (Array.isArray(list) ? list : []).map((raw) => projectOf(m, raw)).filter((p): p is LinkedProject => p !== null)
          } catch (err) {
            return mirrored(cause(m, err))
          } finally {
            clearTimeout(timer)
          }
        }),
      )
      return { projects: perMachine.flat(), away }
    },

    async projectSessions(project) {
      const m = owner(project.id)
      if (!m) return { ok: false, error: `Not a project of a linked machine: ${project.id}` }
      const projectId = m.q.strip(project.id, 'The project')
      return attempt(m, async () => {
        const list = await m.call('sessions.list', {})
        const sessions: { id: string; name: string; state: string }[] = []
        for (const raw of Array.isArray(list) ? list : []) {
          // Ordinary sessions only, as on this computer: not an app's or a builder's, not the machine's orchestrator or a lead
          if (!isObj(raw) || m.hides(raw) || raw.projectId !== projectId || raw.kind !== 'worker' || raw.appId) continue
          if (typeof raw.id !== 'string' || !SessionId.safeParse(raw.id).success) continue
          sessions.push({ id: m.q.id(raw.id), name: oneLine(raw.name), state: oneLine(raw.state, 40) })
        }
        return { sessions }
      })
    },

    async createSession(project, opts) {
      const m = owner(project.id)
      if (!m) return { ok: false, error: `Not a project of a linked machine: ${project.id}` }
      const tool = opts.tool ?? project.defaultTool
      if (!tool) return { ok: false, error: `No agent tool is available on ${m.name}. Install and configure an agent CLI before creating a session.` }
      return attempt(m, async () => {
        const info = (await route('agents.createSession', {
          projectId: project.id,
          cwd: project.path,
          tool,
          permissionPreset: 'normal',
        })) as { id: string; name: string }
        if (opts.name) await route('sessions.rename', { sessionId: info.id, name: opts.name })
        return { sessionId: info.id, name: opts.name ?? info.name }
      })
    },

    machineLinked(machineId) {
      return !!machineById(machineId)
    },

    async backgroundTasks(machineId) {
      const m = machineById(machineId)
      if (!m || !m.reachable) return null
      try {
        const list = await m.call('sessions.list', {})
        const out: { sessionId: string; tasks: BackgroundTask[] }[] = []
        for (const raw of Array.isArray(list) ? list : []) {
          if (!isObj(raw) || typeof raw.id !== 'string' || !SessionId.safeParse(raw.id).success) continue
          const tasks = (Array.isArray(raw.backgroundTasks) ? raw.backgroundTasks : []).flatMap((t) => {
            const parsed = BackgroundTask.safeParse(t)
            return parsed.success ? [parsed.data] : []
          })
          out.push({ sessionId: m.q.id(raw.id), tasks })
        }
        return out
      } catch {
        return null
      }
    },

    machineNamed(ref) {
      const wanted = ref.trim().toLowerCase()
      for (const m of machines()) if (m.id === wanted || m.name.toLowerCase() === wanted) return { id: m.id, name: m.name }
      return null
    },

    async previewProject(machineId, spec) {
      const m = machineById(machineId)
      if (!m) return { ok: false, error: `No linked machine ${machineId}` }
      const r = await attempt(m, async () => ({ preview: (await route('projects.createPreview', { ...spec, machine: m.id })) as { path: string | null; error: string | null } }))
      if (!r.ok) return r
      if (r.preview.error || !r.preview.path) return { ok: false, error: oneLine(r.preview.error ?? 'Give a name for the folder', 300) }
      const path = oneLine(r.preview.path, 4096)
      // A clone named by its repository: the folder the machine would make names it
      return { ok: true, name: spec.name.trim() || (path.split(/[\\/]/).pop() ?? path), path }
    },

    async createProject(machineId, spec) {
      const m = machineById(machineId)
      if (!m) return { ok: false, error: `No linked machine ${machineId}` }
      return attempt(m, async () => {
        const p = (await route('projects.create', { ...spec, machine: m.id })) as { id: string; name: string; path: string }
        return { projectId: p.id, name: oneLine(p.name), path: oneLine(p.path, 4096) }
      })
    },

    describe(sessionId) {
      const m = owner(sessionId)
      const split = splitQualified(sessionId)
      if (!m || !split) return null
      const s = (m.lastKnown('sessions') ?? []).find((x) => isObj(x) && x.id === split.id)
      if (!isObj(s)) return null
      const p = (m.lastKnown('projects') ?? []).find((x) => isObj(x) && x.id === s.projectId)
      return { name: oneLine(s.name), project: `${isObj(p) ? oneLine(p.name) : '(none)'} on ${m.name}` }
    },

    async lastWords(sessionId, maxChars) {
      const r = await this.read(sessionId, 8)
      for (const line of [...(r.lines ?? [])].reverse()) {
        try {
          const parsed = JSON.parse(line) as { role?: unknown; text?: unknown }
          if (parsed.role === 'assistant' && typeof parsed.text === 'string') return parsed.text.slice(-maxChars)
        } catch {
          // A line that is not the machine's JSON says nothing to report
        }
      }
      return ''
    },

    async list() {
      const perMachine = await Promise.all(
        [...machines()].map(async (m) => {
          if (!m.reachable) return lastKnown(m, 'not reachable right now')
          try {
            return rows(m, await m.call('host.sessions', {}))
          } catch (err) {
            return lastKnown(m, cause(m, err))
          }
        }),
      )
      return perMachine.flat()
    },

    machineOf(sessionId) {
      return owner(sessionId)?.name ?? null
    },

    async read(sessionId, limit, opts) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      if (!m.reachable) return { ok: false, error: `${m.name} is not reachable right now; read it again once its link is back` }
      try {
        const answer = await m.call('host.readSession', {
          sessionId: m.q.strip(sessionId, 'The session'),
          ...(limit !== undefined ? { limit } : {}),
          ...(opts?.around !== undefined ? { around: opts.around } : {}),
          ...(opts?.tools ? { tools: true } : {}),
        })
        const r = HostReadSessionResult.safeParse(answer)
        if (!r.success) return { ok: false, error: `${m.name} answered in a shape this Centralu does not read` }
        return { ok: true, state: oneLine(r.data.state, 40), lines: r.data.lines.map(fencedLine) }
      } catch (err) {
        return { ok: false, error: cause(m, err) }
      }
    },

    async recall(query, limit) {
      const notSearched: string[] = []
      const hits = await Promise.all(
        [...machines()].map(async (m): Promise<RecallHit[]> => {
          if (!m.reachable) {
            notSearched.push(`${m.name} (not reachable right now)`)
            return []
          }
          try {
            const answer = await m.call('host.recall', { query, limit })
            if (!Array.isArray(answer)) return []
            const out: RecallHit[] = []
            for (const raw of answer) {
              const h = HostRecallHit.safeParse(raw)
              if (!h.success || !SessionId.safeParse(h.data.sessionId).success || !Number.isSafeInteger(h.data.seq)) continue
              out.push({
                sessionId: m.q.id(h.data.sessionId),
                session: oneLine(h.data.session),
                project: oneLine(h.data.project),
                snippet: h.data.snippet,
                seq: h.data.seq,
                ...(h.data.at ? { at: oneLine(h.data.at, 40) } : {}),
                machine: m.name,
              })
            }
            return out.slice(0, limit)
          } catch (err) {
            notSearched.push(`${m.name} (${cause(m, err)})`)
            return []
          }
        }),
      )
      return { hits, notSearched }
    },
  }
}
