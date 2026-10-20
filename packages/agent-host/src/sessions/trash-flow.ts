import { ORCHESTRATOR_CHANGE, SessionId, type TrashedRun, type TrashedSession, type TrashedSubagentSteps } from '@cc/protocol'
import type { TrashRequest } from '../adapters/contract.js'
import type { HostCards } from './host-cards.js'
import { plainQuoted } from './tool-answers.js'
import { callWindow, issuesOf, type WindowRpc } from './window-rpc.js'

export type { TrashRequest }

export type TrashAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the session archive commands reach of the session manager: its cards */
export type TrashFlowHost = Pick<HostCards, 'askHost'>

/** What `delete_session` reaches of this host's own sessions (`SessionTrash`): what a delete drops, and the delete decided in the step that moves the session */
export type SessionOps = {
  lossesOf(sessionId: string): string[]
  deleteIfQuiet(sessionId: string, also: () => boolean): Promise<boolean>
}

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

/** What deleting an archived session for good takes with it besides its conversation, as the window's row says it */
function goesWith(s: TrashedSession): string[] {
  const parts: string[] = []
  if (s.conversationFile === 'remove') parts.push("the tool's own conversation file")
  if (s.worktree?.remove) parts.push(`the worktree at ${shown(s.worktree.path)}`)
  return parts
}

/** Where a row is kept, when it is not on this computer */
const where = (m: { machine?: string | null }) => (m.machine ? ` on the linked machine ${shown(m.machine)}` : '')

/** One archived session for list_archive */
function sessionLine(s: TrashedSession): string {
  const project = s.project ? `project ${shown(s.project.name)}${s.project.exists ? '' : ' (deleted: restoring registers its folder again)'}` : 'no project'
  const keeps = s.conversationFile === 'keep' ? '; its tool conversation file stays' : ''
  const goes = goesWith(s)
  return `- ${shown(s.name)} [${s.id}]${where(s)}: ${project}; archived ${day(s.deletedAt)}; ${plural(s.messages, 'message')}, ${bytesText(s.bytes)}${goes.length ? `; deleting for good also removes ${goes.join(' and ')}` : ''}${keeps}`
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

/** What the session archive held, read through the window's `trash.list` (all linked machines merged, the unreached named) */
type Trash = { sessions: TrashedSession[]; runs: TrashedRun[]; steps: TrashedSubagentSteps[]; bytes: number; unreached: { name: string }[] }

/**
 * The orchestrator's session archive commands (#1219): `list_archive`, `restore_archived` and `archive_subagent_steps` act at once, as
 * the window's Archive screen does; `delete_archived` and `delete_all_archived` delete for good, and wait for a card that names
 * what goes (an `other` card, `ORCHESTRATOR_CHANGE`, every preset, allow or deny only). Each is the call the window
 * makes (`trash.list`, `trash.restore`, `subagents.trash`, `trash.purge`, `trash.purgeSubagentSteps`,
 * `trash.purgeRuns`) through the router, so a linked machine's session archive is reached the way the window reaches it.
 *
 * Deleting never takes what the card did not name. Both deletes read the session archive again after Allow: a session restored
 * meanwhile is not deleted, and one that arrived while the card stood stays, as the window's own Empty trash never
 * deletes what it did not list (`trash.empty` is not called, for that reason: it takes everything there is).
 */
export class TrashFlow {
  private rpc: WindowRpc | null = null

  private sessions: SessionOps | null = null

  constructor(private readonly host: TrashFlowHost) {}

  useRpc(rpc: WindowRpc): void {
    this.rpc = rpc
  }

  useSessions(ops: SessionOps): void {
    this.sessions = ops
  }

  async run(sessionId: string, req: TrashRequest, signal?: AbortSignal): Promise<TrashAnswer> {
    const rpc = this.rpc
    if (!rpc) return { ok: false, error: 'This host has no window calls to make.' }
    try {
      // The window's own check of an id, said before the session archive is read to look for it
      if (req.action === 'restore' || req.action === 'delete' || req.action === 'delete_session') {
        const id = SessionId.safeParse(req.sessionId)
        if (!id.success) return { ok: false, error: issuesOf(id.error) }
      }
      switch (req.action) {
        case 'list':
          return await this.list(rpc)
        case 'restore':
          return await this.restore(rpc, sessionId, req.sessionId, req.what, signal)
        case 'archive_steps': {
          const r = await callWindow(rpc, 'subagents.trash', { sessionId: req.sessionId })
          return {
            ok: true,
            text: r.steps
              ? `Moved ${plural(r.steps, 'subagent step')} (${bytesText(r.bytes)}) of ${req.sessionId} to the session archive. Its conversation and launch cards stay; a subagent still running goes on writing its new steps under its card. restore_archived with what "steps" puts them back.`
              : `${req.sessionId} holds no subagent steps to move.`,
          }
        }
        case 'delete_session':
          return await this.deleteSession(rpc, sessionId, req.sessionId, signal)
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
    const out = [`The session archive: ${plural(trash.sessions.length, 'session')}, ${plural(trash.runs.length, 'app run')}, subagent steps of ${plural(trash.steps.length, 'session')}; ${bytesText(trash.bytes)} in all.`]
    if (trash.unreached.length) out.push(`Not listed: the session archive on ${trash.unreached.map((m) => shown(m.name)).join(', ')}, which could not be reached just now.`)
    if (trash.sessions.length) out.push('Sessions (restore_archived; delete_archived deletes one for good):', ...rows(trash.sessions, sessionLine))
    if (trash.runs.length) out.push('Kept app runs (only delete_all_archived deletes these):', ...rows(trash.runs, runLine))
    if (trash.steps.length) out.push('Subagent steps in the session archive (restore_archived what "steps"; delete_archived what "steps"):', ...rows(trash.steps, stepsLine))
    if (held?.sessions.length) {
      out.push(
        'Sessions holding subagent steps that archive_subagent_steps can move to the session archive:',
        ...rows(held.sessions, (h) => `- ${shown(h.name)} [${h.sessionId}]${where(h)}: ${plural(h.steps, 'step')} in ${plural(h.runs, 'run')}, ${bytesText(h.bytes)}`),
      )
    }
    if (!trash.sessions.length && !trash.runs.length && !trash.steps.length) out.push('The session archive is empty.')
    return { ok: true, text: out.join('\n') }
  }

  /**
   * delete_session (#1219, fourth slice): moves a session that is not the caller's child to the session archive. It **asks, every
   * time**: what comes back with `restore_archived` is the conversation, the worktree and the tool's file, but the host lets go
   * of what the session held when it leaves (a caller's wait for its report, delegations, its children's reports, the
   * start_agent cards it raised, what the person allowed it), and the card names what is lost for this session
   * (`SessionTrash.lossesOf`). A worker the person started themselves is named as theirs.
   *
   * Refused before the card, from the window's list: the caller itself, a session that is not a worker, a child the caller
   * started (that is `agent_session delete`), one on a machine that cannot be reached, one busy now (a turn, a card, a
   * background job: moving it ends its process). After Allow the host decides at the last moment, in the step that moves it
   * and with nothing awaited between (`SessionTrash.trashIfQuiet`): a message the person sent meanwhile, a card, a job, or
   * a change in what is lost since the card keeps the session where it is. A linked machine's session is moved by that
   * machine's own `agents.deleteSession`, which cannot be decided in the step, so there the card is the safeguard.
   */
  private async deleteSession(rpc: WindowRpc, caller: string, id: string, signal?: AbortSignal): Promise<TrashAnswer> {
    if (id === caller) return { ok: false, error: 'This session cannot delete itself.' }
    const row = (await callWindow(rpc, 'sessions.list', {})).find((s) => s.id === id)
    if (!row) return { ok: false, error: `No session [${id}] is listed; list_sessions shows them. Nothing was deleted.` }
    const name = shown(row.name)
    if (row.kind !== 'worker') return { ok: false, error: `${name} is ${row.kind === 'orchestrator' ? 'an orchestrator' : 'a coordinator'}; only the person deletes those.` }
    if (row.askedBy === caller) return { ok: false, error: `${name} is a child you started; delete it with agent_session (action delete), which also settles its report and its worktree.` }
    if (row.unreachable) return { ok: false, error: `${name} is on a machine that cannot be reached just now; try again when it answers.` }
    if (row.state === 'working' || row.pendingApproval || row.pendingQuestions.length > 0) {
      return { ok: false, error: `${name} is busy (${row.pendingApproval || row.pendingQuestions.length ? 'waiting on the person' : 'working'}); the person may be using it. Delete it once it is idle.` }
    }
    // Moving it to the session archive ends its process, and with it a server or a watch it started: that is not what the session archive brings back
    const running = row.backgroundTasks.filter((t) => t.status === 'running')
    if (running.length) {
      return { ok: false, error: `${name} has ${plural(running.length, 'background job')} still running (${running.slice(0, 3).map((t) => plainQuoted(t.description, 80)).join(', ')}); deleting it would end ${running.length === 1 ? 'it' : 'them'} for good. The person can stop ${running.length === 1 ? 'it' : 'them'} first.` }
    }
    const ops = this.sessions
    const local = !row.machine
    if (local && !ops) return { ok: false, error: 'This host cannot archive a session from here.' }
    const lost = local && ops ? ops.lossesOf(id) : []
    const yours = row.askedBy == null && row.parentSessionId == null
    const question = [
      `Archive the session ${name}${row.machine ? ` on the linked machine ${shown(row.machine)}` : ''}?`,
      yours ? 'The person started it themselves.' : '',
      'Its process stops. Restoring it from the session archive brings back its conversation, its worktree and the tool\'s own conversation file, and a restored session starts a new process.',
      lost.length
        ? `Restoring does not bring back what the host lets go of when it leaves:\n${lost.map((l) => `- ${l}`).join('\n')}`
        : local
          ? 'Nothing else is lost: no one is waiting on it and it owes no report.'
          : 'What a linked machine lets go of when it moves a session is that machine\'s to say; the person can read it on that machine.',
      'It is moved only if it is still at rest when you answer; a turn, a card or a message that arrives meanwhile keeps it where it is.',
    ]
      .filter(Boolean)
      .join('\n')
    const refused = await this.ask(caller, question, signal, 'archived')
    if (refused) return { ok: false, error: refused }
    if (local && ops) {
      // Decided in the step that moves it: at rest, and losing exactly what the card said
      const moved = await ops.deleteIfQuiet(id, () => JSON.stringify(ops.lossesOf(id)) === JSON.stringify(lost))
      if (!moved) return { ok: false, error: `${name} is not at rest any more, or what moving it drops changed, or it is already gone (a message, a card, a job, or a change in who waits on it came while the card stood), so it was not moved. Ask again if it still should be.` }
    } else {
      // The machine decides on its own; the list is read again so a session busy since the card is not moved
      const now = (await callWindow(rpc, 'sessions.list', {})).find((s) => s.id === id)
      if (!now) return { ok: true, text: `${name} [${id}] was already gone while the card stood; nothing more was done.` }
      if (now.state === 'working' || now.pendingApproval || now.pendingQuestions.length > 0 || now.backgroundTasks.some((t) => t.status === 'running')) {
        return { ok: false, error: `${name} became busy while the card stood, so it was not moved. Ask again if it still should be.` }
      }
      await callWindow(rpc, 'agents.deleteSession', { sessionId: id, deleteWorktree: false, deleteExternal: false })
    }
    return {
      ok: true,
      text:
        `Moved ${name} [${id}]${row.machine ? ` on ${shown(row.machine)}` : ''} to the session archive. Nothing was destroyed: ${row.worktree ? 'its worktree stays, ' : ''}the tool's own conversation file stays, ` +
        `and restore_archived brings it back${lost.length ? ' (not what the card listed as dropped)' : ''}; delete_archived deletes it for good, after the person's card.`,
    }
  }

  private async restore(rpc: WindowRpc, caller: string, id: string, what: 'session' | 'steps', signal?: AbortSignal): Promise<TrashAnswer> {
    if (what === 'steps') {
      await callWindow(rpc, 'trash.restoreSubagentSteps', { sessionId: id })
      return { ok: true, text: `Put the archived subagent steps of ${id} back under their launch cards.` }
    }
    // A session whose project was deleted brings the project back: its folder is registered again, which asks like add_project
    const row = (await this.read(rpc)).sessions.find((x) => x.id === id)
    if (!row) return { ok: false, error: `${id} is not in the session archive; list_archive shows what is. Nothing was restored.` }
    if (row.project && !row.project.exists) {
      const refused = await this.ask(
        caller,
        `Restore ${shown(row.name)}${where(row)} from the session archive? Its project ${shown(row.project.name)} was deleted, so restoring registers its folder ` +
          `${row.project.path ? shown(row.project.path) : '(whose path is gone)'} as a project again, untrusted, as the Archive screen's Restore does.`,
        signal,
        'restored',
      )
      if (refused) return { ok: false, error: refused }
    }
    const r = await callWindow(rpc, 'trash.restore', { sessionId: id })
    const project = r.project ? ` Its project ${shown(r.project.name)} had been deleted; its folder is registered again.` : ''
    return { ok: true, text: `Restored ${shown(r.session.name)} [${r.session.id}] from the session archive.${project}` }
  }

  private async delete(rpc: WindowRpc, caller: string, id: string, what: 'session' | 'steps', signal?: AbortSignal): Promise<TrashAnswer> {
    const trash = await this.read(rpc)
    if (what === 'steps') {
      const t = trash.steps.find((x) => x.sessionId === id)
      if (!t) return { ok: false, error: `${id} has no subagent steps in the session archive; list_archive shows what is there. Nothing was deleted.` }
      const refused = await this.ask(
        caller,
        `Delete the archived subagent steps of ${shown(t.name)}${where(t)} for good? ${plural(t.steps, 'step')} in ${plural(t.runs, 'run')} (${bytesText(t.bytes)}) leave this computer. ` +
          'The session, its conversation and the steps not in the session archive stay. This cannot be undone.',
        signal,
      )
      if (refused) return { ok: false, error: refused }
      // Only the steps archived up to the entry the card named: later ones are not deleted unseen
      await callWindow(rpc, 'trash.purgeSubagentSteps', { sessionId: id, upTo: t.deletedAt })
      return { ok: true, text: `Deleted the archived subagent steps of ${shown(t.name)} for good.` }
    }
    const s = trash.sessions.find((x) => x.id === id)
    if (!s) return { ok: false, error: `${id} is not in the session archive (only a session in the session archive can be deleted for good); list_archive shows what is. Nothing was deleted.` }
    const goes = goesWith(s)
    const refused = await this.ask(
      caller,
      `Delete the archived session ${shown(s.name)}${where(s)} for good? Its ${plural(s.messages, 'message')} (${bytesText(s.bytes)}), attachments and handoff note leave this computer${goes.length ? `, and so do ${goes.join(' and ')}` : ''}. ` +
        `${s.conversationFile === 'keep' ? "The tool's own conversation file stays. " : ''}This cannot be undone.`,
      signal,
    )
    if (refused) return { ok: false, error: refused }
    // Still in the session archive? It may have been restored while the card stood, and a restored session is not to be deleted; gone is gone
    const again = await this.read(rpc)
    const now = again.sessions.find((x) => x.id === id)
    if (!now) return { ok: false, error: `${shown(s.name)} is no longer in the session archive (restored or deleted while the card stood), so nothing was deleted.` }
    if (!sameRow(s, now)) return { ok: false, error: `${shown(s.name)} was restored and deleted again while the card stood, so it is not what the card named and nothing was deleted; list_archive shows it as it is now.` }
    await callWindow(rpc, 'trash.purge', { sessionId: id })
    return { ok: true, text: `Deleted ${shown(s.name)} [${id}] for good.` }
  }

  private async empty(rpc: WindowRpc, caller: string, signal?: AbortSignal): Promise<TrashAnswer> {
    const named = await this.read(rpc)
    if (!named.sessions.length && !named.runs.length && !named.steps.length) {
      return { ok: true, text: `The session archive is already empty.${named.unreached.length ? ` The session archive on ${named.unreached.map((m) => shown(m.name)).join(', ')} could not be reached and was not looked at.` : ''}` }
    }
    const files = named.sessions.filter((s) => s.conversationFile === 'remove').length
    const trees = named.sessions.filter((s) => s.worktree?.remove).length
    const listed = [
      ...named.sessions.slice(0, 10).map((s) => `${shown(s.name)}${where(s)}`),
      ...(named.sessions.length > 10 ? [`and ${named.sessions.length - 10} more sessions`] : []),
    ]
    const refused = await this.ask(
      caller,
      `Delete all archived sessions: delete ${plural(named.sessions.length, 'session')}${named.runs.length ? `, ${plural(named.runs.length, 'kept app run')}` : ''}${named.steps.length ? ` and the archived subagent steps of ${plural(named.steps.length, 'session')}` : ''} ` +
        `for good (${bytesText(named.bytes)})? ${listed.length ? `Sessions: ${listed.join(', ')}. ` : ''}Their conversations, attachments and handoff notes leave this computer` +
        `${files ? `, with ${plural(files, 'tool conversation file')}` : ''}${trees ? `${files ? ' and' : ', with'} ${plural(trees, 'worktree')}` : ''}. ` +
        `${named.unreached.length ? `The session archive on ${named.unreached.map((m) => shown(m.name)).join(', ')} could not be reached and is left alone. ` : ''}` +
        'What reaches the session archive after this card is not deleted. This cannot be undone.',
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
    if (failed.length) parts.push(`Stayed in the session archive: ${failed.join('; ')}`)
    if (arrived) parts.push(`The session archive now holds ${plural(left.sessions.length, 'session')}, ${plural(left.runs.length, 'app run')} and subagent steps of ${plural(left.steps.length, 'session')}.`)
    return { ok: true, text: parts.join(' ') }
  }

  /** The delete card, allow or deny only (`ORCHESTRATOR_CHANGE`): the refusal the orchestrator reads, or null once allowed */
  private async ask(sessionId: string, question: string, signal?: AbortSignal, notDone: 'deleted' | 'restored' | 'archived' = 'deleted'): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return 'The person did not approve it, so nothing was ' + notDone + '. Do not ask again unless they tell you to.'
    if (decision === null) return 'The card was withdrawn before the person answered, so nothing was ' + notDone + '.'
    return null
  }
}
