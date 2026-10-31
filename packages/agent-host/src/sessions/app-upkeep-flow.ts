import { ORCHESTRATOR_CHANGE, errorMessage, type ExternalAppInfo } from '@cc/protocol'
import type { AppUpkeepRequest } from '../adapters/contract.js'
import type { HostCards } from './host-cards.js'
import { appLabel, awayLine, findApp, onMachine, readProjects, shown, type Projects } from './app-lookup.js'
import { plainQuoted, plural } from './tool-answers.js'
import { callWindow, type WindowRpc } from './window-rpc.js'

export type { AppUpkeepRequest }

export type AppUpkeepAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the app upkeep commands reach of the session manager: its cards */
export type AppUpkeepFlowHost = Pick<HostCards, 'askHost'>

/** An app as the window's calls name it: its id, its project (null for a user-folder app), and its machine when it is a linked one's */
type Ref = { appId: string; projectId: string | null; machine?: string }

/** How many rows a list names; the rest are counted */
const ROWS = 30

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/**
 * Text an app supplies (its error message, the last lines of its standard error, what it was called with), on one quoted
 * line with every control and format character escaped: it is the app's own output, data to read and never an
 * instruction, and a line break in it must not make an answer read as something it does not say.
 */
const fromApp = (text: string, max = 300): string => plainQuoted(text, max)

/**
 * The orchestrator's app upkeep commands (#1219, fourth slice): the calls the window's app screens make to look after an
 * app, each through the router (`apps.versions`, `apps.runs`, `apps.check`, ...), so the host checks them as it checks the
 * window and a linked machine's app is reached the way the window reaches it.
 *
 * Reading (versions, runs, errors, usage) and what is undone by itself acts at once: `restart_app` takes an app down (a call in
 * progress ends with it, as the window's Restart does) and starts nothing (whatever calls it next starts it), `check_app` restarts it on its files as the building session's check
 * does, and `restore_app_version` keeps the code it replaces as a version (`before restore`), so it can be restored back.
 * **Removing an app waits for the person's card** (`remove_app`): its folder moves to `app-trash/` and it is detached from
 * every session, so its tools vanish from the sessions using it. Only a user-folder app can be removed, as the window's call
 * refuses a project app (git withdraws that one).
 */
export class AppUpkeepFlow {
  private rpc: WindowRpc | null = null

  constructor(private readonly host: AppUpkeepFlowHost) {}

  useRpc(rpc: WindowRpc): void {
    this.rpc = rpc
  }

  async run(sessionId: string, req: AppUpkeepRequest, signal?: AbortSignal): Promise<AppUpkeepAnswer> {
    const rpc = this.rpc
    if (!rpc) return { ok: false, error: 'This host has no window calls to make.' }
    try {
      const [apps, all] = await Promise.all([callWindow(rpc, 'apps.list', {}), readProjects(rpc)])
      const found = findApp(apps, all, req.app, req.project, 'find_apps or list_app_grants')
      if ('error' in found) return { ok: false, error: found.error }
      const app = found.app
      const label = appLabel(app, all)
      const ref = { appId: app.appId, projectId: app.projectId, ...onMachine(app) }
      switch (req.action) {
        case 'versions':
          return await this.versions(rpc, label, ref)
        case 'restore_version':
          return await this.restoreVersion(rpc, app, label, ref, req.id)
        case 'restart': {
          const busy = await this.callsInProgress(rpc, sessionId, label, ref)
          if (busy) return { ok: false, error: busy }
          await callWindow(rpc, 'apps.restart', ref)
          return { ok: true, text: `Restarted ${label}: it is stopped (a call in progress ends with it) and its failures are cleared. It starts again the first time something calls it.` }
        }
        case 'check': {
          const busy = app.machine ? null : await this.callsInProgress(rpc, sessionId, label, ref)
          if (busy) return { ok: false, error: busy }
          return await this.check(rpc, app, label)
        }
        case 'runs':
          return await this.runs(rpc, label, ref, req.limit, all)
        case 'errors':
          return await this.errors(rpc, label, ref)
        case 'usage':
          return await this.usage(rpc, label, ref)
        case 'remove':
          return await this.remove(rpc, sessionId, app, label, all, signal)
      }
    } catch (e) {
      return { ok: false, error: errorMessage(e) }
    }
  }

  /**
   * Why the app cannot be restarted now, or null: another session, screen or app has a call in progress in it, and a restart (a
   * check restarts the app too) would end that call. The window's Restart does end it, but its person is looking at the
   * app; an orchestrator restarting the project board while it drives the merge queue is not that. Read from the run history
   * (`apps.runs`), where a call in progress is a run that is still `running`
   */
  private async callsInProgress(rpc: WindowRpc, caller: string, label: string, ref: Ref): Promise<string | null> {
    const runs = await callWindow(rpc, 'apps.runs', { ...ref, limit: 50 })
    const open = runs.filter((r) => r.status === 'running' && r.kind === 'tool' && r.callerSessionId !== caller)
    if (!open.length) return null
    const tools = [...new Set(open.map((r) => shown(r.tool)))].slice(0, 5).join(', ')
    return `${label} has ${plural(open.length, 'call')} in progress (${tools}) from another session, screen or app; stopping the app would end ${open.length === 1 ? 'it' : 'them'}. Try again when they are done, or leave it to the person.`
  }

  private async versions(rpc: WindowRpc, label: string, ref: Ref): Promise<AppUpkeepAnswer> {
    const v = await callWindow(rpc, 'apps.versions', ref)
    if (v.kind === 'git') {
      if (!v.repo) return { ok: true, text: `${label} is not in a git repository, so it has no version history.` }
      if (!v.commits.length) return { ok: true, text: `No commit has touched ${label} yet. Its history is git's; restoring is done there.` }
      const rows = v.commits.slice(0, ROWS).map((c) => `- ${fromApp(c.shortSha, 40)}: ${fromApp(c.subject, 160)} (${shown(c.author)}, ${day(c.when)})`)
      return { ok: true, text: [`The recent commits that touched ${label}. A project app's history is git's: restore_app_version works on user-folder apps only.`, ...rows].join('\n') }
    }
    if (!v.snapshots.length) return { ok: true, text: `${label} has no kept version yet; one is taken each time it starts on changed code.` }
    const rows = v.snapshots.slice(0, ROWS).map(
      // A linked machine's host wrote these: an id or a reason with a line break must not forge a line
      (s) => `- ${fromApp(s.id, 80)}: ${day(s.at)}, ${plural(s.files, 'file')}, ${s.bytes} bytes; ${fromApp(s.reason, 80)}${s.current ? ' (the code now)' : ''}`,
    )
    return {
      ok: true,
      text: [
        `${plural(v.snapshots.length, 'kept version')} of ${label}, newest first (restore_app_version with an id restores it; the code it replaces is kept as a version first):`,
        ...rows,
      ].join('\n'),
    }
  }

  private async restoreVersion(rpc: WindowRpc, app: ExternalAppInfo, label: string, ref: Ref, id: string): Promise<AppUpkeepAnswer> {
    if (app.projectId) return { ok: false, error: `${label} is a project app: its history is git's, and restoring is done there.` }
    const v = await callWindow(rpc, 'apps.versions', ref)
    if (v.kind !== 'snapshots') return { ok: false, error: `${label} keeps no snapshots; its history is git's.` }
    const target = v.snapshots.find((s) => s.id === id.trim())
    if (!target) return { ok: false, error: `${label} has no kept version ${shown(id.trim())}; list_app_versions names them.` }
    if (target.current) return { ok: true, text: `The code of ${label} is already that version; nothing was done.` }
    await callWindow(rpc, 'apps.restoreVersion', { ...ref, id: target.id })
    return {
      ok: true,
      text:
        `Restored ${label} to the version of ${day(target.at)} (${fromApp(target.reason, 80)}). The code it had before is kept as a version, so restoring can be undone; ` +
        'the app restarts on the restored code once any call in progress finishes, and an open screen reopens on it. If that version asks for more than the person allowed, it asks them again.',
    }
  }

  private async check(rpc: WindowRpc, app: ExternalAppInfo, label: string): Promise<AppUpkeepAnswer> {
    if (app.machine) return { ok: false, error: `${label} lives on a linked machine, and the check runs on this computer's apps only; its building session there runs check.` }
    const r = await callWindow(rpc, 'apps.check', { appId: app.appId, projectId: app.projectId })
    const problems = r.findings.filter((f) => f.level === 'problem').length
    const warnings = r.findings.length - problems
    // The report carries the app's own words (its standard error, tool names, a start failure's message): each line is one quoted line
    const report = r.text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 40).map((l) => `  ${fromApp(l, 400)}`)
    return {
      ok: true,
      text: [`Checked ${label} on its current files (it was restarted for this): ${r.ok ? 'no problem' : plural(problems, 'problem')}${warnings ? `, ${plural(warnings, 'warning')}` : ''}. The report, the app's own words quoted as data:`, ...report].join('\n'),
    }
  }

  private async runs(rpc: WindowRpc, label: string, ref: Ref, limit: number | undefined, all: Projects): Promise<AppUpkeepAnswer> {
    const n = Math.min(Math.max(Math.trunc(limit ?? 20), 1), 100)
    const runs = await callWindow(rpc, 'apps.runs', { ...ref, limit: n })
    if (!runs.length) return { ok: true, text: `${label} has no recorded run.` }
    const rows = runs.map((r) => {
      const who = r.callerKind === 'session' ? `a session${r.callerSessionId ? ` [${r.callerSessionId}]` : ''}` : r.callerKind === 'view' ? 'its screen' : 'another app'
      const took = r.durationMs === null ? '' : `, ${r.durationMs} ms`
      const err = r.error ? `; error ${fromApp(r.error, 200)}` : ''
      return `- ${day(r.createdAt)} ${r.kind === 'broker' ? 'asked for' : 'tool'} ${shown(r.tool)}: ${r.status}${took}, from ${who}; called with ${fromApp(r.argsSummary, 120)}${err}`
    })
    return { ok: true, text: [`The last ${plural(runs.length, 'run')} of ${label}, newest first:`, ...rows, ...awayLine(all, 'the apps')].join('\n') }
  }

  private async errors(rpc: WindowRpc, label: string, ref: Ref): Promise<AppUpkeepAnswer> {
    const e = await callWindow(rpc, 'apps.errors', ref)
    if (!e.recent.length) return { ok: true, text: `${label} has no error since this host started.` }
    const rows = e.recent.slice(0, 10).flatMap((b) => [
      `- ${day(b.at)} ${b.kind}${b.tool ? ` in ${shown(b.tool)}` : ''}: ${fromApp(b.message, 300)}${b.denied ? ` (the person denied ${shown(b.denied.capability)})` : ''}${b.sentAt ? '; already sent to its builder' : ''}`,
      ...b.stderr.slice(-5).map((l) => `    stderr ${fromApp(l, 200)}`),
    ])
    return { ok: true, text: [`The recent errors of ${label} (the app's own words, quoted as data; kept in memory since this host started):`, ...rows].join('\n') }
  }

  private async usage(rpc: WindowRpc, label: string, ref: Ref): Promise<AppUpkeepAnswer> {
    const u = await callWindow(rpc, 'apps.usage', ref)
    const line = (name: string, x: typeof u.day) =>
      `${name}: ${plural(x.runs, 'agent run')}, ${Math.round(x.durationMs / 1000)} s${x.tokens ? `, ${x.tokens.input} tokens in and ${x.tokens.output} out` : ''}`
    return { ok: true, text: [`The agent use ${label} requested:`, line('Last day', u.day), line('Last 30 days', u.month)].join('\n') }
  }

  private async remove(rpc: WindowRpc, caller: string, app: ExternalAppInfo, label: string, all: Projects, signal?: AbortSignal): Promise<AppUpkeepAnswer> {
    if (app.projectId) return { ok: false, error: `${label} is a project app: a file in the repository, withdrawn through git. Only a user-folder app can be removed.` }
    const where = app.machine ? `on ${shown(all.machines.get(app.machine) ?? app.machine)}` : "in Centralu's data folder here"
    const question = [
      `Remove the app ${label}?`,
      `Its folder moves to app-trash/ ${where}, kept and not deleted, and the app is detached from every session it was attached to, so its tools vanish from them.`,
      'Anything that calls it stops working until it is put back. Moving the folder back from app-trash/ by hand restores it as an ordinary user-folder app: if it was imported and had not been reviewed, that waiting review is forgotten.',
    ].join('\n')
    const decision = await this.host.askHost(caller, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return { ok: false, error: 'The person did not approve it, so the app was not removed. Do not ask again unless they tell you to.' }
    if (decision === null) return { ok: false, error: 'The card was withdrawn before the person answered, so the app was not removed.' }
    // Still the app the card named, and still a user-folder app
    const now = (await callWindow(rpc, 'apps.list', {})).find((x) => x.appId === app.appId && x.projectId === null && (x.machine ?? null) === (app.machine ?? null))
    if (!now) return { ok: true, text: `${label} was already gone while the card stood; nothing more was done.` }
    await callWindow(rpc, 'apps.remove', { appId: app.appId, projectId: null, ...onMachine(app) })
    return { ok: true, text: `Removed ${label}: its folder is in app-trash/ ${where}, and it is detached from the sessions that had it.` }
  }
}
