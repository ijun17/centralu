import { HostReadSessionResult, HostRecallHit, HostSessionRow, SessionId } from '@cc/protocol'
import type { LinkedSessionsReader, OrchestratedSession, RecallHit } from '../adapters/contract.js'
import { trustedJsonText } from '../sessions/orchestrator-tools.js'
import { splitQualified } from './machine-ids.js'
import type { RoutedMachine } from './router.js'

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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What to tell the model when a machine could not answer: its own words for a refusal, a plain cause otherwise */
function cause(m: RoutedMachine, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // A machine on a Centralu from before phase 4 (connected anyway, on one protocol)
  if (message.startsWith('Unknown method: host.')) return `${m.name} runs a Centralu too old to be read from here; update it there`
  return oneLine(message, 300)
}

export function linkedSessions(machines: () => Iterable<RoutedMachine>): LinkedSessionsReader {
  const owner = (sessionId: string): RoutedMachine | null => {
    const split = splitQualified(sessionId)
    if (!split) return null
    for (const m of machines()) if (m.id === split.machine) return m
    return null
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
