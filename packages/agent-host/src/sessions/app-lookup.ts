import type { ExternalAppInfo, MachineInfo, ProjectInfo } from '@cc/protocol'
import { plainQuoted } from './tool-answers.js'
import { callWindow, type WindowRpc } from './window-rpc.js'

/**
 * How the orchestrator's commands find a project or an app by the words the model gives (#1219): the window's own lists
 * (`projects.list`, `machines.list`, `apps.list`) and the refusals that name the way to list them. Shared by the trust
 * commands and the app upkeep commands, so one name means the same thing to both.
 */

/** A name as one quoted line the person or the model reads (`plainQuoted`) */
export const shown = (name: string): string => plainQuoted(name)

/** The projects and machines as the window reads them, for naming and finding a project */
export type Projects = { projects: ProjectInfo[]; machines: Map<string, string>; away: string[] | null }

export async function readProjects(rpc: WindowRpc): Promise<Projects> {
  const [projects, machines] = await Promise.all([callWindow(rpc, 'projects.list', {}), callWindow(rpc, 'machines.list', {}).catch(() => null)])
  return {
    projects,
    machines: new Map((machines ?? []).map((m: MachineInfo) => [m.id, m.name])),
    // null: the linked machines could not be read, so whether a list is complete is not known either
    away: machines ? machines.filter((m) => m.status !== 'connected').map((m) => m.name) : null,
  }
}

/** A list's closing line when a linked machine is not connected: what it keeps is not in the list, and the list must not read as complete */
export function awayLine(all: Projects, what: string): string[] {
  if (all.away === null) return [`The linked machines could not be read just now, so ${what} on them may be missing.`]
  return all.away.length ? [`Not listed: ${what} on ${all.away.map(shown).join(', ')}, which ${all.away.length === 1 ? 'is' : 'are'} not connected just now.`] : []
}

/** Where a project is, when it is not on this computer */
export function whereText(p: { machine?: string | null }, machines: Map<string, string>): string {
  return p.machine ? ` on the linked machine ${shown(machines.get(p.machine) ?? p.machine)}` : ''
}

/** The project an argument names: its id, or its name when exactly one project has it */
export function findProject(all: Projects, named: string): { project: ProjectInfo } | { error: string } {
  const want = named.trim()
  if (!want) return { error: 'Give project: its name or id, from list_projects.' }
  const byId = all.projects.find((p) => p.id === want)
  if (byId) return { project: byId }
  const byName = all.projects.filter((p) => p.name.trim().toLowerCase() === want.toLowerCase())
  const only = byName[0]
  if (byName.length === 1 && only) return { project: only }
  if (byName.length > 1) {
    return { error: `${byName.length} projects are called ${shown(want)}: ${byName.map((p) => `${p.id}${whereText(p, all.machines)}`).join(', ')}. Give its id.` }
  }
  return { error: `No project is called ${shown(want)}; list_projects names them.` }
}

/** An app as one name: its title and id, and the project or user folder it is in */
export function appLabel(a: ExternalAppInfo, all: Projects): string {
  const title = a.name?.trim() ? a.name : a.appId
  const project = a.projectId ? all.projects.find((p) => p.id === a.projectId) : undefined
  const home = a.projectId ? (project ? `of the project ${shown(project.name)}` : `of the project [${a.projectId}]`) : 'in the user folder'
  return `${shown(title)} (id ${shown(a.appId)}) ${home}${whereText(a, all.machines)}`
}

/**
 * The app an argument names: its id or name, in the named project when one is given; refused when several match.
 * `listedBy` is the command that lists them, named in the refusal
 */
export function findApp(apps: readonly ExternalAppInfo[], all: Projects, named: string, project?: string, listedBy = 'list_app_grants'): { app: ExternalAppInfo } | { error: string } {
  const want = named.trim().toLowerCase()
  if (!want) return { error: `Give app: its id or name, from ${listedBy}.` }
  let pool = apps
  if (project?.trim()) {
    const found = findProject(all, project)
    if ('error' in found) return { error: found.error }
    pool = apps.filter((a) => a.projectId === found.project.id && (a.machine ?? null) === (found.project.machine ?? null))
  }
  const byId = pool.filter((a) => a.appId.toLowerCase() === want)
  const matches = byId.length ? byId : pool.filter((a) => (a.name ?? '').trim().toLowerCase() === want)
  const only = matches[0]
  if (matches.length === 1 && only) return { app: only }
  if (!matches.length) return { error: `No app is called ${shown(named.trim())}${project ? ` in ${shown(project.trim())}` : ''}; ${listedBy} names them.` }
  return { error: `${matches.length} apps are called ${shown(named.trim())}: ${matches.map((a) => appLabel(a, all)).join(', ')}. Give project too.` }
}

/** The window's call for one app, routed to its machine as the window routes it */
export function onMachine(a: ExternalAppInfo): { machine?: string } {
  return a.machine ? { machine: a.machine } : {}
}
