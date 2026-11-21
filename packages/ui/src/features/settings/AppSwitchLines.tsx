import { Switch } from '../../components/Switch.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { useMachineName } from '../../store/selectors.js'

// The switches on a project app's row in Settings → Apps (`app_<flag>:` on the host, sessions/app-access.ts `AppFlag`);
// a user-folder app has neither. The store's actions are read when a switch flips.

/** One switch on the row: its label beside it, what it does in the title */
function SwitchLine({ on, set, label, title, testId }: { on: boolean; set: (on: boolean) => void; label: string; title: string; testId: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted" title={title} data-testid={testId}>
      <Switch checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/**
 * Sharing a project app with other projects (#371 part A), off by default: it is its project's own. When on, another
 * project's session can attach it while it needs the tools, once the person allows that pair of projects. No switch
 * for a user-folder app (every project has it) nor a root app (#1141: its project's trust already reaches the others).
 */
export function ShareLine({ app }: { app: ExternalCatalogApp }) {
  const { projectId, appId } = app
  if (projectId === null || app.info.root) return null
  return (
    <SwitchLine
      on={app.info.shared === true}
      set={(on) => void useStore.getState().setAppShared(projectId, appId, on)}
      label="Share with other projects"
      title="Sessions in your other projects can attach this app while they need it. Each project asks you once."
      testId="external-app-share"
    />
  )
}

/**
 * Whether a project app runs on its computer (#1938, docs/plans/remote-hub.md §13.7), on by default. Every checkout
 * registers the repository's apps, so a second computer runs a copy; off, it never starts there. Nothing infers that
 * two checkouts are one project, so the person says it per app, root apps too. It reads "on" only while the app runs
 * there; a linked machine's app is turned off on that machine, so the line names it.
 */
export function RunsHereLine({ app }: { app: ExternalCatalogApp }) {
  const machineName = useMachineName(app.info.machine)
  const { projectId, appId } = app
  if (projectId === null) return null
  const where = machineName ? `on ${machineName}` : 'on this computer'
  return (
    <SwitchLine
      on={app.info.off !== true}
      set={(on) => void useStore.getState().setAppOff(projectId, appId, !on)}
      label={`Runs ${where}`}
      title={`For a copy of an app that another computer runs for this project. Turned off, it does not start ${where} and no session ${machineName ? 'there' : 'here'} can use it.`}
      testId="external-app-runs-here"
    />
  )
}
