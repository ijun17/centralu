import { SessionId, errorMessage, type SessionInfo } from '@cc/protocol'
import type { HousekeepingRequest } from '../adapters/contract.js'
import { findProject, readProjects, shown, whereText } from './app-lookup.js'
import { plainQuoted } from './tool-answers.js'
import { callWindow, issuesOf, type WindowRpc } from './window-rpc.js'

export type { HousekeepingRequest }

export type HousekeepingAnswer = { ok: true; text: string } | { ok: false; error: string }

/** Control and format characters (bidi overrides among them): a name shown on a screen would not show what they hide */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** The longest session name the command sets (the sidebar shows one line) */
const NAME_MAX = 120

/** A path the project holds, quoted and escaped but not cut: the end of a path is what tells two files apart */
const shownPath = (path: string): string => plainQuoted(path, 4096)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The orchestrator's housekeeping and reads of the window (#1219, fourth slice): renaming a session, taking ended
 * background tasks off its list, and reading how the agent CLIs stand (installed, logged in, their limits, their models),
 * a project's git state, and its files by name. Each is the call the window makes (`sessions.rename`,
 * `agents.clearBackgroundTasks`, `agents.detect`, `agents.usage`, `agents.models`, `projects.gitStatus`, `files.search`) through
 * the router, so a linked machine's session or project is reached the way the window reaches it. None asks: a name is
 * restored by setting the old one (the answer quotes it), ended tasks are the tool's finished work, and the rest read.
 *
 * What the window can do here and this does not: stopping a session's background task ends a process the session started
 * and cannot be undone, marking a session read hides a notice the person has not seen, and reordering the sidebar is the
 * person's arrangement of their own screen (docs/agent-host.md §1.4).
 */
export class HousekeepingFlow {
  private rpc: WindowRpc | null = null

  useRpc(rpc: WindowRpc): void {
    this.rpc = rpc
  }

  async run(caller: string, req: HousekeepingRequest): Promise<HousekeepingAnswer> {
    const rpc = this.rpc
    if (!rpc) return { ok: false, error: 'This host has no window calls to make.' }
    try {
      switch (req.action) {
        case 'rename_session':
          return await this.rename(rpc, caller, req.sessionId, req.name)
        case 'clear_background_tasks':
          return await this.clearTasks(rpc, req.sessionId)
        case 'agent_status':
          return await this.agentStatus(rpc, req.tool)
        case 'agent_models':
          return await this.agentModels(rpc, req.tool)
        case 'git_status':
          return await this.gitStatus(rpc, req.project)
        case 'search_files':
          return await this.searchFiles(rpc, req.project, req.query, req.limit)
      }
    } catch (e) {
      return { ok: false, error: errorMessage(e) }
    }
  }

  /** A session the command may act on: a worker the caller is not, on a machine that answers; or the sentence that says why not */
  private async session(rpc: WindowRpc, caller: string, id: string): Promise<{ error: string } | { row: SessionInfo }> {
    const checked = SessionId.safeParse(id.trim())
    if (!checked.success) return { error: issuesOf(checked.error) }
    if (checked.data === caller) return { error: 'This session is the one asking; it does not change itself.' }
    const row = (await callWindow(rpc, 'sessions.list', {})).find((s) => s.id === checked.data)
    if (!row) return { error: `No session [${checked.data}] is listed; list_sessions shows them.` }
    if (row.kind !== 'worker') return { error: `${shown(row.name)} is ${row.kind === 'orchestrator' ? 'an orchestrator' : 'a coordinator'}; only the person changes those.` }
    if (row.unreachable) return { error: `${shown(row.name)} is on a machine that cannot be reached just now; try again when it answers.` }
    return { row }
  }

  private async rename(rpc: WindowRpc, caller: string, id: string, name: string): Promise<HousekeepingAnswer> {
    const next = name.trim()
    if (!next) return { ok: false, error: 'Give name: the new name of the session.' }
    if (HIDDEN.test(next)) return { ok: false, error: 'name has a control or formatting character in it; give it as plain text.' }
    // A name is shown in the sidebar and in reports beside the host's own notices, which begin with [Centralu]: a worker's name must not pass for one
    if (/^\[\s*centralu\b/i.test(next)) return { ok: false, error: 'name begins with [Centralu], which is how the host marks its own notices; give the session another name.' }
    if (next.length > NAME_MAX) return { ok: false, error: `name is longer than ${NAME_MAX} characters; the sidebar shows one line.` }
    const found = await this.session(rpc, caller, id)
    if ('error' in found) return { ok: false, error: found.error }
    const { row } = found
    if (row.name === next) return { ok: true, text: `${shown(row.name)} [${row.id}] already has that name; nothing changed.` }
    await callWindow(rpc, 'sessions.rename', { sessionId: row.id, name: next })
    return { ok: true, text: `Renamed ${shown(row.name)} [${row.id}] to ${shown(next)}. Renaming it back sets the old name.` }
  }

  private async clearTasks(rpc: WindowRpc, id: string): Promise<HousekeepingAnswer> {
    const found = await this.session(rpc, '', id)
    if ('error' in found) return { ok: false, error: found.error }
    const { row } = found
    const ended = (row.backgroundTasks ?? []).filter((t) => t.status !== 'running').length
    if (!ended) return { ok: true, text: `${shown(row.name)} [${row.id}] has no ended background task on its list; nothing changed.` }
    await callWindow(rpc, 'agents.clearBackgroundTasks', { sessionId: row.id })
    return { ok: true, text: `Took ${plural(ended, 'ended background task')} off the list of ${shown(row.name)} [${row.id}]. Tasks still running stay; they are the tool's to end.` }
  }

  private async agentStatus(rpc: WindowRpc, tool?: string): Promise<HousekeepingAnswer> {
    const only = tool?.trim()
    const statuses = (await callWindow(rpc, 'agents.detect', {})).filter((s) => !only || s.name === only)
    if (!statuses.length) return { ok: true, text: only ? `No agent CLI called ${shown(only)} is known on this computer; agent_status without a tool lists them.` : 'No agent CLI is known on this computer.' }
    const out: string[] = []
    for (const s of statuses) {
      out.push(`- ${s.label} (${s.name}): ${s.installed ? 'installed' : 'not installed'}${s.installed ? (s.loggedIn ? ', logged in' : ', not logged in') : ''}; ${plainQuoted(s.detail, 200)}`)
      if (!s.installed || !s.loggedIn) continue
      const u = await callWindow(rpc, 'agents.usage', { tool: s.name }).catch(() => null)
      if (!u) continue
      if (!u.supported) out.push(`  Limits: not available${u.reason ? ` (${plainQuoted(u.reason, 200)})` : ''}`)
      else if (u.usage) {
        if (u.usage.plan) out.push(`  Plan: ${plainQuoted(u.usage.plan, 80)}`)
        for (const w of u.usage.windows) out.push(`  ${plainQuoted(w.label, 80)}${w.scope ? ` (${plainQuoted(w.scope, 80)})` : ''}: ${Math.round(w.percent)}% used${w.resetsAt ? `, resets ${plainQuoted(w.resetsAt, 40)}` : ''}`)
      }
    }
    return { ok: true, text: ['The agent CLIs on this computer:', ...out].join('\n') }
  }

  private async agentModels(rpc: WindowRpc, tool: string): Promise<HousekeepingAnswer> {
    const name = tool.trim()
    if (!name) return { ok: false, error: 'Give tool: the agent CLI, as agent_status names it.' }
    const r = await callWindow(rpc, 'agents.models', { tool: name })
    if (!r.supported) return { ok: true, text: `${shown(name)} does not list its models${r.reason ? `: ${plainQuoted(r.reason, 200)}` : ''}.` }
    if (!r.models.length) return { ok: true, text: `${shown(name)} lists no model.` }
    const rows = r.models.slice(0, 40).map((m) => `- ${shown(m.id)}: ${plainQuoted(m.label, 80)}${m.efforts.length ? `; efforts ${m.efforts.map((e) => plainQuoted(e, 40)).join(', ')}` : ''}`)
    return { ok: true, text: [`The models ${shown(name)} offers (create_session and update_session_settings take an id):`, ...rows, ...(r.models.length > 40 ? [`- and ${r.models.length - 40} more`] : [])].join('\n') }
  }

  private async gitStatus(rpc: WindowRpc, named: string): Promise<HousekeepingAnswer> {
    const all = await readProjects(rpc)
    const found = findProject(all, named)
    if ('error' in found) return { ok: false, error: found.error }
    const p = found.project
    const [status, origin] = await Promise.all([callWindow(rpc, 'projects.gitStatus', { projectId: p.id }), callWindow(rpc, 'projects.origin', { projectId: p.id }).catch(() => null)])
    const g = status.git
    const label = `${shown(p.name)} [${p.id}]${whereText(p, all.machines)}`
    if (status.unreachable) return { ok: true, text: `${label}: its machine cannot be reached just now, so its git state is not known.` }
    // The host says no git state for a folder that is no repository
    if (!g) return { ok: true, text: `${label}: ${shownPath(p.path)} is not a git repository.` }
    if (g.denied) return { ok: true, text: `${label}: the folder cannot be read (access was refused).` }
    const changed = g.unknown ? 'changes not counted' : `${plural(g.changedFiles, 'changed file')}${g.more ? ' or more' : ''}`
    return { ok: true, text: `${label}: on the branch ${shown(g.branch)}, ${changed}${origin?.origin ? `; origin ${shown(origin.origin)}` : '; no origin'}.` }
  }

  private async searchFiles(rpc: WindowRpc, named: string, query: string, limit?: number): Promise<HousekeepingAnswer> {
    const q = query.trim()
    if (!q) return { ok: false, error: 'Give query: part of a file name to look for.' }
    if (HIDDEN.test(q)) return { ok: false, error: 'query has a control or formatting character in it; give it as plain text.' }
    const all = await readProjects(rpc)
    const found = findProject(all, named)
    if ('error' in found) return { ok: false, error: found.error }
    const n = Math.min(Math.max(Math.trunc(limit ?? 20), 1), 50)
    const hits = await callWindow(rpc, 'files.search', { projectId: found.project.id, query: q, limit: n })
    const label = `${shown(found.project.name)} [${found.project.id}]${whereText(found.project, all.machines)}`
    if (!hits.length) return { ok: true, text: `No file of ${label} matches ${shown(q)}.` }
    return { ok: true, text: [`${plural(hits.length, 'file')} of ${label} match ${shown(q)}:`, ...hits.map((h) => `- ${shownPath(h.path)}`)].join('\n') }
  }
}
