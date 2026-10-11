import { useMemo } from 'react'
import { remoteIdeSupport, remoteIdeUrl } from '@cc/core'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

export type RemoteIde = {
  /** What the button says: it is VS Code specifically, unlike this computer's "Open in IDE" */
  label: string
  /** Its tooltip: where the file opens, and through what */
  title: string
  /** `rel` is project-relative (`''` is the project itself); `file` is given for a file, with its line when known */
  open(rel: string, file?: { line?: number | null }): Promise<void>
}

/**
 * "Open in VS Code" for a project on a linked machine (#82, docs/plans/remote-hub.md §6): a Remote-SSH link to the
 * machine's own path (`remoteIdeUrl` in core), opened through the platform port like any other link.
 *
 * Null for this computer's projects, which keep their own IDE and file manager actions, and for a machine VS Code
 * cannot reach this way (a WSL distro behind Windows' ssh, a target a link cannot carry): the button is not drawn, so
 * nobody presses one that cannot work. The reason is in `remoteIdeSupport` and in the plan.
 */
export function useRemoteIde(projectId: string | null | undefined): RemoteIde | null {
  const platform = usePlatform()
  const machineId = useStore((s) => (projectId ? (s.projects[projectId]?.machine ?? null) : null))
  // The project's root as its own machine spells it: the hub passes a remote project's path through untouched
  const root = useStore((s) => (projectId ? s.projects[projectId]?.path : undefined))
  const machine = useStore((s) => (machineId ? s.machines[machineId] : undefined))
  const setToast = useStore((s) => s.setToast)

  return useMemo(() => {
    if (root === undefined || !machine || !remoteIdeSupport(machine).ok) return null
    return {
      label: 'Open in VS Code',
      title: `Opens it on ${machine.name} in VS Code, over Remote-SSH to ${machine.sshTarget}`,
      async open(rel, file) {
        const target = remoteIdeUrl(machine, root, rel, file)
        if (!target.ok) return setToast(`Could not open in VS Code: ${target.reason}`)
        try {
          await platform.system.openUrl(target.url)
        } catch (e) {
          setToast(`Could not open in VS Code: ${(e as Error).message}`)
        }
      },
    }
  }, [platform, root, machine, setToast])
}
