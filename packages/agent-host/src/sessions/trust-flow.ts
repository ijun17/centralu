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

  // ── The card ──

  /** The trust card, allow or deny only (`ORCHESTRATOR_CHANGE`): the refusal the orchestrator reads, or null once allowed */
  private async ask(sessionId: string, question: string, signal: AbortSignal | undefined, notDone: string): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return `The person did not approve it, so nothing was ${notDone}. Do not ask again unless they tell you to.`
    if (decision === null) return `The card was withdrawn before the person answered, so nothing was ${notDone}.`
    return null
  }
}
