import { ORCHESTRATOR_CHANGE, usesLines, type ExternalAppInfo, type MachineInfo, type ProjectInfo, type RpcResult } from '@cc/protocol'
import type { TrustRequest } from '../adapters/contract.js'
import type { HostCards } from './host-cards.js'
import { plainQuoted } from './tool-answers.js'
import { callWindow, type WindowRpc } from './window-rpc.js'

export type { TrustRequest }

export type TrustAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the trust commands reach of the session manager: its cards */
export type TrustFlowHost = Pick<HostCards, 'askHost'>

/** A name as one quoted line the person or the model reads (`plainQuoted`) */
const shown = (name: string): string => plainQuoted(name)

/** How many rows of a list name their items; the rest are counted */
const ROWS = 50

/** The first rows of a list, then how many more */
function rows<T>(items: readonly T[], line: (t: T) => string): string[] {
  return [...items.slice(0, ROWS).map(line), ...(items.length > ROWS ? [`- and ${items.length - ROWS} more`] : [])]
}

/** One rule as Settings lists it */
type ApprovalRuleRow = RpcResult<'approvals.rules'>[number]

/** The projects and machines as the window reads them, for naming and finding a project */
type Projects = { projects: ProjectInfo[]; machines: Map<string, string> }

/** One app of a project as the trust card names it: what it is, whether it is the project, what it may ask for */
function appLines(a: ExternalAppInfo): string[] {
  const title = a.name?.trim() ? a.name : a.appId
  const description = a.description?.trim() ? `: ${a.description.trim()}` : ''
  const out = [`- ${shown(title)} [${a.appId}]${description}`]
  if (a.root) out.push('  This project is this app: the orchestrator and your other projects can use it.')
  const asks = a.uses ? usesLines(a.uses) : []
  out.push(...(asks.length ? asks.map((l) => `  May ask to: ${l.charAt(0).toLowerCase()}${l.slice(1)}`) : ['  Asks for nothing beyond its own tools.']))
  return out
}

/** What a remembered consent of one project reaching another allows, in words */
function consentWords(kind: 'delegate' | 'apps' | 'agents'): string {
  return kind === 'delegate' ? 'start sessions in' : kind === 'apps' ? 'attach the apps of' : 'start agents in'
}

/** What a trust card covered of a project's apps: each one's id, whether it is the root, and what it may ask for */
const appsKey = (apps: readonly ExternalAppInfo[]): string =>
  JSON.stringify(apps.map((a) => [a.appId, !!a.root, a.uses ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))))

/**
 * The orchestrator's trust commands (#1219, third slice): what changes what agents and apps may do. Each is the window's
 * own call through the router (`projects.list`, `projects.setTrusted`, ...), so the host checks it as it checks the
 * window, and a linked machine's project is reached the way the window reaches it.
 *
 * **Widening waits for the person; narrowing does not.** Trusting a project lets its apps run and its setting files
 * apply, so it raises a card naming the project, its folder and each app with what it may ask for (the window's trust
 * card's words), every time, allow or deny only (`ORCHESTRATOR_CHANGE`). After Allow the project is read again: one
 * removed, already trusted, or whose apps changed while the card stood (a pull brought a manifest) is not what the card
 * named, and nothing is trusted. Taking trust away acts at once, as the window's switch does.
 */
export class TrustFlow {
  private rpc: WindowRpc | null = null

  constructor(private readonly host: TrustFlowHost) {}

  useRpc(rpc: WindowRpc): void {
    this.rpc = rpc
  }

  async run(sessionId: string, req: TrustRequest, signal?: AbortSignal): Promise<TrustAnswer> {
    const rpc = this.rpc
    if (!rpc) return { ok: false, error: 'This host has no window calls to make.' }
    try {
      switch (req.action) {
        case 'list_projects':
          return await this.listProjects(rpc)
        case 'project_trust':
          return await this.projectTrust(rpc, sessionId, req.project, req.trusted, signal)
        case 'list_rules':
          return await this.listRules(rpc, req.project)
        case 'remove_rule':
          return await this.removeRule(rpc, req.id)
        case 'list_app_grants':
          return await this.listAppGrants(rpc, req.app, req.project)
        case 'forget_app_answer':
          return await this.forgetAnswer(rpc, req.app, req.project, req.capability)
        case 'revoke_consent':
          return await this.revokeConsent(rpc, req.from, req.to, req.kind)
        case 'share_app':
          return await this.shareApp(rpc, sessionId, req.app, req.project, req.shared, signal)
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ── Projects ──

  private async projects(rpc: WindowRpc): Promise<Projects> {
    const [projects, machines] = await Promise.all([callWindow(rpc, 'projects.list', {}), callWindow(rpc, 'machines.list', {}).catch(() => [] as MachineInfo[])])
    return { projects, machines: new Map(machines.map((m) => [m.id, m.name])) }
  }

  /** Where a project is, when it is not on this computer */
  private where(p: { machine?: string | null }, machines: Map<string, string>): string {
    return p.machine ? ` on the linked machine ${shown(machines.get(p.machine) ?? p.machine)}` : ''
  }

  /** The project an argument names: its id, or its name when exactly one project has it */
  private find(all: Projects, named: string): { project: ProjectInfo } | { error: string } {
    const want = named.trim()
    if (!want) return { error: 'Give project: its name or id, from list_projects.' }
    const byId = all.projects.find((p) => p.id === want)
    if (byId) return { project: byId }
    const byName = all.projects.filter((p) => p.name.trim().toLowerCase() === want.toLowerCase())
    if (byName.length === 1) return { project: byName[0]! }
    if (byName.length > 1) {
      return { error: `${byName.length} projects are called ${shown(want)}: ${byName.map((p) => `${p.id}${this.where(p, all.machines)}`).join(', ')}. Give its id.` }
    }
    return { error: `No project is called ${shown(want)}; list_projects names them.` }
  }

  private async listProjects(rpc: WindowRpc): Promise<TrustAnswer> {
    const all = await this.projects(rpc)
    if (!all.projects.length) return { ok: true, text: 'No project is registered. add_project and create_project make one.' }
    const line = (p: ProjectInfo) => `- ${shown(p.name)} [${p.id}]${this.where(p, all.machines)}: ${shown(p.path)}; ${p.trusted ? 'trusted' : 'untrusted'}`
    return { ok: true, text: [`${all.projects.length} ${all.projects.length === 1 ? 'project' : 'projects'} (set_project_trust changes trust):`, ...rows(all.projects, line)].join('\n') }
  }

  /** The apps of one project, as the window's catalog groups them */
  private async appsOf(rpc: WindowRpc, p: ProjectInfo): Promise<ExternalAppInfo[]> {
    const apps = await callWindow(rpc, 'apps.list', {})
    return apps.filter((a) => a.projectId === p.id && (a.machine ?? null) === (p.machine ?? null))
  }

  private async projectTrust(rpc: WindowRpc, caller: string, named: string, trusted: boolean, signal?: AbortSignal): Promise<TrustAnswer> {
    const all = await this.projects(rpc)
    const found = this.find(all, named)
    if ('error' in found) return { ok: false, error: found.error }
    const p = found.project
    const label = `${shown(p.name)} [${p.id}]${this.where(p, all.machines)}`
    if (p.trusted === trusted) return { ok: true, text: `${label} is already ${trusted ? 'trusted' : 'untrusted'}; nothing changed.` }
    if (!trusted) {
      // Narrowing acts at once, as the window's switch does
      await callWindow(rpc, 'projects.setTrusted', { projectId: p.id, trusted: false })
      return {
        ok: true,
        text: `${label} is untrusted now: its apps stop and attach nowhere, and its agents stop reading the folder's own setting files (an idle session restarts for it now, a busy one when its turn ends). set_project_trust with trusted true asks the person to trust it again.`,
      }
    }
    const apps = await this.appsOf(rpc, p)
    const question = [
      `Trust the project ${shown(p.name)}${this.where(p, all.machines)} at ${shown(p.path)}?`,
      "Trusting lets this project's apps run and its settings apply: its agents read the folder's own setting files. Trust it only if you trust the code in this folder.",
      ...(apps.length ? [apps.length === 1 ? 'Its app:' : `Its ${apps.length} apps:`, ...apps.flatMap(appLines)] : ['It has no app.']),
    ].join('\n')
    const refused = await this.ask(caller, question, signal, 'trusted')
    if (refused) return { ok: false, error: refused }
    // What the card named, still? The project may have gone, been trusted, or gained or changed an app while it stood
    const now = (await this.projects(rpc)).projects.find((x) => x.id === p.id)
    if (!now) return { ok: false, error: `${label} was removed while the card stood, so nothing was trusted.` }
    if (now.trusted) return { ok: true, text: `${label} was trusted while the card stood; nothing more changed.` }
    if (appsKey(await this.appsOf(rpc, now)) !== appsKey(apps)) {
      return { ok: false, error: `The apps of ${label} changed while the card stood, so it is not what the card named and nothing was trusted. Ask again to show the person its apps as they are now.` }
    }
    await callWindow(rpc, 'projects.setTrusted', { projectId: p.id, trusted: true })
    return { ok: true, text: `${label} is trusted now: its apps may run and its settings apply.` }
  }

  // ── Approval rules ──
  //
  // A rule is a standing "always allow" the person gave on a card: removing one narrows what runs unasked, so it acts at
  // once, as Settings' delete does. There is no command that adds or widens one: the window has no such call either, and
  // a rule comes only from the person answering a card "always" (`ApprovalRules.rememberAlways`).

  /** The rules as Settings lists them (`approvals.rules`, linked machines' merged with their ids folded) */
  private async rules(rpc: WindowRpc): Promise<ApprovalRuleRow[]> {
    return callWindow(rpc, 'approvals.rules', {})
  }

  /** What a rule belongs to, by name: its project, or its session */
  private async owners(rpc: WindowRpc): Promise<{ all: Projects; sessions: Map<string, string> }> {
    const [all, sessions] = await Promise.all([this.projects(rpc), callWindow(rpc, 'sessions.list', {}).catch(() => [])])
    return { all, sessions: new Map(sessions.map((s) => [s.id, s.name])) }
  }

  private ruleLine(r: ApprovalRuleRow, o: { all: Projects; sessions: Map<string, string> }): string {
    const project = r.projectId ? o.all.projects.find((p) => p.id === r.projectId) : undefined
    const owner = r.sessionId
      ? `the session ${o.sessions.has(r.sessionId) ? `${shown(o.sessions.get(r.sessionId)!)} ` : ''}[${r.sessionId}]`
      : project
        ? `the project ${shown(project.name)} [${project.id}]`
        : r.projectId
          ? `a project no longer registered [${r.projectId}]`
          : 'nothing (it applies to no session)'
    const machine = r.machine ? ` on the linked machine ${shown(o.all.machines.get(r.machine) ?? r.machine)}` : ''
    return `- [${r.id}] ${r.decision} ${shown(r.matcher)} for ${owner}${machine}, since ${new Date(r.createdAt).toISOString().slice(0, 10)}`
  }

  private async listRules(rpc: WindowRpc, named?: string): Promise<TrustAnswer> {
    const [rules, o] = await Promise.all([this.rules(rpc), this.owners(rpc)])
    let shownRules = rules
    let of = ''
    if (named?.trim()) {
      const found = this.find(o.all, named)
      if ('error' in found) return { ok: false, error: found.error }
      shownRules = rules.filter((r) => r.projectId === found.project.id)
      of = ` of ${shown(found.project.name)}`
    }
    if (!shownRules.length) return { ok: true, text: `No approval rule${of}: every action that asks, asks.` }
    return {
      ok: true,
      text: [
        `${shownRules.length} approval ${shownRules.length === 1 ? 'rule' : 'rules'}${of}, each a standing answer the person gave on a card (remove_approval_rule removes one; adding one is the person's own "always" on a card):`,
        ...rows(shownRules, (r) => this.ruleLine(r, o)),
      ].join('\n'),
    }
  }

  private async removeRule(rpc: WindowRpc, id: number): Promise<TrustAnswer> {
    const [rules, o] = await Promise.all([this.rules(rpc), this.owners(rpc)])
    const rule = rules.find((r) => r.id === id)
    if (!rule) return { ok: false, error: `No approval rule has the id ${id}; list_approval_rules shows them.` }
    await callWindow(rpc, 'approvals.deleteRule', { id })
    return { ok: true, text: `Removed the approval rule ${this.ruleLine(rule, o).slice(2)}. That action asks again from now on (a running session takes it at its next start).` }
  }

  // ── App trust and grants ──
  //
  // An app's own trust follows its project's (#1141: a root app and its inner apps run when the project is trusted, and an
  // imported app is enabled by trusting its project), so trusting is `set_project_trust`. What is left: the answers the
  // person gave to an app's capability questions (forgetting one only makes it ask again), the remembered consents of one
  // project reaching another (revoking one makes the next reach ask again), and sharing a project app with the person's
  // other projects, which widens who can attach it and so asks.

  /** The app an argument names: its id or name, in the named project when one is given; refused when several match */
  private findApp(apps: readonly ExternalAppInfo[], all: Projects, named: string, project?: string): { app: ExternalAppInfo } | { error: string } {
    const want = named.trim().toLowerCase()
    if (!want) return { error: 'Give app: its id or name, from list_app_grants.' }
    let pool = apps
    if (project?.trim()) {
      const found = this.find(all, project)
      if ('error' in found) return { error: found.error }
      pool = apps.filter((a) => a.projectId === found.project.id && (a.machine ?? null) === (found.project.machine ?? null))
    }
    const byId = pool.filter((a) => a.appId.toLowerCase() === want)
    const matches = byId.length ? byId : pool.filter((a) => (a.name ?? '').trim().toLowerCase() === want)
    if (matches.length === 1) return { app: matches[0]! }
    if (!matches.length) return { error: `No app is called ${shown(named.trim())}${project ? ` in ${shown(project.trim())}` : ''}; list_app_grants names them.` }
    return { error: `${matches.length} apps are called ${shown(named.trim())}: ${matches.map((a) => this.appLabel(a, all)).join(', ')}. Give project too.` }
  }

  /** An app as one name: its title and id, and the project or user folder it is in */
  private appLabel(a: ExternalAppInfo, all: Projects): string {
    const title = a.name?.trim() ? a.name : a.appId
    const project = a.projectId ? all.projects.find((p) => p.id === a.projectId) : undefined
    const home = a.projectId ? (project ? `of the project ${shown(project.name)}` : `of the project [${a.projectId}]`) : 'in the user folder'
    return `${shown(title)} [${a.appId}] ${home}${this.where(a, all.machines)}`
  }

  /** The window's call for one app's remembered answers, routed to its machine as the window routes it */
  private on(a: ExternalAppInfo): { machine?: string } {
    return a.machine ? { machine: a.machine } : {}
  }

  private async listAppGrants(rpc: WindowRpc, named?: string, project?: string): Promise<TrustAnswer> {
    const [apps, all, consents] = await Promise.all([callWindow(rpc, 'apps.list', {}), this.projects(rpc), callWindow(rpc, 'projectConsents.list', {}).catch(() => [])])
    let pool = apps
    if (named?.trim()) {
      const found = this.findApp(apps, all, named, project)
      if ('error' in found) return { ok: false, error: found.error }
      pool = [found.app]
    } else if (project?.trim()) {
      const found = this.find(all, project)
      if ('error' in found) return { ok: false, error: found.error }
      pool = apps.filter((a) => a.projectId === found.project.id && (a.machine ?? null) === (found.project.machine ?? null))
    }
    const out: string[] = []
    for (const a of pool.slice(0, ROWS)) {
      const answers = await callWindow(rpc, 'apps.permissions', { appId: a.appId, projectId: a.projectId, ...this.on(a) }).catch(() => null)
      const sharing = a.root ? 'reached through its project\'s trust' : a.projectId ? (a.shared ? 'shared with your other projects' : 'not shared') : 'a user-folder app, available everywhere'
      out.push(`- ${this.appLabel(a, all)}: ${a.trusted ? 'trusted' : 'untrusted'}; ${sharing}`)
      if (answers === null) out.push('  Its remembered answers could not be read just now.')
      for (const p of answers ?? []) {
        out.push(`  ${p.decision === 'allow' ? 'Allowed' : 'Denied'}: ${shown(p.capability)} (${shown(p.text)}), since ${new Date(p.decidedAt).toISOString().slice(0, 10)}${p.current ? '' : '; no longer applies, its uses changed'}`)
      }
    }
    if (pool.length > ROWS) out.push(`- and ${pool.length - ROWS} more apps`)
    const lines = [
      pool.length ? `${pool.length} ${pool.length === 1 ? 'app' : 'apps'}, with the answers the person gave to what each asked for (forget_app_answer forgets one, so it asks again; share_app shares a project app):` : 'No app.',
      ...out,
    ]
    if (!named?.trim() && !project?.trim()) {
      lines.push(
        consents.length ? `${consents.length} remembered ${consents.length === 1 ? 'consent' : 'consents'} of one project reaching another (revoke_project_consent revokes one, so the next reach asks again):` : 'No remembered consent of one project reaching another.',
        ...rows(consents, (c) => `- ${shown(c.fromName)} [${c.fromProjectId}] may ${consentWords(c.kind)} ${shown(c.toName)} [${c.toProjectId}]${this.where(c, all.machines)}, since ${new Date(c.decidedAt).toISOString().slice(0, 10)}`),
      )
    }
    return { ok: true, text: lines.join('\n') }
  }

  private async forgetAnswer(rpc: WindowRpc, named: string, project: string | undefined, capability: string): Promise<TrustAnswer> {
    const [apps, all] = await Promise.all([callWindow(rpc, 'apps.list', {}), this.projects(rpc)])
    const found = this.findApp(apps, all, named, project)
    if ('error' in found) return { ok: false, error: found.error }
    const a = found.app
    const answers = await callWindow(rpc, 'apps.permissions', { appId: a.appId, projectId: a.projectId, ...this.on(a) })
    const answer = answers.find((p) => p.capability === capability.trim())
    if (!answer) return { ok: false, error: `${this.appLabel(a, all)} has no remembered answer for ${shown(capability.trim())}; list_app_grants names them.` }
    await callWindow(rpc, 'apps.forgetPermission', { appId: a.appId, projectId: a.projectId, capability: answer.capability, ...this.on(a) })
    return { ok: true, text: `Forgot the answer ${answer.decision === 'allow' ? 'allowing' : 'denying'} ${shown(answer.capability)} for ${this.appLabel(a, all)}: the next time it asks for that, the person is asked again.` }
  }

  private async revokeConsent(rpc: WindowRpc, from: string, to: string, kind: 'delegate' | 'apps' | 'agents'): Promise<TrustAnswer> {
    const [consents, all] = await Promise.all([callWindow(rpc, 'projectConsents.list', {}), this.projects(rpc)])
    const idOf = (named: string) => {
      const found = this.find(all, named)
      return 'error' in found ? null : found.project.id
    }
    const match = (named: string, id: string, name: string) => named.trim() === id || idOf(named) === id || name.trim().toLowerCase() === named.trim().toLowerCase()
    const hits = consents.filter((c) => c.kind === kind && match(from, c.fromProjectId, c.fromName) && match(to, c.toProjectId, c.toName))
    if (!hits.length) return { ok: false, error: `No remembered consent lets ${shown(from.trim())} ${consentWords(kind)} ${shown(to.trim())}; list_app_grants lists them.` }
    if (hits.length > 1) return { ok: false, error: `${hits.length} remembered consents match; give the project ids list_app_grants shows.` }
    const c = hits[0]!
    await callWindow(rpc, 'projectConsents.revoke', { fromProjectId: c.fromProjectId, toProjectId: c.toProjectId, kind: c.kind })
    return { ok: true, text: `Revoked: ${shown(c.fromName)} may no longer ${consentWords(c.kind)} ${shown(c.toName)} unasked; the next time it does, the person is asked again.` }
  }

  private async shareApp(rpc: WindowRpc, caller: string, named: string, project: string | undefined, shared: boolean, signal?: AbortSignal): Promise<TrustAnswer> {
    const [apps, all] = await Promise.all([callWindow(rpc, 'apps.list', {}), this.projects(rpc)])
    const found = this.findApp(apps, all, named, project)
    if ('error' in found) return { ok: false, error: found.error }
    const a = found.app
    const label = this.appLabel(a, all)
    if (!a.projectId) return { ok: false, error: `${label} is a user-folder app, available to every project already; it has no share switch.` }
    if (a.root) return { ok: false, error: `${label} is its project's root app: it is reached through its project's trust (set_project_trust) and has no share switch.` }
    if (!!a.shared === shared) return { ok: true, text: `${label} is already ${shared ? 'shared' : 'not shared'}; nothing changed.` }
    const ref = { appId: a.appId, projectId: a.projectId }
    if (!shared) {
      await callWindow(rpc, 'apps.setShared', { ...ref, shared: false })
      return { ok: true, text: `${label} is not shared any more: it is detached from every session of another project that attached it.` }
    }
    const asks = a.uses ? usesLines(a.uses) : []
    const question = [
      `Share the app ${label} with your other projects?`,
      'A session in another project can then find it and attach it (find_apps, attach_app), after you allow that pair of projects once.',
      ...(asks.length ? asks.map((l) => `It may ask to: ${l.charAt(0).toLowerCase()}${l.slice(1)}`) : ['It asks for nothing beyond its own tools.']),
    ].join('\n')
    const refused = await this.ask(caller, question, signal, 'shared')
    if (refused) return { ok: false, error: refused }
    // Still what the card named: the same app in the same project, not shared yet, asking for the same things
    const now = (await callWindow(rpc, 'apps.list', {})).find((x) => x.appId === a.appId && x.projectId === a.projectId && (x.machine ?? null) === (a.machine ?? null))
    if (!now) return { ok: false, error: `${label} was removed while the card stood, so nothing was shared.` }
    if (now.shared) return { ok: true, text: `${label} was shared while the card stood; nothing more changed.` }
    if (appsKey([now]) !== appsKey([a])) return { ok: false, error: `What ${label} may ask for changed while the card stood, so it is not what the card named and nothing was shared. Ask again to show the person what it asks for now.` }
    await callWindow(rpc, 'apps.setShared', { ...ref, shared: true })
    return { ok: true, text: `${label} is shared now: a session in another project can attach it once the person allows that pair of projects.` }
  }

  // ── The card ──

  /** The trust card, allow or deny only (`ORCHESTRATOR_CHANGE`): the refusal the orchestrator reads, or null once allowed */
  private async ask(sessionId: string, question: string, signal: AbortSignal | undefined, notDone: string): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return `The person did not approve it, so nothing was ${notDone}. Do not ask again unless they tell you to.`
    if (decision === null) return `The card was withdrawn before the person answered, so nothing was ${notDone}.`
    return null
  }
}
