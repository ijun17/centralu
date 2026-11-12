/**
 * The names the screen shows for an app, a project and a machine, and the machine a project lives on: pure, so the
 * store's own code says them as the hooks in `selectors.ts` do. One fallback per concept: an app without a name shows
 * its id, a machine the list does not hold (yet) shows its id, and a project it does not hold shows nothing.
 */

/** An app's title: its name, or its id for one that has none */
export function appTitleOf(app: { name?: string | null; appId: string }): string {
  return app.name ?? app.appId
}

/**
 * What names the project of a row beside it: the project's name, "Assistant" for a session that has none, and nothing
 * for a project the list does not hold (yet). The inbox, the palette and the message picker said it three ways (#428).
 */
export function projectLabelOf(projects: Readonly<Record<string, { name: string }>>, projectId: string | null): string {
  return (projectId ? projects[projectId]?.name : 'Assistant') ?? ''
}

/** A machine's name as the person gave it, or its id until the machine list arrives */
export function machineNameOf(machines: Readonly<Record<string, { name: string }>>, machine: string): string {
  return machines[machine]?.name ?? machine
}

/** The linked machine a project lives on (#82), or null for this computer */
export function projectMachineOf(projects: Readonly<Record<string, { machine?: string | null }>>, projectId: string | null | undefined): string | null {
  return projectId ? (projects[projectId]?.machine ?? null) : null
}
