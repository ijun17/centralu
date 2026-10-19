import { ORCHESTRATOR_CHANGE, SessionId, type TrashedRun, type TrashedSession, type TrashedSubagentSteps } from '@cc/protocol'
import type { TrashRequest } from '../adapters/contract.js'
import type { HostCards } from './host-cards.js'
import { plainQuoted } from './tool-answers.js'
import { callWindow, issuesOf, type WindowRpc } from './window-rpc.js'

export type { TrashRequest }

export type TrashAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the trash commands reach of the session manager: its cards */
export type TrashFlowHost = Pick<HostCards, 'askHost'>

/** How many rows of a list or a card name their items; the rest are counted */
const ROWS = 25

/** A name as one quoted line the person or the model reads (`plainQuoted`) */
const shown = (name: string): string => plainQuoted(name)

function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** What deleting a trashed session for good takes with it besides its conversation, as the window's row says it */
function goesWith(s: TrashedSession): string[] {
  const parts: string[] = []
  if (s.conversationFile === 'remove') parts.push("the tool's own conversation file")
  if (s.worktree?.remove) parts.push(`the worktree at ${shown(s.worktree.path)}`)
  return parts
}

/** Where a row is kept, when it is not on this computer */
const where = (m: { machine?: string | null }) => (m.machine ? ` on the linked machine ${shown(m.machine)}` : '')

/** One trashed session for list_trash */
function sessionLine(s: TrashedSession): string {
  const project = s.project ? `project ${shown(s.project.name)}${s.project.exists ? '' : ' (deleted: restoring registers its folder again)'}` : 'no project'
  const keeps = s.conversationFile === 'keep' ? '; its tool conversation file stays' : ''
  const goes = goesWith(s)
  return `- ${shown(s.name)} [${s.id}]${where(s)}: ${project}; deleted ${day(s.deletedAt)}; ${plural(s.messages, 'message')}, ${bytesText(s.bytes)}${goes.length ? `; deleting for good also removes ${goes.join(' and ')}` : ''}${keeps}`
}

function stepsLine(t: TrashedSubagentSteps): string {
  return `- ${shown(t.name)} [${t.sessionId}]${where(t)}: ${plural(t.steps, 'step')} in ${plural(t.runs, 'run')}, ${bytesText(t.bytes)}, moved ${day(t.deletedAt)}`
}

function runLine(r: TrashedRun): string {
  return `- ${shown(r.sessionName)} of the app ${shown(r.app.name)}${where(r)}: ${plural(r.messages, 'message')}, ${bytesText(r.bytes)}, kept ${day(r.keptAt)}`
}

/** The first rows of a list, then how many more */
function rows<T>(items: readonly T[], line: (t: T) => string): string[] {
  return [...items.slice(0, ROWS).map(line), ...(items.length > ROWS ? [`- and ${items.length - ROWS} more`] : [])]
}

/** Whether a trashed row is still what a card named: not restored and deleted again since, nor changed in what goes with it */
function sameRow(a: TrashedSession, b: TrashedSession): boolean {
  return a.deletedAt === b.deletedAt && a.messages === b.messages && a.conversationFile === b.conversationFile && a.worktree?.path === b.worktree?.path && a.worktree?.remove === b.worktree?.remove
}

/** What the trash held, read through the window's `trash.list` (all linked machines merged, the unreached named) */
type Trash = { sessions: TrashedSession[]; runs: TrashedRun[]; steps: TrashedSubagentSteps[]; bytes: number; unreached: { name: string }[] }

/**
 * The orchestrator's trash commands (#1219): `list_trash`, `restore_trashed` and `trash_subagent_steps` act at once, as
 * the window's Trash screen does; `delete_trashed` and `empty_trash` delete for good, and wait for a card that names
 * what goes (an `other` card, `ORCHESTRATOR_CHANGE`, every preset, allow or deny only). Each is the call the window
 * makes (`trash.list`, `trash.restore`, `subagents.trash`, `trash.purge`, `trash.purgeSubagentSteps`,
 * `trash.purgeRuns`) through the router, so a linked machine's trash is reached the way the window reaches it.
 *
 * Deleting never takes what the card did not name. Both deletes read the trash again after Allow: a session restored
 * meanwhile is not deleted, and one that arrived while the card stood stays, as the window's own Empty trash never
 * deletes what it did not list (`trash.empty` is not called, for that reason: it takes everything there is).
 */
export class TrashFlow {
  private rpc: WindowRpc | null = null

  constructor(private readonly host: TrashFlowHost) {}

  useRpc(rpc: WindowRpc): void {
    this.rpc = rpc
  }

  async run(sessionId: string, req: TrashRequest, signal?: AbortSignal): Promise<TrashAnswer> {
    const rpc = this.rpc
    if (!rpc) return { ok: false, error: 'This host has no window calls to make.' }
    try {
      // The window's own check of an id, said before the trash is read to look for it
      if (req.action === 'restore' || req.action === 'delete') {
        const id = SessionId.safeParse(req.sessionId)
        if (!id.success) return { ok: false, error: issuesOf(id.error) }
      }
      switch (req.action) {
        case 'list':
          return await this.list(rpc)
        case 'restore':
          return await this.restore(rpc, sessionId, req.sessionId, req.what, signal)
        case 'trash_steps': {
          const r = await callWindow(rpc, 'subagents.trash', { sessionId: req.sessionId })
          return {
            ok: true,
            text: r.steps
              ? `Moved ${plural(r.steps, 'subagent step')} (${bytesText(r.bytes)}) of ${req.sessionId} to the trash. Its conversation and launch cards stay; a subagent still running goes on writing its new steps under its card. restore_trashed with what "subagent_steps" puts them back.`
              : `${req.sessionId} holds no subagent steps to move.`,
          }
        }
        case 'delete':
          return await this.delete(rpc, sessionId, req.sessionId, req.what, signal)
        case 'empty':
          return await this.empty(rpc, sessionId, signal)
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  private async read(rpc: WindowRpc): Promise<Trash> {
    const t = await callWindow(rpc, 'trash.list', {})
    return { sessions: t.sessions, runs: t.runs, steps: t.subagentSteps ?? [], bytes: t.bytes, unreached: t.unreached ?? [] }
  }

  private async list(rpc: WindowRpc): Promise<TrashAnswer> {
    const [trash, held] = await Promise.all([this.read(rpc), callWindow(rpc, 'subagents.usage', {}).catch(() => null)])
    const out = [`The trash: ${plural(trash.sessions.length, 'session')}, ${plural(trash.runs.length, 'app run')}, subagent steps of ${plural(trash.steps.length, 'session')}; ${bytesText(trash.bytes)} in all.`]
    if (trash.unreached.length) out.push(`Not listed: the trash on ${trash.unreached.map((m) => shown(m.name)).join(', ')}, which could not be reached just now.`)
    if (trash.sessions.length) out.push('Sessions (restore_trashed; delete_trashed deletes one for good):', ...rows(trash.sessions, sessionLine))
    if (trash.runs.length) out.push('Kept app runs (only empty_trash deletes these):', ...rows(trash.runs, runLine))
    if (trash.steps.length) out.push('Subagent steps in the trash (restore_trashed what "subagent_steps"; delete_trashed what "subagent_steps"):', ...rows(trash.steps, stepsLine))
    if (held?.sessions.length) {
      out.push(
        'Sessions holding subagent steps that trash_subagent_steps can move to the trash:',
        ...rows(held.sessions, (h) => `- ${shown(h.name)} [${h.sessionId}]${where(h)}: ${plural(h.steps, 'step')} in ${plural(h.runs, 'run')}, ${bytesText(h.bytes)}`),
      )
    }
    if (!trash.sessions.length && !trash.runs.length && !trash.steps.length) out.push('The trash is empty.')
    return { ok: true, text: out.join('\n') }
  }

  private async restore(rpc: WindowRpc, caller: string, id: string, what: 'session' | 'subagent_steps', signal?: AbortSignal): Promise<TrashAnswer> {
    if (what === 'subagent_steps') {
      await callWindow(rpc, 'trash.restoreSubagentSteps', { sessionId: id })
      return { ok: true, text: `Put the trashed subagent steps of ${id} back under their launch cards.` }
    }
    // A session whose project was deleted brings the project back: its folder is registered again, which asks like add_project
    const row = (await this.read(rpc)).sessions.find((x) => x.id === id)
    if (!row) return { ok: false, error: `${id} is not in the trash; list_trash shows what is. Nothing was restored.` }
    if (row.project && !row.project.exists) {
      const refused = await this.ask(
        caller,
        `Restore ${shown(row.name)}${where(row)} from the trash? Its project ${shown(row.project.name)} was deleted, so restoring registers its folder ` +
          `${row.project.path ? shown(row.project.path) : '(whose path is gone)'} as a project again, untrusted, as the Trash screen's Restore does.`,
        signal,
        'restored',
      )
      if (refused) return { ok: false, error: refused }
    }
    const r = await callWindow(rpc, 'trash.restore', { sessionId: id })
    const project = r.project ? ` Its project ${shown(r.project.name)} had been deleted; its folder is registered again.` : ''
    return { ok: true, text: `Restored ${shown(r.session.name)} [${r.session.id}] from the trash.${project}` }
  }

  private async delete(rpc: WindowRpc, caller: string, id: string, what: 'session' | 'subagent_steps', signal?: AbortSignal): Promise<TrashAnswer> {
    const trash = await this.read(rpc)
    if (what === 'subagent_steps') {
      const t = trash.steps.find((x) => x.sessionId === id)
      if (!t) return { ok: false, error: `${id} has no subagent steps in the trash; list_trash shows what is there. Nothing was deleted.` }
      const refused = await this.ask(
        caller,
        `Delete the trashed subagent steps of ${shown(t.name)}${where(t)} for good? ${plural(t.steps, 'step')} in ${plural(t.runs, 'run')} (${bytesText(t.bytes)}) leave this computer. ` +
          'The session, its conversation and the steps not in the trash stay. This cannot be undone.',
        signal,
      )
      if (refused) return { ok: false, error: refused }
      // Only the steps moved to the trash up to the entry the card named: later ones are not deleted unseen
      await callWindow(rpc, 'trash.purgeSubagentSteps', { sessionId: id, upTo: t.deletedAt })
      return { ok: true, text: `Deleted the trashed subagent steps of ${shown(t.name)} for good.` }
    }
    const s = trash.sessions.find((x) => x.id === id)
    if (!s) return { ok: false, error: `${id} is not in the trash (only a session in the trash can be deleted for good); list_trash shows what is. Nothing was deleted.` }
    const goes = goesWith(s)
    const refused = await this.ask(
      caller,
      `Delete the trashed session ${shown(s.name)}${where(s)} for good? Its ${plural(s.messages, 'message')} (${bytesText(s.bytes)}), attachments and handoff note leave this computer${goes.length ? `, and so do ${goes.join(' and ')}` : ''}. ` +
        `${s.conversationFile === 'keep' ? "The tool's own conversation file stays. " : ''}This cannot be undone.`,
      signal,
    )
    if (refused) return { ok: false, error: refused }
    // Still in the trash? It may have been restored while the card stood, and a restored session is not to be deleted; gone is gone
    const again = await this.read(rpc)
    const now = again.sessions.find((x) => x.id === id)
    if (!now) return { ok: false, error: `${shown(s.name)} is no longer in the trash (restored or deleted while the card stood), so nothing was deleted.` }
    if (!sameRow(s, now)) return { ok: false, error: `${shown(s.name)} was restored and deleted again while the card stood, so it is not what the card named and nothing was deleted; list_trash shows it as it is now.` }
    await callWindow(rpc, 'trash.purge', { sessionId: id })
    return { ok: true, text: `Deleted ${shown(s.name)} [${id}] for good.` }
  }

  private async empty(rpc: WindowRpc, caller: string, signal?: AbortSignal): Promise<TrashAnswer> {
    const named = await this.read(rpc)
    if (!named.sessions.length && !named.runs.length && !named.steps.length) {
      return { ok: true, text: `The trash is already empty.${named.unreached.length ? ` The trash on ${named.unreached.map((m) => shown(m.name)).join(', ')} could not be reached and was not looked at.` : ''}` }
    }
    const files = named.sessions.filter((s) => s.conversationFile === 'remove').length
    const trees = named.sessions.filter((s) => s.worktree?.remove).length
    const listed = [
      ...named.sessions.slice(0, 10).map((s) => `${shown(s.name)}${where(s)}`),
      ...(named.sessions.length > 10 ? [`and ${named.sessions.length - 10} more sessions`] : []),
    ]
    const refused = await this.ask(
      caller,
      `Empty the trash: delete ${plural(named.sessions.length, 'session')}${named.runs.length ? `, ${plural(named.runs.length, 'kept app run')}` : ''}${named.steps.length ? ` and the trashed subagent steps of ${plural(named.steps.length, 'session')}` : ''} ` +
        `for good (${bytesText(named.bytes)})? ${listed.length ? `Sessions: ${listed.join(', ')}. ` : ''}Their conversations, attachments and handoff notes leave this computer` +
        `${files ? `, with ${plural(files, 'tool conversation file')}` : ''}${trees ? `${files ? ' and' : ', with'} ${plural(trees, 'worktree')}` : ''}. ` +
        `${named.unreached.length ? `The trash on ${named.unreached.map((m) => shown(m.name)).join(', ')} could not be reached and is left alone. ` : ''}` +
        'What reaches the trash after this card is not deleted. This cannot be undone.',
      signal,
    )
    if (refused) return { ok: false, error: refused }

    // Only what the card named and is still there: a session restored meanwhile stays, one added meanwhile stays
    const now = await this.read(rpc)
    const nowById = new Map(now.sessions.map((s) => [s.id, s]))
    const gone: string[] = []
    const failed: string[] = []
    let deleted = 0
    for (const s of named.sessions) {
      const current = nowById.get(s.id)
      if (!current || !sameRow(s, current)) {
        gone.push(s.name)
        continue
      }
      try {
        await callWindow(rpc, 'trash.purge', { sessionId: s.id })
        deleted++
      } catch (e) {
        failed.push(`${shown(s.name)}: ${(e as Error).message}`)
      }
    }
    // Run records, one call per machine as the window makes them
    let runsDeleted = 0
    const nowRuns = new Set(now.runs.map((r) => r.runId))
    const byMachine = new Map<string | undefined, string[]>()
    for (const r of named.runs) if (nowRuns.has(r.runId)) byMachine.set(r.machine ?? undefined, [...(byMachine.get(r.machine ?? undefined) ?? []), r.runId])
    for (const [machine, runIds] of byMachine) {
      try {
        await callWindow(rpc, 'trash.purgeRuns', { runIds, ...(machine ? { machine } : {}) })
        runsDeleted += runIds.length
      } catch (e) {
        failed.push(`The app runs${machine ? ` on ${shown(machine)}` : ''}: ${(e as Error).message}`)
      }
    }
    let stepsDeleted = 0
    for (const t of named.steps) {
      if (!now.steps.some((x) => x.sessionId === t.sessionId)) continue
      try {
        await callWindow(rpc, 'trash.purgeSubagentSteps', { sessionId: t.sessionId, upTo: t.deletedAt })
        stepsDeleted++
      } catch (e) {
        failed.push(`The subagent steps of ${shown(t.name)}: ${(e as Error).message}`)
      }
    }
    const left = (await this.read(rpc).catch(() => null)) ?? now
    const arrived = left.sessions.length + left.runs.length + left.steps.length
    const parts = [`Deleted for good: ${plural(deleted, 'session')}${runsDeleted ? `, ${plural(runsDeleted, 'app run')}` : ''}${stepsDeleted ? `, the subagent steps of ${plural(stepsDeleted, 'session')}` : ''}.`]
    if (gone.length) parts.push(`Not what the card named when it was answered (restored, deleted or deleted again meanwhile), so left alone: ${gone.map(shown).join(', ')}.`)
    if (failed.length) parts.push(`Stayed in the trash: ${failed.join('; ')}`)
    if (arrived) parts.push(`The trash now holds ${plural(left.sessions.length, 'session')}, ${plural(left.runs.length, 'app run')} and subagent steps of ${plural(left.steps.length, 'session')}.`)
    return { ok: true, text: parts.join(' ') }
  }

  /** The delete card, allow or deny only (`ORCHESTRATOR_CHANGE`): the refusal the orchestrator reads, or null once allowed */
  private async ask(sessionId: string, question: string, signal?: AbortSignal, notDone: 'deleted' | 'restored' = 'deleted'): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return 'The person did not approve it, so nothing was ' + notDone + '. Do not ask again unless they tell you to.'
    if (decision === null) return 'The card was withdrawn before the person answered, so nothing was ' + notDone + '.'
    return null
  }
}
