// Displayed names, pure so the store's own code says them as the hooks in `selectors.ts` do. One fallback per concept.

export function appTitleOf(app: { name?: string | null; appId: string }): string {
  return app.name ?? app.appId
}

// One wording for the inbox, the palette and the message picker (#428).
export function projectLabelOf(projects: Readonly<Record<string, { name: string }>>, projectId: string | null): string {
  return (projectId ? projects[projectId]?.name : 'Assistant') ?? ''
}

export function machineNameOf(machines: Readonly<Record<string, { name: string }>>, machine: string): string {
  return machines[machine]?.name ?? machine
}

// The linked machine a project lives on, or null for this computer
export function projectMachineOf(projects: Readonly<Record<string, { machine?: string | null }>>, projectId: string | null | undefined): string | null {
  return projectId ? (projects[projectId]?.machine ?? null) : null
}
