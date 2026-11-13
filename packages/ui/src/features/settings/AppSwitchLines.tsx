import { Switch } from '../../components/Switch.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { useMachineName } from '../../store/selectors.js'

/*
 * The switches on a project app's row in Settings → Apps, each a project app's own (`app_<flag>:` on the host,
 * sessions/app-access.ts `AppFlag`); a user-folder app has neither. The store's actions are read when a switch flips.
 */

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
 * Sharing a project app with the person's other projects (#371 part A) — off by default, because a
 * project app is that project's own. When on, a session in another project can find it and attach it
 * to itself for as long as it needs the tools, after the person allows that pair of projects once.
 * A user-folder app has no switch: it is the person's own and available to every project already. Nor has a root app
 * (#1141): it follows its project's trust, which already lets it reach the person's other projects (owner, 2026-10-18).
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
 * Whether a project app runs on its computer (#1938, docs/plans/remote-hub.md §13.7) — on by default. A repository that
 * carries an app registers it in every checkout, so a second computer with the project has a copy of an app the first
 * one runs. Turned off, the copy never starts and no session on its computer gets it. Nothing infers that two checkouts
 * are one project (owner), so the person says it, per project app; a root app too, since its copy is the same case.
 * The switch is on while the app runs there, so it never reads "on" for an app that is off. A linked machine's project
 * app is turned off on that machine, so the line names it.
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
