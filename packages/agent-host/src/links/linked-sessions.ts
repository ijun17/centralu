import { AGENT_INSTRUCTIONS_MAX, BackgroundTask, HostLastAnswerResult, HostReadSessionResult, PermissionPreset, RpcMethods, HostRecallHit, HostSessionRow, oneLineText, SessionId, SessionInfo, ToolName } from '@cc/protocol'
import { awayPhrase, NOT_CONNECTED, NOT_REACHABLE, type LinkedProject, type LinkedSessions, type OrchestratedSession, type ProjectNeed, type RecallHit } from '../adapters/contract.js'
import { trustedJsonText } from '../sessions/orchestrator-tools.js'
import { budgetOf, fitMachineLines, toolLinesOf } from '../sessions/session-lines.js'
import { clipPreview } from '../sessions/turn-answer.js'
import { splitQualified } from './machine-ids.js'
import type { RoutedMachine, RpcHandler } from './router.js'
import { isObj } from '../json-value.js'
import { raceTimeout } from '../timing.js'
import { rpcError } from '../rpc-error.js'

/** Without a router (the reading tests), nothing that acts is reachable */
const notRouted: RpcHandler = async (method) => {
  throw rpcError(`${method} cannot reach a linked machine here`)
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

/** What breaks a line, or is not text, as `oneLineText` reads it: control and format characters, and the line separators */
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/** One line of a machine's text (`oneLineText`, #428), cut to a label's length */
function oneLine(value: unknown, max = LABEL_MAX): string {
  return oneLineText(value, max)
}

/** The longest path a machine's answer is read with */
const PATH_MAX = 4096

/**
 * A machine's path on one line, otherwise as the machine wrote it (#428): only what breaks a line goes (control
 * characters, U+2028, U+2029). A path is not a label: its runs of spaces and its joiners (a ZWJ in a folder's emoji
 * name) are part of the name, and `oneLineText` would show the orchestrator a folder that does not exist.
 */
function onePath(value: unknown): string {
  const text = String(value ?? '').replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
  return text.length > PATH_MAX ? `${text.slice(0, PATH_MAX)}…` : text
}

/** The most of a last response a hub reads in one call (`host.lastAnswer`'s ceiling) */
const ANSWER_MAX_CHARS = 100_000

/**
 * The text of an assistant line an older machine's `host.readSession` gave, or null for any other line. That machine cut
 * a line at 2,000 characters of its JSON and added an ellipsis, so a long answer's line did not parse, and the read
 * went on to an older line or came back empty (#1186): the head of such a line is read back here, as cut
 */
function assistantText(line: string): { text: string; cut: boolean } | null {
  try {
    const parsed = JSON.parse(line) as { role?: unknown; text?: unknown }
    return parsed.role === 'assistant' && typeof parsed.text === 'string' ? { text: parsed.text, cut: false } : null
  } catch {
    const m = /^\{"ts":"[^"]*","role":"assistant","text":"((?:[^"\\]|\\.)*)/.exec(line)
    if (!m) return null
    // A cut can end inside an escape (`\u00`): shorten it until it reads
    for (let end = m[1]!.length; end >= Math.max(0, m[1]!.length - 6); end--) {
      try {
        return { text: JSON.parse(`"${m[1]!.slice(0, end)}"`) as string, cut: true }
      } catch {
        // Not a whole escape yet
      }
    }
    return null
  }
}

/** Whether a line of a conversation is a tool call's (#1480): a machine from before `tools: "none"` still sends them */
function isToolLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line)
    return isObj(parsed) && parsed.role === 'tool'
  } catch {
    return false
  }
}

/** Whether a machine answered a read from an offset as one: no line, or one line that says what it shows (`lineText`) */
function offsetAnswered(lines: readonly string[]): boolean {
  if (lines.length === 0) return true
  if (lines.length > 1) return false
  try {
    return typeof (JSON.parse(lines[0]!) as { shown?: unknown }).shown === 'string'
  } catch {
    return false
  }
}

/** A machine's line of a conversation: kept when it is one line, as the machine's code makes it; quoted as one otherwise */
function fencedLine(line: string): string {
  return NOT_ONE_LINE.test(line) ? trustedJsonText(line) : line
}

/**
 * How long a name is resolved against a machine's project list before that machine is counted as not answering. A
 * name is looked up on every ask_project call, so one slow or half-open link must not hold up the asks that name a
 * project on this computer or on another machine; the link's own call timeout is much longer
 */
const LOOKUP_MS = 4000
/** What a linked machine's lookup answers past its bound (`raceTimeout`) */
const TIMED_OUT = Symbol('timed out')

/** A machine past its lookup bound, in the words the model reads */
function notWithin(ms: number): string {
  return `did not answer within ${ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`}`
}

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
  /**
   * Why a machine that is not connected cannot be asked, as the sentence the model reads (#1341). One that nothing here
   * will connect (the person disconnected it, or its Auto reconnect is off and the attempt at the hub's start is over)
   * says so at once and names who can: the person. No call connects a machine by itself
   */
  const away = (m: RoutedMachine): string =>
    m.waitsForPerson ? `${m.name} ${awayPhrase(NOT_CONNECTED)}, then try again` : `${m.name} is ${notReachable(m)}; try again once its link is back`
  /**
   * `NOT_REACHABLE`, with the attempt a call made to connect the machine (#1532): that it is still under way, or that it
   * failed with the attempt's own words, so the agent can tell a machine that is off from one whose ssh is refused
   */
  const notReachable = (m: RoutedMachine): string => (m.whyDown ? `${NOT_REACHABLE}; ${oneLine(m.whyDown, 300)}` : NOT_REACHABLE)
  /**
   * A machine that is connecting is waited for, bounded (#1341): the act that needs it goes through once the attempt ends,
   * as it did when a need connected it. With nothing trying, the call is answered at once
   */
  const settle = async (m: RoutedMachine): Promise<void> => {
    if (m.reachable) return
    // A call that needs a machine which is down tries to connect it (#1532, `reachForCall`); one that cannot do that waits for an attempt under way
    if (m.reachForCall) await m.reachForCall()
    else if (m.attemptUnderWay) await m.settled?.()
  }
  /** The router's call, its refusal as the sentence the model reads */
  const attempt = async <T>(m: RoutedMachine, run: () => Promise<T>): Promise<({ ok: true } & T) | { ok: false; error: string }> => {
    await settle(m)
    if (!m.reachable) return { ok: false, error: away(m) }
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
      path: onePath(p.path),
      defaultTool: tool.data,
      machine: m.name,
      machineId: m.id,
      ...(typeof p.trusted === 'boolean' ? { trusted: p.trusted } : {}),
      // Bounded here too: the machine's answer is its own, and the text goes into a task given there
      ...(typeof p.agentInstructions === 'string' && p.agentInstructions.trim() ? { agentInstructions: p.agentInstructions.slice(0, AGENT_INSTRUCTIONS_MAX) } : {}),
    }
  }

  /** A machine's projects as the headers mirror last held them, in the hub's terms */
  const lastProjects = (m: RoutedMachine): LinkedProject[] =>
    (m.lastKnown('projects') ?? []).map((raw) => projectOf(m, raw)).filter((p): p is LinkedProject => p !== null)

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

  type Listed = { projects: LinkedProject[]; away: { machine: string; machineId: string; why: string }[] }
  /**
   * One machine's projects, asked within `lookupMs` (#700). One that cannot be asked gives what the headers mirror last
   * held, each project marked `away` with why. `tried`: a call just tried to connect it, so one still connecting is away
   * too, with that said: the act that follows has waited for it already
   */
  const projectsOf = async (m: RoutedMachine, tried = false): Promise<Listed> => {
    const away: Listed['away'] = []
    /** What the headers mirror last held of the machine's projects, each marked with why it could not be asked */
    const mirrored = (why: string): LinkedProject[] => {
      away.push({ machine: m.name, machineId: m.id, why })
      return lastProjects(m).map((p) => ({ ...p, away: why }))
    }
    // Not away while it is connecting: its projects stand as last listed, and the act that follows waits for the link
    if (!m.reachable && m.attemptUnderWay && !tried) return { projects: lastProjects(m), away }
    if (!m.reachable) return { projects: mirrored(m.waitsForPerson ? NOT_CONNECTED : notReachable(m)), away }
    try {
      const list = await raceTimeout(m.call('projects.list', {}), lookupMs, TIMED_OUT)
      if (list === TIMED_OUT) throw new Error(notWithin(lookupMs))
      return { projects: (Array.isArray(list) ? list : []).map((raw) => projectOf(m, raw)).filter((p): p is LinkedProject => p !== null), away }
    } catch (err) {
      return { projects: mirrored(cause(m, err)), away }
    }
  }
  /** Whether `ref` names machine `m`: `<machine>/<name>` by its name or id, or a qualified id (`<machine id>.<id>`) */
  const qualifiedWith = (m: RoutedMachine, ref: string): boolean => {
    const slash = ref.indexOf('/')
    const prefix = slash > 0 ? ref.slice(0, slash).trim().toLowerCase() : null
    return prefix === m.id || prefix === m.name.toLowerCase() || ref.startsWith(`${m.id}.`)
  }
  /** Whether the project wanted as `need` is on machine `m`, as far as the mirror tells: its machine is named, or a project of it by that id or name */
  const needs = (m: RoutedMachine, need: ProjectNeed): boolean => {
    if (need.machineId === m.id) return true
    const ref = need.ref?.trim()
    if (!ref) return false
    if (qualifiedWith(m, ref)) return true
    return lastProjects(m).some((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase())
  }

  /**
   * Every machine's projects, each machine asked within `lookupMs` (#700). One that cannot be asked gives what the headers
   * mirror last held, each project marked `away` with why. Looking a name up (`findProjects`) goes through this too, so
   * a stalled link holds it up no longer than it holds the list, and a project there is found as away, never as missing.
   *
   * With `need`, the machines the act needs that are down are tried first (#1532, `settle`) and listed again after: only
   * those. A list does not wait on a machine the act does not need, nor on an attempt to one (it never did).
   * `need.anyDown` (#1547): the caller found the bare name nowhere, so the mirror cannot say where it is (it is empty after
   * a restart, or older than the project): every down machine is a candidate then, unless the name is qualified (`<machine or hub>/<name>`, or a machine's id)
   */
  const everyProject: LinkedSessions['projects'] = async (need) => {
    const all = [...machines()]
    const ref = need?.ref?.trim()
    const anyDown = !!need?.anyDown && !!ref && !ref.includes('/') && !all.some((m) => qualifiedWith(m, ref))
    const wanted = need ? all.filter((m) => !m.reachable && (anyDown || needs(m, need))) : []
    // A machine the act needs is listed after its attempt, once: the others are listed meanwhile
    const parts = await Promise.all(all.map(async (m) => (wanted.includes(m) ? (await settle(m), projectsOf(m, true)) : projectsOf(m))))
    return { projects: parts.flatMap((p) => p.projects), away: parts.flatMap((p) => p.away) }
  }

  return {
    async send(sessionId, text, fromName, ask) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => {
        await m.call('host.send', { sessionId: m.q.strip(sessionId, 'The session'), text, from: { name: hubName ? `${fromName} on ${hubName}` : fromName }, ...(ask ? { ask } : {}) })
        return {}
      })
    },

    async updateSettings(sessionId, s) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => ({ info: (await route('agents.updateSettings', { sessionId, ...s, by: 'orchestrator' })) as SessionInfo & { applied?: string } }))
    },

    async findProjects(ref, o) {
      const wanted = ref.trim()
      // The machine the name belongs to is tried if it is down (#1532): the act that follows creates a session there
      return (await everyProject({ ref: wanted, ...(o?.anyDown ? { anyDown: true } : {}) })).projects.filter((p) => p.id === wanted || p.name === wanted)
    },

    projects: everyProject,

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
          // The caller's cap (#838): never above the seat that asked, `normal` when it says nothing
          permissionPreset: opts.preset ?? 'normal',
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.worktreeBranch ? { worktree: true, worktreeBranch: opts.worktreeBranch } : {}),
          ...(opts.agentDepth ? { agentDepth: opts.agentDepth } : {}),
          // The caller's preset carried across (#1273): the machine starts it under `auto` only as its own switch allows
          ...(opts.callerPreset ? { fromHub: { callerPreset: opts.callerPreset } } : {}),
        })) as { id: string; name: string; permissionPreset?: unknown }
        if (opts.name) await route('sessions.rename', { sessionId: info.id, name: opts.name })
        const preset = PermissionPreset.safeParse(info.permissionPreset)
        return { sessionId: info.id, name: opts.name ?? info.name, ...(preset.success ? { preset: preset.data } : {}) }
      })
    },

    async hubAuto(machineId) {
      const m = machineById(machineId)
      if (!m) return { ok: false, error: `No linked machine ${machineId}` }
      // A build from before #1273 has no `host.hubAuto`, and drops `fromHub`: said as such, not as a failure
      let older = false
      const r = await attempt(m, async () => {
        try {
          const r = (await m.call('host.hubAuto', {})) as { allowed?: unknown }
          return { allowed: r?.allowed === true }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Unknown method: host.hubAuto')) older = true
          throw err
        }
      })
      return older ? { ok: false, error: `${m.name} runs a Centralu from before #1273`, olderBuild: true } : r
    },

    async origin(project) {
      const m = owner(project.id)
      if (!m) return { ok: false, error: `Not a project of a linked machine: ${project.id}` }
      // A build from before #1038 has no `projects.origin`, and drops `agentDepth` too: said as such, not as a failure
      let older = false
      const r = await attempt(m, async () => {
        try {
          const r = (await route('projects.origin', { projectId: project.id })) as { origin?: unknown }
          return { origin: typeof r?.origin === 'string' ? r.origin : null }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Unknown method: projects.origin')) older = true
          throw err
        }
      })
      return older ? { ok: false, error: `${m.name} runs a Centralu from before #1038`, olderBuild: true } : r
    },

    async interrupt(sessionId) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => {
        await route('agents.interrupt', { sessionId })
        return {}
      })
    },

    async deleteSession(sessionId) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => {
        await route('agents.deleteSession', { sessionId })
        return {}
      })
    },

    async agentInstructions(project) {
      const m = owner(project.id)
      if (!m) return { ok: false, error: `Not a project of a linked machine: ${project.id}` }
      return attempt(m, async () => {
        const list = await m.call('projects.list', {})
        const now = (Array.isArray(list) ? list : []).map((raw) => projectOf(m, raw)).find((p) => p?.id === project.id)
        if (!now) throw new Error(`${project.name} is no longer a project there`)
        return { text: now.agentInstructions ?? '' }
      })
    },

    async deleteAgentChild(sessionId, branch) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      let older = false
      const r = await attempt(m, async () => {
        try {
          const answer = RpcMethods['agents.deleteAgentChild'].result.safeParse(await route('agents.deleteAgentChild', { sessionId, worktreeBranch: branch }))
          if (!answer.success) throw new Error('its answer to agents.deleteAgentChild did not parse')
          const { worktree, path, branch: on, why, note } = answer.data
          // The machine's words, each on one line, as every text from it the hub puts in an answer
          return {
            worktree,
            ...(path ? { path: onePath(path) } : {}),
            ...(on ? { branch: oneLine(on) } : {}),
            // A sentence, not a label: longer, and still one line
            ...(why ? { why: oneLine(why, 1_000) } : {}),
            ...(note ? { note: oneLine(note, 1_000) } : {}),
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Unknown method: agents.deleteAgentChild')) older = true
          throw err
        }
      })
      return older ? { ok: false, error: `${m.name} runs a Centralu from before #1161`, olderBuild: true } : r
    },

    async lastUserMessage(sessionId) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => {
        // Newest page first, as a window pages back through it; a turn of many tool calls can span a page
        let beforeSeq: number | undefined
        for (let page = 0; page < 5; page++) {
          const list = await route('messages.load', { sessionId, limit: 200, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
          if (!Array.isArray(list) || list.length === 0) break
          for (const raw of [...list].reverse()) {
            if (!isObj(raw) || raw.role !== 'user' || raw.kind !== 'text' || !isObj(raw.payload)) continue
            return { message: { text: typeof raw.payload.text === 'string' ? raw.payload.text : '', from: raw.payload.from ?? null } }
          }
          const first: unknown = list[0]
          if (!isObj(first) || typeof first.seq !== 'number') break
          beforeSeq = first.seq
        }
        return { message: null }
      })
    },

    async cards(sessionId) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      const id = m.q.strip(sessionId, 'The session')
      return attempt(m, async () => {
        const list = await m.call('sessions.list', {})
        const raw = (Array.isArray(list) ? list : []).find((s) => isObj(s) && s.id === id)
        if (!isObj(raw)) throw new Error(`${m.name} no longer has this session`)
        // Read as the window reads them, in the hub's terms: what does not parse is no card the hub can show or answer.
        // The ids an approval's detail names are the machine's, so they are qualified as the window's event has them
        const card = isObj(raw.pendingApproval) ? { ...raw.pendingApproval, detail: m.q.approvalDetail(raw.pendingApproval.detail) } : null
        const approval = SessionInfo.shape.pendingApproval.safeParse(card)
        const questions = SessionInfo.shape.pendingQuestions.safeParse(raw.pendingQuestions ?? [])
        return { approval: approval.success ? approval.data : null, questions: questions.success ? questions.data : [] }
      })
    },

    async answerQuestion(sessionId, requestId, answers) {
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      return attempt(m, async () => {
        await route('agents.answerQuestion', { sessionId, requestId, answers })
        return {}
      })
    },

    machineLinked(machineId) {
      return !!machineById(machineId)
    },

    machineWaitsForPerson(machineId) {
      return machineById(machineId)?.waitsForPerson === true
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
      const path = onePath(r.preview.path)
      // A clone named by its repository: the folder the machine would make names it
      return { ok: true, name: spec.name.trim() || (path.split(/[\\/]/).pop() ?? path), path }
    },

    async createProject(machineId, spec) {
      const m = machineById(machineId)
      if (!m) return { ok: false, error: `No linked machine ${machineId}` }
      return attempt(m, async () => {
        const p = (await route('projects.create', { ...spec, machine: m.id })) as { id: string; name: string; path: string }
        return { projectId: p.id, name: oneLine(p.name), path: onePath(p.path) }
      })
    },

    async inspectFolder(machineId, path) {
      const m = machineById(machineId)
      if (!m) return { ok: false, error: `No linked machine ${machineId}` }
      const r = await attempt(m, async () => {
        try {
          return { raw: await route('projects.inspect', { path, machine: m.id }) }
        } catch (err) {
          // A machine on a Centralu from before #1220 knows no such method
          if (err instanceof Error && /Unknown method: projects\.inspect/.test(err.message)) {
            throw new Error(`${m.name} runs a Centralu too old to check a folder for the orchestrator; update it there, or add the folder from its group's Add project`)
          }
          throw err
        }
      })
      if (!r.ok) return r
      const facts = RpcMethods['projects.inspect'].result.safeParse(r.raw)
      if (!facts.success) return { ok: false, error: `${m.name} answered something that is not a folder's facts` }
      const project = facts.data.project
      return {
        ok: true,
        facts: { ...facts.data, path: onePath(facts.data.path), origin: facts.data.origin === null ? null : oneLine(facts.data.origin, 500), project: project ? { id: project.id, name: oneLine(project.name) } : null },
      }
    },

    async addProject(machineId, path) {
      const m = machineById(machineId)
      if (!m) return { ok: false, error: `No linked machine ${machineId}` }
      return attempt(m, async () => {
        const p = (await route('projects.add', { path, machine: m.id })) as { id: string; name: string; path: string }
        return { projectId: p.id, name: oneLine(p.name), path: onePath(p.path) }
      })
    },

    readerFacts(sessionId) {
      const m = owner(sessionId)
      const split = splitQualified(sessionId)
      if (!m || !split) return null
      const s = (m.lastKnown('sessions') ?? []).find((x) => isObj(x) && x.id === split.id)
      if (!isObj(s) || m.hides(s)) return null
      const p = typeof s.projectId === 'string' ? (m.lastKnown('projects') ?? []).find((x) => isObj(x) && x.id === s.projectId) : undefined
      return {
        // An app's session, its builder or an agent it asked for, as projectSessions leaves them out
        app: s.kind !== 'worker' || (typeof s.appId === 'string' && s.appId !== '') || typeof s.projectId !== 'string',
        trusted: isObj(p) && p.trusted === true,
      }
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
      const m = owner(sessionId)
      if (!m) return { ok: false, error: `Not a session of a linked machine: ${sessionId}` }
      await settle(m)
      if (!m.reachable) return { ok: false, error: m.waitsForPerson ? away(m) : `${m.name} is ${notReachable(m)}` }
      try {
        const answer = await m.call('host.lastAnswer', { sessionId: m.q.strip(sessionId, 'The session'), maxChars: Math.min(maxChars, ANSWER_MAX_CHARS) })
        const r = HostLastAnswerResult.safeParse(answer)
        if (!r.success) return { ok: false, error: `${m.name} answered in a shape this Centralu does not read` }
        // Its head, cut as this host cuts its own preview (`clipPreview`, #428): an answer says first what it did
        const text = r.data.text.length > maxChars || r.data.length > r.data.text.length ? `${r.data.text.slice(0, maxChars)}…` : r.data.text
        return { ok: true, text, length: r.data.length, seq: r.data.seq }
      } catch (err) {
        if (!(err instanceof Error && /Unknown method: host\.lastAnswer/.test(err.message))) return { ok: false, error: cause(m, err) }
      }
      // A machine on a Centralu from before #1186: its last assistant line, which it cut at 2,000 characters of JSON
      const r = await this.read(sessionId, 8)
      if (!r.ok) return { ok: false, error: r.error ?? 'it could not be read' }
      for (const line of [...(r.lines ?? [])].reverse()) {
        const said = assistantText(line)
        if (said !== null) return { ok: true, text: clipPreview(said.text, maxChars) + (said.cut && said.text.length <= maxChars ? '…' : ''), length: said.text.length, seq: null }
      }
      return { ok: true, text: '', length: 0, seq: null }
    },

    async list() {
      const perMachine = await Promise.all(
        [...machines()].map(async (m) => {
          if (!m.reachable) return lastKnown(m, m.waitsForPerson ? NOT_CONNECTED : NOT_REACHABLE)
          try {
            // Bounded like a lookup (#984): every session's list waits on the slowest machine otherwise
            const answer = await raceTimeout(m.call('host.sessions', {}), lookupMs, TIMED_OUT)
            if (answer === TIMED_OUT) return lastKnown(m, notWithin(lookupMs))
            return rows(m, answer)
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
      await settle(m)
      if (!m.reachable) return { ok: false, error: m.waitsForPerson ? away(m) : `${m.name} is ${notReachable(m)}; read it again once its link is back` }
      const toolMode = toolLinesOf(opts?.tools)
      try {
        const answer = await m.call('host.readSession', {
          sessionId: m.q.strip(sessionId, 'The session'),
          ...(limit !== undefined ? { limit } : {}),
          ...(opts?.around !== undefined ? { around: opts.around } : {}),
          // `tools` stays the boolean an older machine knows; `toolLines` is the three words, ignored by one
          ...(toolMode === 'full' ? { tools: true } : {}),
          ...(opts?.tools !== undefined ? { toolLines: toolMode } : {}),
          ...(opts?.maxChars !== undefined ? { maxChars: budgetOf(opts.maxChars) } : {}),
          ...(opts?.before !== undefined ? { before: opts.before } : {}),
          ...(opts?.from !== undefined ? { from: opts.from } : {}),
          ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
        })
        const r = HostReadSessionResult.safeParse(answer)
        if (!r.success) return { ok: false, error: `${m.name} answered in a shape this Centralu does not read` }
        /*
         * A read from an offset that an older machine answered as its plain read (#1186): it ignores `offset`, so the same
         * cut lines would come back on every read on, and the model would read them again and again. Said instead
         */
        if (opts?.offset !== undefined && !offsetAnswered(r.data.lines)) {
          return { ok: false, error: `${m.name} runs a Centralu from before reading a line from an offset, so it cannot show the rest of that line; update it there. Until then its lines stop at 2,000 characters` }
        }
        /*
         * A machine that does not echo the budget is from before it (#1480): it answers every line it has, tool lines too,
         * and ignores `before` and `from`, whose answer would be the same newest lines again
         */
        if (r.data.maxChars === undefined && (opts?.before !== undefined || opts?.from !== undefined)) {
          return { ok: false, error: `${m.name} runs a Centralu from before reading on from a line, so it cannot continue that read; update it there. recall finds a passage and read_session with its seq as around reads it` }
        }
        // The held bounds apply to every answer, a machine's own too: tool lines left out for `none`, then the budget
        const all = r.data.lines
        const kept = toolMode === 'none' ? all.filter((l) => !isToolLine(l)) : all
        // An `around` read: where the spot is in the machine's window, which it centres on it when lines come before it
        const spot = Math.min(Math.floor(Math.min(limit ?? 40, 200) / 2), all.length - 1)
        const around = opts?.around !== undefined && opts.before === undefined && opts.from === undefined
        const center = !around ? null : Math.min(toolMode === 'none' ? all.slice(0, spot).filter((l) => !isToolLine(l)).length : spot, kept.length - 1)
        const lines = fitMachineLines(kept, budgetOf(opts?.maxChars), center)
        return { ok: true, state: oneLine(r.data.state, 40), lines: lines.map(fencedLine) }
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
            const answer = await raceTimeout(m.call('host.recall', { query, limit }), lookupMs, TIMED_OUT)
            if (answer === TIMED_OUT) {
              notSearched.push(`${m.name} (${notWithin(lookupMs)})`)
              return []
            }
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
