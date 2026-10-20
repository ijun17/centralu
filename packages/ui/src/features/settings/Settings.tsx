import { TrustProjectButton } from '../project/TrustCard.jsx'
import { usePresence } from '../../components/presence.js'
import { useEffect, useRef, useState } from 'react'
import { MAX_AGENT_DEPTH, MAX_AUTO_COMPACT_SHARE, MIN_AUTO_COMPACT_SHARE, agentDepthOf, autoCompactOf, hubAutoOf, type ToolName, type ToolStatus, type UiPreferencesPatch } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, appKeyOf, explainGridSpan, type NotifyPolicy } from '@cc/core'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useMachineName, useTools } from '../../store/selectors.js'
import { useNavShortcut, useShortcut } from '../../app/shortcut.js'
import { isPlainEscape } from '../../app/keys.js'
import { useDialogFocus } from '../../components/dialogFocus.js'
import { Kbd } from '../../components/primitives.jsx'
import { useLoad } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { InlineConfirm } from '../../components/InlineConfirm.jsx'
import { Modal } from '../../components/Modal.jsx'
import { Badge } from '../../components/Badge.jsx'
import { Button } from '../../components/Button.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { useFocusReturn } from '../../components/focusReturn.js'
import { useAppCatalog, type ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppSecrets, missingSecrets } from '../pinned-app/AppSecrets.jsx'
import { SpanButton } from '../../components/SpanPicker.jsx'
import { TrashSection } from './TrashSection.jsx'
import { ProjectConsentsSection } from './ProjectConsentsSection.jsx'
import { SettingToggle } from './SettingToggle.jsx'
import { GrantList } from './GrantList.jsx'
import { ThemeSection } from './ThemeSection.jsx'
import { TypographySection } from './TypographySection.jsx'
import { AgentCliUpdates, UpdatesSection } from './UpdatesSection.jsx'
import { SleepSection } from './SleepSection.jsx'
import { MachinesSection } from './MachinesSection.jsx'
import { AgentModelsSection } from './AgentModelsSection.jsx'
import type { BackgroundPort } from '@cc/platform/ports'

type Rule = {
  id: number
  scope: string
  matcher: string
  decision: string
  createdAt: number
  projectId?: string | null
  sessionId?: string | null
}

/**
 * The name of a rule's owner (#183). While a rule only carried a matcher, scope and date,
 * clicking "always allow" on the same command in two different projects produced two
 * identical-looking rows with no way to tell which belonged to which project. A session-scoped
 * rule uses the session name. A rule whose project or session has already been deleted says so
 * — leaving it blank would make it indistinguishable again.
 */
function RuleOwner({ rule }: { rule: Rule }) {
  const name = useStore((s) =>
    rule.scope === 'project'
      ? rule.projectId
        ? (s.projects[rule.projectId]?.name ?? null)
        : null
      : rule.sessionId
        ? (s.sessions[rule.sessionId]?.name ?? null)
        : null,
  )
  const known = rule.scope === 'project' ? rule.projectId : rule.sessionId
  if (!known) return null
  return (
    <span className="min-w-0 truncate text-2xs text-ink-muted" data-testid={`rule-owner-${rule.id}`}>
      {name ?? (rule.scope === 'project' ? 'removed project' : 'removed session')}
    </span>
  )
}

/**
 * FR-17 shortcut table — has to be viewable and checkable from Settings.
 *
 * A combination is written **by meaning**: `'mod'` and `'alt'` get named by this machine's own
 * keyboard (`⌘`/`Ctrl`, `⌥`/`Alt`), and the remaining pieces are the key's own name as is
 * (issue #32).
 *
 * The desktop app's shortcut table shows **this machine's own keyboard**, right now. There is
 * no other answer — the keys written here are pressed on this machine, and listing both sets
 * would only cost time finding the one that actually applies.
 */
const SHORTCUTS: [string[], string][] = [
  [['mod', 'I'], 'Waiting'],
  // `⇧` is printed on those keyboards too, so there is no word to translate it into. Attaching
  // it to the following key reads better than `Ctrl+⇧+A`
  [['mod', '⇧A'], 'Jump to next waiting'],
  [['mod', 'K'], 'Command palette'],
  [['mod', '1~9'], 'Jump to project'],
  /*
   * The digits name tab *identities*, not positions (EvidencePanel's handler) — after a
   * drag-reorder this list stays true, which is the whole reason identity was chosen.
   * The names listed here were once "chat · files · git · viewer": tabs that predate the
   * three-lane layout. Nobody noticed because the shortcut itself didn't exist until #20.
   */
  [['mod', '⇧1~4'], 'Panel tab (changes · history · files · terminal)'],
  [['y / n / a'], 'Approve · deny · always allow'],
  [['alt', 'a'], 'Always allow (project scope)'],
  // In the composer y/n/a are letters of the message; these answer the card from there (ApprovalCard's APPROVAL_COMBOS)
  [['mod', '⇧Y'], 'Approve, while typing in the composer'],
  [['mod', '⇧D'], 'Deny, while typing in the composer'],
  [['mod', '⇧L'], 'Always allow, while typing in the composer'],
  [['d'], 'Dismiss from inbox'],
  [['j / k'], 'Move in inbox'],
  [['Enter / Esc'], 'Send · close'],
]

/**
 * The window's categories.
 *
 * Named after the errand someone arrives with, not after the module that implements the
 * setting: people come here to stop being pinged, to take back an always-allow they regret,
 * or to look up a key. Naming by module would put the next setting wherever its code lives,
 * which is the one thing the person looking for it cannot know.
 *
 * A category per setting reads worse than no categories at all, so a new one has to earn its
 * place by having somewhere to belong — quiet hours land in Notifications, a default preset
 * in Permissions, rebinding in Shortcuts.
 *
 * **Updates is the fourth, and it earned it** (issue #43). The rule above is what admits it:
 * asked which of the other three should hold "check for updates automatically", every answer
 * is wrong. Notifications is about how the app interrupts *you about agents*; putting the
 * registry in there renames the category. Permissions is what agents may do without asking.
 * Shortcuts is a key table. And it has room to grow the way the others do — a release
 * channel, skipping a version, the build this is running — which is the difference between a
 * category and a drawer with one thing in it.
 *
 * It also passes the naming rule: people arrive here asking "am I on the latest?", which is
 * an errand, not a module.
 */
const CATEGORIES = [
  /*
   * The orchestrator belongs here because it is **the one thing the installation has only one
   * of**.
   *
   * Switching agents used to live in the session settings menu, and was removed from there —
   * because the conversation does not carry over, "switching" there meant the same thing as
   * "starting a new conversation," which creating a new session already does more honestly.
   * The orchestrator is the one exception, for a single reason: since the app has only one,
   * "create a new one with a different tool" does not make sense.
   *
   * And the intro screen was already pointing here ("You can change this later in Settings") —
   * a promise that had gone unkept until now.
   */
  { id: 'orchestrator', label: 'Orchestrator' },
  // An experimental feature is an app (#81) — there has to be a place to turn it on and off for "unused, it disappears" to hold true
  { id: 'apps', label: 'Apps' },
  { id: 'notifications', label: 'Notifications' },
  /*
   * Whether quitting leaves agents running (#280). Its own category because the question people
   * arrive with is "what happens to my agents when I quit?", and the answer is one switch plus
   * what it costs. That switch shows only where the platform can do it (the desktop app's keeper);
   * the category shows everywhere since #568, for "what happens to my agents when I leave them
   * idle", which every host answers.
   */
  { id: 'background', label: 'Background' },
  /*
   * Linked machines (#82). Its own category because the errand is its own: "link my server", "why is it away". It
   * holds a list, a form and a prompt, which no other category could take without renaming itself.
   */
  { id: 'machines', label: 'Machines' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'permissions', label: 'Permissions' },
  // Deleted sessions (#204) — the only place a conversation is deleted for good, so it has a place of its own
  { id: 'trash', label: 'Trash' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'updates', label: 'Updates' },
] as const

type Category = (typeof CATEGORIES)[number]['id']

/**
 * Settings (E-3, E-4, E-5).
 * Notification policy and approval rules are **only half done if they save but cannot be seen**
 * — they are viewed and deleted here.
 *
 * One category at a time, chosen from the rail on the left. The sections used to stack into
 * a single scroll, which reads fine at three and stops reading the moment there are eight —
 * and settings only ever arrive. Choosing where a thing goes is a decision made once, here;
 * scrolling past everything else is a cost paid on every visit.
 */
export function Settings() {
  const open = useStore((s) => s.settingsOpen)
  // Closing gives the keyboard back to where it was, the composer included (#115)
  const toggle = useStore((s) => s.toggleSettings)
  const policy = useStore((s) => s.notifyPolicy)
  const setPolicy = useStore((s) => s.setNotifyPolicy)
  const platform = usePlatform()
  const sc = useShortcut()
  const nav = useNavShortcut()
  const [category, setCategory] = useState<Category>('notifications')
  // Another screen asked for a category (a machine's badge in the sidebar opens Machines, #82, #734)
  const request = useStore((s) => s.settingsRequest)
  useEffect(() => {
    const asked = CATEGORIES.find((c) => c.id === request?.category)
    if (asked) setCategory(asked.id)
  }, [request])

  // Read each time settings open. A failed read says so: it used to be drawn as "No saved rules" (#850 item 8)
  const rules = useLoad(() => (open ? platform.rules.list() : null), [open, platform])

  useEffect(() => {
    if (!open) return
    // Not the Esc that cancels a composition in one of its fields (a font name, a machine) (#181)
    const onKey = (e: KeyboardEvent) => isPlainEscape(e) && toggle(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, toggle])

  // A dialog to the keyboard and to a screen reader: focus starts inside and Tab stays there (#842 item 7)
  const panelRef = useRef<HTMLDivElement>(null)
  // Leaves with its exit (usePresence below), so focus inside it is given back as it closes (#115)
  useFocusReturn(open, panelRef)
  const dialog = useDialogFocus(panelRef, open)

  // Comes down and fades in, and goes the same way (usePresence keeps it for its exit)
  const { shown, leaving } = usePresence(open)
  if (!shown) return null

  return (
    <div
      className={`absolute inset-0 z-40 flex items-start justify-center bg-scrim pt-[calc(8vh/var(--text-zoom))] backdrop-blur-[2px] ${
        leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'
      }`}
      onClick={() => toggle(false)}
      data-testid="settings"
      // Leaving, it takes no keys and no focus (focusReturn.ts)
      inert={leaving}
    >
      <div
        ref={panelRef}
        {...dialog}
        className={`flex max-h-[calc(80vh/var(--text-zoom))] w-[640px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal) outline-none ${
          leaving ? 'cc-drop-out' : 'cc-drop'
        }`}
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-panel"
      >
        <header className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-md font-medium text-ink">Settings</h2>
          <span className="ml-auto text-2xs text-ink-faint">
            <Kbd>esc</Kbd> Close
          </span>
        </header>

        <div className="flex min-h-0 flex-1">
          {/*
            The rail is the index. It says what this window holds without opening anything,
            which a scroll can only do by being short — and it will not stay short.
          */}
          <nav
            className="w-[132px] shrink-0 space-y-0.5 border-r border-line p-2"
            data-testid="settings-nav"
            aria-label="Settings categories"
          >
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid={`settings-tab-${c.id}`}
                aria-current={c.id === category ? 'page' : undefined}
                onClick={() => setCategory(c.id)}
                className={`w-full rounded-md px-2 py-1 text-left text-sm transition-colors ${
                  c.id === category ? 'bg-surface-selected text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {c.label}
              </button>
            ))}
          </nav>

          {/*
            Only the chosen category is built. Hiding the rest instead would keep the whole
            window's worth of controls in the page — and a control that is present but unseen
            is one a test can pass on and a screen reader can walk into.
          */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="settings-pane">
            {category === 'orchestrator' && <OrchestratorSettings />}
            {category === 'apps' && <AppsSettings />}
            {/* E-5 notification policy */}
            {category === 'notifications' && (
              <section>
                <p className="text-xs leading-body text-ink-faint">
                  Notifications are the only way to force attention, so use them sparingly.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {(
                    [
                      ['approval', 'Awaiting approval — when an agent is blocked'],
                      ['error', 'Error'],
                      ['done', 'A session finishes out of sight'],
                      ['allDone', 'Once when every session finishes'],
                      ['whenFocused', 'Notify even when the app is focused'],
                      ['sound', 'Play a sound — the one signal that reaches the next room'],
                    ] as [keyof NotifyPolicy, string][]
                  ).map(([key, label]) => (
                    <li key={key}>
                      <SettingToggle
                        checked={policy[key]}
                        onChange={(on) => setPolicy({ ...policy, [key]: on })}
                        label={label}
                        testId={`notify-${key}`}
                      />
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
                    onClick={() => setPolicy(DEFAULT_NOTIFY_POLICY)}
                  >
                    Reset to defaults
                  </button>
                </div>
              </section>
            )}

            {category === 'background' && (
              <>
                {platform.background && <BackgroundSection port={platform.background} />}
                <SleepSection first={!platform.background} />
              </>
            )}

            {category === 'machines' && <MachinesSection onOpenCategory={setCategory} />}

            {category === 'appearance' && <AppearanceSection />}

            {/* E-4 approval rules */}
            {category === 'permissions' && (
              <section>
                <p className="text-xs leading-body text-ink-faint">
                  Pressing <Kbd>a</Kbd> on an approval adds an always-allow rule here. Delete any of them
                  anytime.
                </p>
                <GrantList
                  load={rules}
                  keyOf={(r) => String(r.id)}
                  row={(r) => (
                    <>
                      <code className="truncate font-mono text-sm text-ink">{r.matcher}</code>
                      <span className="shrink-0 text-2xs text-ink-faint">
                        {r.scope === 'project' ? 'Project' : 'Session'}
                      </span>
                      <RuleOwner rule={r} />
                    </>
                  )}
                  dateOf={(r) => r.createdAt}
                  action={{ label: 'Delete', failed: 'Could not delete it', testId: (r) => `delete-rule-${r.id}`, run: (r) => platform.rules.remove(r.id) }}
                  what="the rules"
                  empty="No saved rules"
                  testIds={{ list: 'rules-list', empty: 'rules-empty', failed: 'rules-failed', error: 'rules-error' }}
                />
                <ProjectConsentsSection />
              </section>
            )}

            {category === 'trash' && <TrashSection />}

            {/* E-3 shortcuts */}
            {category === 'shortcuts' && (
              <section>
                <ul className="grid grid-cols-2 gap-x-6 gap-y-1" data-testid="shortcut-list">
                  {SHORTCUTS.map(([keys, label]) => (
                    <li key={label} className="flex items-baseline gap-2 text-sm text-ink-muted">
                      <Kbd>{sc(...keys)}</Kbd>
                      <span className="truncate">{label}</span>
                    </li>
                  ))}
                  {/* Back and forward (#374): this keyboard's browser keys, not a fixed combination (`navShortcut`) */}
                  <li className="flex items-baseline gap-2 text-sm text-ink-muted">
                    <Kbd>{`${nav(-1)} / ${nav(1)}`}</Kbd>
                    <span className="truncate">Back · forward between screens</span>
                  </li>
                </ul>
              </section>
            )}

            {/* Updates (issue #43) */}
            {category === 'updates' && (
              <>
                <UpdatesSection />
                <AgentCliUpdates />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The app list (M4 A-8) — one row per external app, with a status and a reason per scope
 * (project or user folder). An app from an untrusted project, and a broken app, are not hidden
 * either. Hiding one would leave no way to ask why it is not showing up.
 *
 * Built-in apps used to stand at the top of this list with an on/off toggle each; the only one,
 * the control rail, was removed in #97.
 */
function AppsSettings() {
  const catalog = useAppCatalog()
  const projects = useStore((s) => s.projects)
  const projectIds = Object.keys(catalog.byProject)
  return (
    <section data-testid="settings-apps">
      <p className="text-xs leading-body text-ink-faint">
        Apps found in your projects and your own apps folder, and how each one is doing.
      </p>
      {catalog.external.length === 0 && (
        <p className="mt-3 text-xs leading-body text-ink-muted" data-testid="settings-apps-empty">
          No apps yet.
        </p>
      )}
      {catalog.external.length > 0 && (
        <div className="mt-3" data-testid="settings-external-apps">
          {projectIds.map((pid) => (
            <div key={pid} className="mb-4">
              {/* The host removes a deleted project's apps from the list. The moment its name cannot be found is only the one tick before the list catches up */}
              <Badge as="p" readout>
                {projects[pid]?.name ?? 'Project'}
              </Badge>
              <ul className="mt-2 space-y-2">
                {catalog.byProject[pid]!.map((a) => (
                  <ExternalAppRow key={a.key} app={a} />
                ))}
              </ul>
            </div>
          ))}
          {catalog.user.length > 0 && (
            <div className="mb-4">
              <Badge as="p" readout>
                Other apps
              </Badge>
              <ul className="mt-2 space-y-2">
                {catalog.user.map((a) => (
                  <ExternalAppRow key={a.key} app={a} />
                ))}
              </ul>
            </div>
          )}
          {/* Each linked machine's own apps (#82), under its name: what is done to one here is done on that machine */}
          {Object.keys(catalog.byMachine).map((machine) => (
            <MachineAppsGroup key={machine} machine={machine} apps={catalog.byMachine[machine]!} />
          ))}
        </div>
      )}
    </section>
  )
}

/** A linked machine's user-folder apps (#82), named by the machine */
function MachineAppsGroup({ machine, apps }: { machine: string; apps: ExternalCatalogApp[] }) {
  const name = useMachineName(machine) ?? machine
  return (
    <div className="mb-4" data-testid={`settings-machine-apps-${machine}`}>
      <Badge as="p" readout>
        {name}’s apps
      </Badge>
      <ul className="mt-2 space-y-2">
        {apps.map((a) => (
          <ExternalAppRow key={a.key} app={a} />
        ))}
      </ul>
    </div>
  )
}

/**
 * A single row for an external app — what it is, its current state, and why. An app from an
 * untrusted project gets a trust button right there. If only the reason is shown and the person
 * has to go all the way to the project menu to find something to do about it, showing the
 * reason is only half the point.
 *
 * An app in the user folder is removed right here (M4 A-7). Now that an approved MCP server has
 * become a viewless app, "revoking" it, which the old registry had no place for, becomes this
 * one row. Since it is hard to undo, it asks once. What stays and what disappears is said in the
 * same place. A project app has no such button — it is a file in the repository, so the place
 * to remove it is git, and the host refuses to do it too.
 */
function ExternalAppRow({ app }: { app: ExternalCatalogApp }) {
  const { status } = app
  const stopApp = useStore((s) => s.stopApp)
  // Kept running for background work (#1236): what for, and Stop, as on its sidebar row
  const busy = app.info.status === 'running' ? (app.info.busy ?? null) : null
  const toggleSettings = useStore((s) => s.toggleSettings)
  const openApp = useStore((s) => s.openApp)
  const removeUserApp = useStore((s) => s.removeUserApp)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  // A linked machine's user-folder app (#82): removed there, so the question names the machine
  const machineName = useMachineName(app.projectId === null ? app.info.machine : null)
  return (
    <li className="rounded-md border border-line bg-surface-raised px-3 py-2" data-testid={`external-app-${app.key}`} data-status={app.info.status}>
      <div className="flex items-center gap-2 text-sm text-ink">
        <span className="truncate">{app.title}</span>
        <span className="readout text-2xs text-ink-faint">{app.appId}</span>
        <span
          className={`readout ml-auto shrink-0 text-2xs ${status.tone === 'alert' ? 'text-ink' : 'text-ink-faint'}`}
          data-testid="external-app-status"
        >
          {status.label}
        </span>
      </div>
      {busy && (
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-muted" data-testid="external-app-busy">
          <span className="min-w-0 truncate">Running: {busy}</span>
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink"
            onClick={() => void stopApp({ key: app.key, appId: app.appId, projectId: app.projectId, machine: app.info.machine ?? null })}
            data-testid="external-app-stop"
          >
            Stop
          </button>
        </div>
      )}
      {status.reason && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-body text-ink-muted" data-testid="external-app-reason">
          {status.reason}
        </p>
      )}
      {app.info.status === 'untrusted' && app.projectId && (
        // The same card as the project's row, with its apps listed (#1141)
        <TrustProjectButton projectId={app.projectId} testId="external-app-trust" className="mt-1.5" />
      )}
      {/* An imported app (M4 E-3) — where it came from, and, if it is waiting on the person's confirmation, the path to that confirmation */}
      {app.info.imported && (
        <p className="mt-1 break-words text-xs text-ink-faint" data-testid="external-app-imported">
          Imported from {app.info.imported.source}
        </p>
      )}
      {app.info.status === 'unconfirmed' && (
        <Button
          variant="primary"
          onRaised
          size="sm"
          className="mt-1.5"
          onClick={() => {
            toggleSettings(false)
            openApp(app.projectId, app.appId)
          }}
          data-testid="external-app-review"
        >
          Review and enable…
        </Button>
      )}
      <SecretsLine app={app} />
      <ShareLine app={app} />
      <GridSpanLine app={app} />
      {/* Another machine's user-folder app (#82) is removed on that machine: `machine` names it, so this computer's app of the same id is never touched */}
      {app.projectId === null &&
        (confirming ? (
          <InlineConfirm
            text={
              machineName
                ? `Remove ${app.title} from ${machineName}? Its folder moves to the app trash there and agents there lose its tools. Its run records stay. Apps on this computer are not touched.`
                : `Remove ${app.title}? Its folder moves to the app trash and agents lose its tools. Its run records stay.`
            }
            yesLabel="Remove"
            busy={removing}
            onYes={() => {
              setRemoving(true)
              // Busy until the row is gone: it goes with the host's rebroadcast, so a success leaves the button off
              void removeUserApp(app.appId, app.info.machine).then((ok) => {
                if (ok) return
                setRemoving(false)
                setConfirming(false)
              })
            }}
            onNo={() => setConfirming(false)}
            testId="external-app-remove-confirm"
            yesTestId="external-app-remove-yes"
            noTestId="external-app-remove-cancel"
          />
        ) : (
          <button
            type="button"
            className="mt-1.5 rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink-signal"
            onClick={() => setConfirming(true)}
            data-testid="external-app-remove"
          >
            Remove…
          </button>
        ))}
    </li>
  )
}

/**
 * Secrets within an app's row (M4 E) — appears only for an app that declares secrets. Even
 * collapsed, it states how many are unset: someone in Settings looking for why an app is not
 * coming up because of a missing key needs to see what is missing before expanding the row. The
 * slot is the same panel as the pinned view (`AppSecrets`).
 */
/**
 * The app's panel size on the grid, in cells (#306) — the person's default for every placement of this app that has
 * no size of its own from the panel's top bar. Without one, the app's recommendation (its manifest's `view.span`)
 * applies, else 1 × 1; the "default" line in the picker names which. Only an app with a view: nothing else has a panel
 * worth sizing.
 */
function GridSpanLine({ app }: { app: ExternalCatalogApp }) {
  const setting = useStore((s) => s.appSpans[appKeyOf(app.projectId, app.appId, app.info.machine)])
  const setAppSpan = useStore((s) => s.setAppSpan)
  if (!app.info.home) return null
  const current = explainGridSpan(undefined, setting, app.info.span)
  const fallback = explainGridSpan(undefined, undefined, app.info.span)
  return (
    <div className="mt-1.5 flex items-center gap-2 px-1 text-xs text-ink-faint">
      <span>Size on the grid</span>
      <SpanButton
        value={current.span}
        chosen={current.from === 'setting'}
        fallback={{ span: fallback.span, label: fallback.from === 'app' ? 'as the app recommends' : 'one cell' }}
        onPick={(span) => setAppSpan(app.projectId, app.appId, span, app.info.machine)}
        testId="external-app-span"
        title="Panel size in grid cells"
      />
    </div>
  )
}

/**
 * Sharing a project app with the person's other projects (#371 part A) — off by default, because a
 * project app is that project's own. When on, a session in another project can find it and attach it
 * to itself for as long as it needs the tools, after the person allows that pair of projects once.
 * A user-folder app has no switch: it is the person's own and available to every project already. Nor has a root app
 * (#1141): it follows its project's trust, which already lets it reach the person's other projects (owner, 2026-10-18).
 */
function ShareLine({ app }: { app: ExternalCatalogApp }) {
  const setShared = useStore((s) => s.setAppShared)
  if (app.projectId === null || app.info.root) return null
  const shared = app.info.shared === true
  return (
    <label
      className="mt-1.5 flex cursor-pointer items-center gap-2 px-1 text-xs text-ink-faint"
      title="Sessions in your other projects can attach this app while they need it. Each project asks you once."
      data-testid="external-app-share"
    >
      <input
        type="checkbox"
        className="accent-ink-muted"
        checked={shared}
        onChange={(e) => void setShared(app.projectId!, app.appId, e.target.checked)}
      />
      <span>Share with other projects</span>
    </label>
  )
}

function SecretsLine({ app }: { app: ExternalCatalogApp }) {
  const [open, setOpen] = useState(false)
  const count = app.info.secrets?.length ?? 0
  if (count === 0) return null
  const missing = missingSecrets(app)
  return (
    <div className="mt-1.5">
      <button
        type="button"
        className={`rounded-md px-1 py-0.5 text-xs transition-colors hover:text-ink ${missing ? 'text-ink' : 'text-ink-faint'}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="external-app-secrets-toggle"
      >
        {missing ? `Secrets · ${missing} of ${count} missing` : `Secrets · ${count} set`}
      </button>
      {open && (
        <div className="mt-1.5">
          <AppSecrets app={app} />
        </div>
      )}
    </div>
  )
}

/**
 * Approved orchestrator skills (#71). Why this exists here: "a skill that can only be added,
 * with no way to view or delete it, is worse than not having it at all" — approval happens in
 * the card next to the conversation, management happens in Settings. Deleting one restarts the
 * orchestrator through the host, so it drops out of the prompt immediately too.
 */
export function OrchestratorSkills() {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const loaded = useLoad(() => platform.agents.orchestratorSkills(), [platform])
  const skills = loaded.data?.skills ?? []
  const load = () => void loaded.reload()

  // A list that could not be read is said, not hidden (#841): hidden, it read as "no skills approved", and one approved
  // could no longer be found to delete
  if (skills.length === 0 && loaded.error === null) return null
  return (
    <div className="mt-5 border-t border-line pt-3" data-testid="orchestrator-skills">
      <Badge as="p" readout>
        Approved skills
      </Badge>
      {loaded.error !== null && (
        <LoadFailed what="the approved skills" error={loaded.error} onRetry={load} className="mt-2" testId="orchestrator-skills-failed" />
      )}
      <ul className="mt-2 space-y-2">
        {skills.map((s) => (
          <li key={s.name} className="rounded-md border border-line p-2.5" data-testid={`orchestrator-skill-${s.name}`}>
            <div className="flex items-center gap-2">
              <span className="readout text-xs text-ink">{s.name}</span>
              <button
                type="button"
                className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink-signal"
                data-testid={`delete-skill-${s.name}`}
                onClick={() => {
                  void platform.agents
                    .deleteOrchestratorSkill(s.name)
                    .then(load)
                    .catch((e: Error) => setToast(e.message))
                }}
              >
                Delete
              </button>
            </div>
            <pre className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-body text-ink-muted">
              {s.content}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Which tool the orchestrator runs on.
 *
 * **This is the only place in the app where an agent can be switched.** The same control used
 * to live in the session settings menu, and was removed from there: because the conversation
 * does not carry over, "switching" there meant the same thing as "starting a new conversation,"
 * which creating a new session already does more honestly. The orchestrator is the one that
 * remains, because the app has only one, so "create a new one with a different tool" does not
 * make sense.
 *
 * This handles both cases in one place: if it has not been born yet, only the choice is
 * recorded (the next first question is born with that tool), and if it is already alive, it is
 * swapped out on the spot. There is one reason a confirmation is asked for — once the process
 * changes, that tool's context is gone. (The transcript stays, and the new process is handed a
 * summary of the past conversation.)
 */
function OrchestratorSettings() {
  const platform = usePlatform()
  const orchestratorId = useStore((s) => s.orchestratorId)
  const live = useStore((s) => (s.orchestratorId ? s.sessions[s.orchestratorId]?.tool : undefined))
  const chosen = useStore((s) => s.orchestratorTool)
  const chooseTool = useStore((s) => s.chooseOrchestratorTool)
  /*
   * The session itself, from the host: this run may not have opened it, and the tool it runs on is the truth once it
   * exists. Read again when this run learns of it (`orchestratorId`) and after a switch, since a switch of a session
   * this run has not opened changes nothing that `live` follows. A failed read says so beside the list rather than
   * showing the first tool as the current one.
   */
  const peek = useLoad(() => platform.agents.orchestratorPeek(), [platform], [orchestratorId])
  // Holds onto the whole thing that was picked, not just its name — the confirmation dialog never has to hunt for the name again
  const [asking, setAsking] = useState<ToolStatus | null>(null)
  const tools = useTools()

  // With a session, its tool; before one, the choice made this run (the host keeps what it was told, but does not say it)
  const current = live ?? peek.data?.tool ?? chosen ?? (tools[0]?.name ?? null)

  const apply = async (tool: ToolName) => {
    // A refusal is toasted by the store and moves nothing here
    if (await chooseTool(tool)) await peek.reload()
  }

  return (
    <section data-testid="settings-orchestrator">
      <p className="text-xs leading-body text-ink-faint">
        The orchestrator is the one session that belongs to the app rather than a project. Pick
        which agent it runs on.
      </p>
      {peek.error && !orchestratorId && (
        <LoadFailed what="the orchestrator" error={peek.error} onRetry={() => void peek.reload()} className="mt-2" testId="orchestrator-peek-failed" />
      )}
      <div className="mt-3 space-y-1.5">
        {tools.map((t) => (
          <button
            key={t.name}
            type="button"
            role="radio"
            aria-checked={t.name === current}
            data-testid={`orchestrator-tool-${t.name}`}
            onClick={() => t.name !== current && setAsking(t)}
            className={`flex w-full items-baseline gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
              t.name === current ? 'border-ink-muted text-ink' : 'border-line text-ink-muted hover:border-line-strong hover:text-ink'
            }`}
          >
            <span className="w-2 shrink-0 text-2xs leading-none" aria-hidden>
              {t.name === current ? '✓' : ''}
            </span>
            <span className="text-sm">{t.label}</span>
          </button>
        ))}
      </div>

      <OrchestratorSkills />

      <SessionToolsSwitch />

      {asking && (
        <Modal onClose={() => setAsking(null)} testId="orchestrator-switch-confirm">
          <div className="w-[380px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4">
            <h2 className="text-md font-medium text-ink">
              Run the orchestrator on {asking.label}?
            </h2>
            {/*
              **States plainly that a summary is a loss.**
              Stopping at "it is handed a summary" reads as if nothing is lost — in reality only
              the trunk of the recent turns goes across and the detail falls away. What the
              person needs to know before clicking confirm is not what stays, but **what can
              disappear**.
            */}
            <p className="mt-2 text-sm leading-body text-ink-muted">
              The current agent process ends and a new one starts.{' '}
              <b className="text-ink">Details it remembers may be lost</b> — each tool keeps its
              own memory, and none of it carries over.
            </p>
            <p className="mt-1.5 text-sm leading-body text-ink-faint">
              Your transcript stays here. The new agent is handed a <b className="text-ink-muted">summary</b> of
              your recent turns, so it knows what you were discussing — but not every detail of it.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink"
                onClick={() => setAsking(null)}
                data-testid="orchestrator-switch-cancel"
              >
                Cancel
              </button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  void apply(asking.name)
                  setAsking(null)
                }}
                data-testid="orchestrator-switch-confirm-btn"
              >
                Switch
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}

/**
 * Whether ordinary sessions get Centralu's light, read-only tools (#320). On by default.
 *
 * It sits with the orchestrator because it is the other half of the same question — which
 * sessions get Centralu's own tools — and the answer here is the part that does not direct
 * anything: a session looks at its own project, it never sends or creates.
 */
function SessionToolsSwitch() {
  const on = useStore((s) => s.prefs.sessionTools)
  const ceiling = useStore((s) => s.prefs.agentCeiling)
  // How deep agents may start agents (#867): nothing saved is 1, and every preset keeps to it
  const depth = useStore((s) => agentDepthOf(s.prefs))
  const setPrefs = useStore((s) => s.setPrefs)
  return (
    <div className="mt-6 border-t border-line pt-4">
      <SettingToggle
        checked={on}
        onChange={(next) => setPrefs({ sessionTools: next })}
        label="Let sessions look at other sessions"
        testId="settings-session-tools"
        hint={
          <>
            Every session can read other sessions and search their past conversations: from a trusted
            project, any project&apos;s and linked machines&apos; (not the orchestrator&apos;s or an app&apos;s);
            from an untrusted one, its own project&apos;s. It can also read Centralu&apos;s guide. With your consent it can also ask another
            project to do a task and attach apps other projects share. It can start agents in its own project under its own permission preset. Auto opens these boundaries without asking. Turning this off stops those tools at once,
            apps it attached included; turning it on reaches a session the next time it starts.
          </>
        }
      />
      <label className="mt-4 flex items-center gap-2 text-sm text-ink-muted">
        Running agents per project
        <TextInput
          type="number"
          min={0}
          step={1}
          size="sm"
          text="sm"
          className="w-20"
          data-testid="settings-agent-ceiling"
          value={ceiling ?? ''}
          placeholder="Default"
          onChange={(e) => {
            const value = e.target.value === '' ? null : Number(e.target.value)
            if (value === null || (Number.isSafeInteger(value) && value >= 0)) void setPrefs({ agentCeiling: value })
          }}
        />
      </label>
      <p className="mt-1 text-xs leading-body text-ink-faint">
        Leave empty for the preset default: unlimited under auto, four otherwise. Zero means unlimited.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm text-ink-muted">
        How deep agents may start agents
        <input
          type="range"
          min={1}
          max={MAX_AGENT_DEPTH}
          step={1}
          className="w-24 accent-line-strong"
          data-testid="settings-agent-depth"
          value={depth}
          onChange={(e) => void setPrefs({ agentDepth: Number(e.target.value) })}
        />
        <span className="readout w-3 text-ink" data-testid="settings-agent-depth-value" aria-hidden>
          {depth}
        </span>
      </label>
      <p className="mt-1 text-xs leading-body text-ink-faint">
        At 1, only the sessions you start can start agents; each step lets the agents below do the same. Auto stays within it.
      </p>
      <AgentModelsSection />
      <HubAutoSwitch />
      <AutoCompactSetting setPrefs={setPrefs} />
    </div>
  )
}

/**
 * Whether a linked computer's `auto` session may start one here under `auto` too (#1273: start_agent with a machine,
 * from the computer this one is linked to). On by default; off, such a session runs under normal here, and the other
 * computer asks the person each time. This computer's own say, for a computer the person shares.
 */
function HubAutoSwitch() {
  const on = useStore((s) => hubAutoOf(s.prefs))
  const setPrefs = useStore((s) => s.setPrefs)
  return (
    <div className="mt-4">
      <SettingToggle
        checked={on}
        onChange={(next) => setPrefs({ hubAuto: next })}
        label="Allow auto from a linked computer"
        testId="settings-hub-auto"
        hint={
          <>
            When a computer that links to this one starts an agent here from a session running under auto, the agent
            runs under auto here too, and that computer does not ask you first. Off, it runs under normal here and
            that computer asks you each time.
          </>
        }
      />
    </div>
  )
}

/**
 * When agents compact by themselves (#1376): a share of the model's window, set by Centralu for Claude and Codex alike. On
 * by default at 60%; off, nothing is passed and each agent's own settings decide.
 */
function AutoCompactSetting({ setPrefs }: { setPrefs: (patch: UiPreferencesPatch) => Promise<void> }) {
  const { controlled, share } = useStore((s) => autoCompactOf(s.prefs))
  const percent = Math.round(share * 100)
  return (
    <div className="mt-4">
      <SettingToggle
        checked={controlled}
        onChange={(next) => setPrefs({ autoCompact: { controlled: next } })}
        label="Let Centralu set when agents compact"
        testId="settings-auto-compact"
        hint={
          <>
            Agents compact their conversation by themselves at a share of the model&apos;s window, for Claude and Codex
            alike. Off, Centralu passes nothing and each agent&apos;s own settings decide. On, Centralu also turns auto
            compact on for Claude if you turned it off in your own Claude settings. A running session takes a change when
            its process next starts; a model Centralu has not read a window from yet takes it from its second start.
            Claude never compacts before 67,000 tokens. Linked computers are told this setting when they connect and when
            it changes; one from before it applies nothing.
          </>
        }
      />
      {controlled && (
        <label className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
          Compact at
          <input
            type="range"
            min={Math.round(MIN_AUTO_COMPACT_SHARE * 100)}
            max={Math.round(MAX_AUTO_COMPACT_SHARE * 100)}
            step={5}
            className="w-32 accent-line-strong"
            data-testid="settings-auto-compact-share"
            value={percent}
            onChange={(e) => void setPrefs({ autoCompact: { share: Number(e.target.value) / 100 } })}
          />
          <span className="readout w-16 text-ink" data-testid="settings-auto-compact-share-value" aria-hidden>
            {percent}% of the window
          </span>
        </label>
      )}
    </div>
  )
}

/**
 * Appearance: the theme, then text (size, fonts, line height), then how the grid behaves.
 */
function AppearanceSection() {
  const fold = useStore((s) => s.foldComposer)
  const setFold = useStore((s) => s.setFoldComposer)
  const modEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const setPrefs = useStore((s) => s.setPrefs)
  const sc = useShortcut()
  return (
    <section>
      <ThemeSection />
      <TypographySection />

      {/*
        Folding the composer in a grid panel (user request, 2026-09-10). The setting came from
        the reading space being tight in a two-row grid, so it applies **only to the grid** —
        the focus view has plenty of room, and folding there would only leave the person having
        to unfold it again every time.
        The project screen's panels (#203) are the grid's panels at the grid's sizes, so it applies there too.
      */}
      <div className="mt-6 border-t border-line pt-4">
        <SettingToggle
          checked={fold}
          onChange={setFold}
          label="Fold the message box in the grid and on project screens"
          hint={
            <>
              It rests as a card peeking from the bottom and rises over the conversation when you
              reach for it. Off keeps it open, as before.
            </>
          }
          hintInside
          testId="settings-fold-composer"
        />
      </div>

      {/*
        A switch for someone writing multi-line prompts.

        The reason it sits here is the same as "fold the composer" next to it — both are about
        how the **message box** is used, and someone looking for this arrives thinking of the
        composer.

        The reason the default is off is recorded in the protocol's type declaration: Enter as
        send is the chat-box convention, and silently moving it out from under someone already
        used to it would be worse than never offering the option at all.
      */}
      <div className="mt-6 border-t border-line pt-4">
        <SettingToggle
          checked={modEnter}
          onChange={(on) => setPrefs({ sendWithModifierEnter: on })}
          label={<>Send with {sc('mod', 'Enter')}</>}
          hint={
            <>
              Enter then writes a new line instead of sending, which is what you want when a prompt
              runs to several paragraphs. Shift+Enter writes a new line either way.
            </>
          }
          testId="settings-send-with-mod-enter"
        />
      </div>
    </section>
  )
}

/**
 * Background mode (#280, decision 1 — off by default).
 *
 * The description says the three things a person needs before turning it on: what keeps running,
 * how to stop it anyway, and when it stops by itself. A switch that keeps processes alive behind
 * no window must never be one whose consequences someone discovers later.
 */
function BackgroundSection({ port }: { port: BackgroundPort }) {
  const read = useLoad(() => port.get(), [port])
  // What the keeper answered to the last change, over what it said when the section opened
  const [saved, setSaved] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const on = saved ?? read.data ?? null

  return (
    <section data-testid="settings-background">
      <SettingToggle
        checked={on ?? false}
        disabled={on === null}
        onChange={(next) => {
          setError(null)
          // Saving holds the switch (`SettingToggle`): a second click raced the keeper's answer to the first
          return port
            .set(next)
            .then(setSaved)
            .catch((err: Error) => setError(err.message))
        }}
        label="Keep agents running after Centralu quits"
        hint={
          <>
            Closing the window leaves the agent host and its running sessions going. Opening
            Centralu again picks them up where they are, waiting approvals included. Off, quitting
            is always Quit completely and stops them.
          </>
        }
        hintInside
        testId="settings-background-toggle"
      />
      <p className="mt-3 text-xs leading-body text-ink-faint">
        To stop everything anyway, choose <span className="text-ink-muted">Quit completely</span>{' '}
        when you quit: it also stops agents, terminals and running commands. With no window open and
        nothing running for 30 minutes, the background host stops by itself.
      </p>
      {(error ?? read.error) && (
        <p className="mt-2 text-xs text-danger" data-testid="settings-background-error">
          {error ?? read.error}
        </p>
      )}
    </section>
  )
}
