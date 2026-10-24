import { TrustProjectButton } from '../project/TrustCard.jsx'
import { usePresence } from '../../components/presence.js'
import { useEffect, useRef, useState } from 'react'
import { MAX_AGENT_DEPTH, MAX_AUTO_COMPACT_SHARE, MAX_NUDGE_SHARE, MIN_AUTO_COMPACT_SHARE, MIN_IDLE_COMPACT_SHARE, MIN_NUDGE_SHARE, NUDGE_MARGIN, agentDepthOf, autoCompactOf, hubAutoOf, nudgeShares, type ToolName, type ToolStatus, type UiPreferencesPatch } from '@cc/protocol'
import { appKeyOf, explainGridSpan, type NotifyPolicy } from '@cc/core'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useMachineName, useTools } from '../../store/selectors.js'
import { useShortcut } from '../../app/shortcut.js'
import { isPlainEscape } from '../../app/keys.js'
import { useDialogFocus } from '../../components/dialogFocus.js'
import { Kbd } from '../../components/primitives.jsx'
import { useLoad } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { InlineConfirm } from '../../components/InlineConfirm.jsx'
import { Modal } from '../../components/Modal.jsx'
import { Button } from '../../components/Button.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { useFocusReturn } from '../../components/focusReturn.js'
import { useAppCatalog, type ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppSecrets, missingSecrets } from '../pinned-app/AppSecrets.jsx'
import { SpanButton } from '../../components/SpanPicker.jsx'
import { Segmented } from '../../components/Segmented.jsx'
import { Switch } from '../../components/Switch.jsx'
import {
  AppIcon,
  BackgroundIcon,
  BellIcon,
  BranchIcon,
  ContrastIcon,
  CrownIcon,
  MonitorIcon,
  ShieldIcon,
  ArchiveIcon,
} from '../../components/icons.jsx'
import { SettingsCard, SettingsEmpty, SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout.jsx'
import { ArchiveSection } from './ArchiveSection.jsx'
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
 * The window's categories.
 *
 * Named after the errand someone arrives with, not after the module that implements the
 * setting: people come here to stop being pinged, to take back an always-allow they regret,
 * or to look up a key. Naming by module would put the next setting wherever its code lives,
 * which is the one thing the person looking for it cannot know.
 *
 * A category per setting reads worse than no categories at all, so a new one has to earn its
 * place by having somewhere to belong — quiet hours land in Notifications, a default preset
 * in Permissions.
 *
 * Updates earned a category of its own once (issue #43): people arrive asking "am I on the latest?", which is an
 * errand, not a module. It shares one with Background since the owner trimmed the window (2026-10-20): both answer
 * "what does Centralu do while I am not looking", and each had shrunk to a switch or two. The shortcut table left for
 * the command palette (Keyboard shortcuts) at the same time: it is looked up in passing, not set.
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
  { id: 'orchestrator', label: 'Orchestrator', Icon: CrownIcon },
  /*
   * How the agents any session starts behave: how many run per project, how deep they may start their own, which model
   * each difficulty runs. Its own category (owner, 2026-10-20): these apply to every session, not to the orchestrator,
   * and folded under the orchestrator they read as its settings.
   */
  { id: 'agents', label: 'Agents', Icon: BranchIcon },
  // An experimental feature is an app (#81) — there has to be a place to turn it on and off for "unused, it disappears" to hold true
  { id: 'apps', label: 'Apps', Icon: AppIcon },
  { id: 'notifications', label: 'Notifications', Icon: BellIcon },
  /*
   * Whether quitting leaves agents running (#280). Its own category because the question people
   * arrive with is "what happens to my agents when I quit?", and the answer is one switch plus
   * what it costs. That switch shows only where the platform can do it (the desktop app's keeper);
   * the category shows everywhere since #568, for "what happens to my agents when I leave them
   * idle", which every host answers.
   */
  { id: 'background', label: 'Background & updates', Icon: BackgroundIcon },
  /*
   * Linked machines (#82). Its own category because the errand is its own: "link my server", "why is it away". It
   * holds a list, a form and a prompt, which no other category could take without renaming itself.
   */
  { id: 'machines', label: 'Machines', Icon: MonitorIcon },
  { id: 'appearance', label: 'Appearance', Icon: ContrastIcon },
  { id: 'permissions', label: 'Permissions', Icon: ShieldIcon },
  // Deleted sessions (#204) — the only place a conversation is deleted for good, so it has a place of its own
  { id: 'archive', label: 'Archive', Icon: ArchiveIcon },
] as const

type Category = (typeof CATEGORIES)[number]['id']

/** Categories that were merged into another (2026-10-20): a request for one opens where it went */
const MOVED: Record<string, Category> = { updates: 'background' }

const categoryOf = (id: string | undefined): Category | null =>
  CATEGORIES.find((c) => c.id === id)?.id ?? (id ? (MOVED[id] ?? null) : null)

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
  const [category, setCategory] = useState<Category>('notifications')
  // Another screen asked for a category (a machine's badge in the sidebar opens Machines, #82, #734)
  const request = useStore((s) => s.settingsRequest)
  useEffect(() => {
    const asked = categoryOf(request?.category)
    if (asked) setCategory(asked)
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
        /*
          One size for every category (owner, 2026-10-19): the window used to take the height of what it showed, so it
          jumped as the rail was walked and Notifications shrank to a short box. Now the frame stays and the page
          scrolls inside it.
        */
        className={`flex h-[min(680px,calc(82vh/var(--text-zoom)))] w-[800px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal) outline-none ${
          leaving ? 'cc-drop-out' : 'cc-drop'
        }`}
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-panel"
      >
        <header className="flex items-center gap-2 border-b border-line/60 py-2.5 pl-4 pr-3">
          <h2 className="text-md font-medium text-ink">Settings</h2>
          <span className="ml-auto flex items-center gap-1.5 text-2xs text-ink-faint">
            <Kbd>esc</Kbd> Close
          </span>
        </header>

        <div className="flex min-h-0 flex-1">
          {/*
            The rail is the index. It says what this window holds without opening anything,
            which a scroll can only do by being short — and it will not stay short.
          */}
          <nav
            className="w-[196px] shrink-0 space-y-px overflow-y-auto border-r border-line/60 p-2"
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
                className={`group/tab flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-md transition-colors ${
                  c.id === category ? 'bg-surface-selected text-ink' : 'text-ink-muted hover:bg-surface-hover/40 hover:text-ink'
                }`}
              >
                <span className={c.id === category ? 'text-ink' : 'text-ink-faint group-hover/tab:text-ink-muted'}>
                  <c.Icon size={14} />
                </span>
                {c.label}
              </button>
            ))}
          </nav>

          {/*
            Only the chosen category is built. Hiding the rest instead would keep the whole
            window's worth of controls in the page — and a control that is present but unseen
            is one a test can pass on and a screen reader can walk into.
          */}
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8 pt-6" data-testid="settings-pane">
            {category === 'orchestrator' && <OrchestratorSettings />}
            {category === 'agents' && <AgentLimits />}
            {category === 'apps' && <AppsSettings />}
            {/* E-5 notification policy */}
            {category === 'notifications' && (
              <SettingsPage title="Notifications" lead="Notifications are the only way to force attention, so use them sparingly.">
                {/*
                  "Error" and "Once when every session finishes" are gone, and so is "Reset to defaults" (owner,
                  2026-10-20): the window no longer raises either (store/events/notices.ts), and five switches need
                  no reset. Their saved values stay in the snapshot, unread.
                */}
                <SettingsGroup title="Notify me">
                  {(
                    [
                      ['approval', 'Awaiting approval', 'When an agent is blocked'],
                      ['done', 'A session finishes out of sight', null],
                      ['whenFocused', 'Notify even when the app is focused', null],
                      ['sound', 'Play a sound', 'The one signal that reaches the next room'],
                    ] as [keyof NotifyPolicy, string, string | null][]
                  ).map(([key, label, hint]) => (
                    <SettingToggle
                      key={key}
                      checked={policy[key]}
                      onChange={(on) => setPolicy({ ...policy, [key]: on })}
                      label={label}
                      hint={hint ?? undefined}
                      testId={`notify-${key}`}
                    />
                  ))}
                </SettingsGroup>
              </SettingsPage>
            )}

            {/* Background and Updates (issue #43), one page since 2026-10-20 */}
            {category === 'background' && (
              <SettingsPage
                title="Background & updates"
                lead="What happens to your agents when you quit or leave them idle, and which version is running."
              >
                <SettingsGroup title="Agents">
                  {platform.background && <BackgroundSection port={platform.background} />}
                  <SleepSection first={!platform.background} />
                </SettingsGroup>
                <UpdatesSection />
                <AgentCliUpdates />
              </SettingsPage>
            )}

            {category === 'machines' && <MachinesSection onOpenCategory={(c) => setCategory(categoryOf(c) ?? 'background')} />}

            {category === 'appearance' && <AppearanceSection />}

            {/* E-4 approval rules */}
            {category === 'permissions' && (
              <SettingsPage title="Permissions" lead="Answers you gave once and can take back here.">
                <SettingsGroup
                  title="Always-allow rules"
                  hint={
                    <>
                      Pressing <Kbd>a</Kbd> on an approval adds a rule here. Delete any of them anytime.
                    </>
                  }
                >
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
                </SettingsGroup>
                <ProjectConsentsSection />
              </SettingsPage>
            )}

            {category === 'archive' && <ArchiveSection />}
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
    <SettingsPage
      testId="settings-apps"
      title="Apps"
      lead="Apps found in your projects and your own apps folder, and how each one is doing."
    >
      {catalog.external.length === 0 && (
        <SettingsCard>
          <SettingsEmpty testId="settings-apps-empty">No apps yet.</SettingsEmpty>
        </SettingsCard>
      )}
      {catalog.external.length > 0 && (
        <div className="space-y-6" data-testid="settings-external-apps">
          {projectIds.map((pid) => (
            // The host removes a deleted project's apps from the list. The moment its name cannot be found is only the one tick before the list catches up
            <SettingsGroup key={pid} title={projects[pid]?.name ?? 'Project'}>
              <ul className="divide-y divide-line/70">
                {catalog.byProject[pid]!.map((a) => (
                  <ExternalAppRow key={a.key} app={a} />
                ))}
              </ul>
            </SettingsGroup>
          ))}
          {catalog.user.length > 0 && (
            <SettingsGroup title="Other apps">
              <ul className="divide-y divide-line/70">
                {catalog.user.map((a) => (
                  <ExternalAppRow key={a.key} app={a} />
                ))}
              </ul>
            </SettingsGroup>
          )}
          {/* Each linked machine's own apps (#82), under its name: what is done to one here is done on that machine */}
          {Object.keys(catalog.byMachine).map((machine) => (
            <MachineAppsGroup key={machine} machine={machine} apps={catalog.byMachine[machine]!} />
          ))}
        </div>
      )}
    </SettingsPage>
  )
}

/** A linked machine's user-folder apps (#82), named by the machine */
function MachineAppsGroup({ machine, apps }: { machine: string; apps: ExternalCatalogApp[] }) {
  const name = useMachineName(machine) ?? machine
  return (
    <SettingsGroup testId={`settings-machine-apps-${machine}`} title={`${name}’s apps`}>
      <ul className="divide-y divide-line/70">
        {apps.map((a) => (
          <ExternalAppRow key={a.key} app={a} />
        ))}
      </ul>
    </SettingsGroup>
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
    <li className="px-4 py-3" data-testid={`external-app-${app.key}`} data-status={app.info.status}>
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
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => void stopApp({ key: app.key, appId: app.appId, projectId: app.projectId, machine: app.info.machine ?? null })}
            data-testid="external-app-stop"
          >
            Stop
          </Button>
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
      {/* What can be set on the app, on one line under what it says about itself */}
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 empty:hidden">
        <ShareLine app={app} />
        <GridSpanLine app={app} />
        {app.projectId === null && !confirming && (
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setConfirming(true)} data-testid="external-app-remove">
            Remove…
          </Button>
        )}
      </div>
      {/* Another machine's user-folder app (#82) is removed on that machine: `machine` names it, so this computer's app of the same id is never touched */}
      {app.projectId === null &&
        (confirming ? (
          <InlineConfirm
            text={
              machineName
                ? `Remove ${app.title} from ${machineName}? Its folder is set aside there, not deleted, and agents there lose its tools. Its run records stay. Apps on this computer are not touched.`
                : `Remove ${app.title}? Its folder is set aside, not deleted, and agents lose its tools. Its run records stay.`
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
        ) : null)}
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
    <div className="flex items-center gap-2 text-xs text-ink-faint">
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
      className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted"
      title="Sessions in your other projects can attach this app while they need it. Each project asks you once."
      data-testid="external-app-share"
    >
      <Switch checked={shared} onChange={(e) => void setShared(app.projectId!, app.appId, e.target.checked)} />
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
        className={`-ml-1 rounded-md px-1 py-0.5 text-xs transition-colors hover:text-ink ${missing ? 'text-ink' : 'text-ink-faint'}`}
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
    <SettingsGroup testId="orchestrator-skills" title="Approved skills" hint="Deleting one takes it out of the orchestrator's prompt at once.">
      {loaded.error !== null && (
        <div className="px-4 py-3">
          <LoadFailed what="the approved skills" error={loaded.error} onRetry={load} testId="orchestrator-skills-failed" />
        </div>
      )}
      {skills.map((s) => (
        <div key={s.name} className="px-4 py-3" data-testid={`orchestrator-skill-${s.name}`}>
          <div className="flex items-center gap-2">
            <span className="readout min-w-0 truncate text-sm text-ink">{s.name}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0"
              data-testid={`delete-skill-${s.name}`}
              onClick={() => {
                void platform.agents
                  .deleteOrchestratorSkill(s.name)
                  .then(load)
                  .catch((e: Error) => setToast(e.message))
              }}
            >
              Delete
            </Button>
          </div>
          <pre className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-body text-ink-muted">
            {s.content}
          </pre>
        </div>
      ))}
    </SettingsGroup>
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
    <SettingsPage
      testId="settings-orchestrator"
      title="Orchestrator"
      lead="The one session that belongs to the app rather than a project."
    >
      {peek.error && !orchestratorId && (
        <LoadFailed what="the orchestrator" error={peek.error} onRetry={() => void peek.reload()} testId="orchestrator-peek-failed" />
      )}
      <SettingsGroup title="Agent">
        <SettingsRow
          label="Runs on"
          hint="Pick which agent it runs on. Switching asks first."
          control={
            <Segmented
              label="Orchestrator agent"
              value={current}
              size="sm"
              onChange={(name) => {
                const picked = tools.find((t) => t.name === name)
                if (picked) setAsking(picked)
              }}
              options={tools.map((t) => ({ value: t.name, label: t.label, testId: `orchestrator-tool-${t.name}` }))}
            />
          }
        />
      </SettingsGroup>

      <OrchestratorSkills />

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
    </SettingsPage>
  )
}

/**
 * Settings → Agents: how the agents a session starts behave, for every session (the orchestrator's included): how many
 * may run per project, how deep they may start agents of their own, and which model each difficulty runs (#867, #729).
 *
 * "Let sessions look at other sessions" (#320) used to stand here too. It is always on now and the host holds it so,
 * so the switch is gone rather than shown fixed.
 */
function AgentLimits() {
  const ceiling = useStore((s) => s.prefs.agentCeiling)
  // How deep agents may start agents (#867): nothing saved is 1, and every preset keeps to it
  const depth = useStore((s) => agentDepthOf(s.prefs))
  const setPrefs = useStore((s) => s.setPrefs)
  return (
    <SettingsPage
      title="Agents"
      lead="How the agents a session starts behave, for every session, the orchestrator's included."
    >
      <SettingsGroup title="Limits">
        <SettingsRow
          label={<label htmlFor="settings-agent-ceiling">Running agents per project</label>}
          hint="Leave empty for the preset default: unlimited under auto, four otherwise. Zero means unlimited."
          control={
            <TextInput
              id="settings-agent-ceiling"
              type="number"
              min={0}
              step={1}
              size="sm"
              text="sm"
              className="w-24"
              data-testid="settings-agent-ceiling"
              value={ceiling ?? ''}
              placeholder="Default"
              onChange={(e) => {
                const value = e.target.value === '' ? null : Number(e.target.value)
                if (value === null || (Number.isSafeInteger(value) && value >= 0)) void setPrefs({ agentCeiling: value })
              }}
            />
          }
        />
        <SettingsRow
          label={<label htmlFor="settings-agent-depth">How deep agents may start agents</label>}
          hint="At 1, only the sessions you start can start agents; each step lets the agents below do the same. Auto stays within it."
          control={
            <>
              <input
                id="settings-agent-depth"
                type="range"
                min={1}
                max={MAX_AGENT_DEPTH}
                step={1}
                className="w-24 accent-ink-muted"
                data-testid="settings-agent-depth"
                value={depth}
                onChange={(e) => void setPrefs({ agentDepth: Number(e.target.value) })}
              />
              <span className="readout w-3 text-sm text-ink" data-testid="settings-agent-depth-value" aria-hidden>
                {depth}
              </span>
            </>
          }
        />
      </SettingsGroup>
      <AgentModelsSection />
      <HubAutoSwitch />
      <AutoCompactSetting setPrefs={setPrefs} />
    </SettingsPage>
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
    <SettingsGroup title="Linked computers">
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
    </SettingsGroup>
  )
}

/**
 * When agents compact by themselves (#1376): a share of the model's window, set by Centralu for Claude and Codex alike. On
 * by default at 60%; off, nothing is passed and each agent's own settings decide.
 */
function AutoCompactSetting({ setPrefs }: { setPrefs: (patch: UiPreferencesPatch) => Promise<void> }) {
  const setting = useStore((s) => autoCompactOf(s.prefs))
  const { controlled, share, idleShare, nudge } = setting
  const percent = Math.round(share * 100)
  const idlePercent = Math.round(idleShare * 100)
  const { first, second } = nudgeShares(setting)
  const firstPercent = Math.round(first * 100)
  const secondPercent = Math.round(second * 100)
  const secondMax = Math.min(Math.round(MAX_NUDGE_SHARE * 100), percent - Math.round(NUDGE_MARGIN * 100))
  return (
    <SettingsGroup title="Compaction">
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
            Claude never compacts before 67,000 tokens. Separately, Centralu compacts a session that has been at rest for 10
            minutes once it is over the second share and over 100,000 tokens (never one waiting for you or running
            background work), so the next turn starts small. Linked computers are told this setting when they connect and when
            it changes; one from before it applies nothing.
          </>
        }
      />
      {controlled && (
        <SettingsRow
          label={<label htmlFor="settings-auto-compact-share">Compact at</label>}
          control={
            <>
              <input
                id="settings-auto-compact-share"
                type="range"
                min={Math.round(MIN_AUTO_COMPACT_SHARE * 100)}
                max={Math.round(MAX_AUTO_COMPACT_SHARE * 100)}
                step={5}
                className="w-32 accent-ink-muted"
                data-testid="settings-auto-compact-share"
                value={percent}
                onChange={(e) => void setPrefs({ autoCompact: { share: Number(e.target.value) / 100 } })}
              />
              <span className="readout w-28 text-sm text-ink" data-testid="settings-auto-compact-share-value" aria-hidden>
                {percent}% of the window
              </span>
            </>
          }
        />
      )}
      {controlled && (
        <SettingsRow
          label={<label htmlFor="settings-auto-compact-idle-share">Compact a resting session over</label>}
          control={
            <>
              <input
                id="settings-auto-compact-idle-share"
                type="range"
                min={Math.round(MIN_IDLE_COMPACT_SHARE * 100)}
                max={Math.round(MAX_AUTO_COMPACT_SHARE * 100)}
                step={5}
                className="w-32 accent-ink-muted"
                data-testid="settings-auto-compact-idle-share"
                value={idlePercent}
                onChange={(e) => void setPrefs({ autoCompact: { idleShare: Number(e.target.value) / 100 } })}
              />
              <span className="readout w-28 text-sm text-ink" data-testid="settings-auto-compact-idle-share-value" aria-hidden>
                {idlePercent}% of the window
              </span>
            </>
          }
        />
      )}
      {controlled && (
        <SettingToggle
          checked={nudge}
          onChange={(next) => setPrefs({ autoCompact: { nudge: next } })}
          label="Remind a growing session to compact"
          testId="settings-auto-compact-nudge"
          hint={
            <>
              When a session&apos;s context passes the first share, Centralu tells it once, quietly with its next message or
              tool result, to call compact_self when the step it is on is done; it tells it once more at the second share,
              which stays below the share agents compact at, where the compaction would come in the middle of work. It
              never starts or interrupts a turn, and starts again after the session compacts. Only sessions that have
              compact_self, and over 100,000 tokens.
            </>
          }
        />
      )}
      {controlled && nudge && (
        <SettingsRow
          label={<label htmlFor="settings-auto-compact-nudge-first">First reminder at</label>}
          control={
            <>
              <input
                id="settings-auto-compact-nudge-first"
                type="range"
                min={Math.round(MIN_NUDGE_SHARE * 100)}
                // Under a second share the person chose: the host refuses a first one that is not below it
                max={setting.nudgeSecond === null ? Math.round(MAX_NUDGE_SHARE * 100) : Math.max(Math.round(MIN_NUDGE_SHARE * 100), secondPercent - Math.round(NUDGE_MARGIN * 100))}
                step={5}
                className="w-32 accent-ink-muted"
                data-testid="settings-auto-compact-nudge-first"
                value={firstPercent}
                onChange={(e) => void setPrefs({ autoCompact: { nudgeFirst: Number(e.target.value) / 100 } })}
              />
              <span className="readout w-28 text-sm text-ink" data-testid="settings-auto-compact-nudge-first-value" aria-hidden>
                {firstPercent}% of the window
              </span>
            </>
          }
        />
      )}
      {controlled && nudge && (
        <SettingsRow
          label={<label htmlFor="settings-auto-compact-nudge-second">Second reminder at</label>}
          control={
            <>
              <input
                id="settings-auto-compact-nudge-second"
                type="range"
                min={Math.min(secondMax, Math.max(Math.round(MIN_NUDGE_SHARE * 100), firstPercent + Math.round(NUDGE_MARGIN * 100)))}
                // Above the first share, and below the share agents compact at: a second reminder after the tool's own compaction would say nothing
                max={secondMax}
                step={5}
                className="w-32 accent-ink-muted"
                data-testid="settings-auto-compact-nudge-second"
                value={secondPercent}
                onChange={(e) => void setPrefs({ autoCompact: { nudgeSecond: Number(e.target.value) / 100 } })}
              />
              <span className="readout w-28 text-sm text-ink" data-testid="settings-auto-compact-nudge-second-value" aria-hidden>
                {secondPercent}% of the window
              </span>
            </>
          }
        />
      )}
    </SettingsGroup>
  )
}

/**
 * Appearance: the theme, then text (size, fonts, line height), then how the message box sends.
 */
function AppearanceSection() {
  const modEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const setPrefs = useStore((s) => s.setPrefs)
  const sc = useShortcut()
  return (
    <SettingsPage title="Appearance" lead="The theme, the text, and how the message box behaves.">
      <ThemeSection />
      <TypographySection />

      <SettingsGroup title="Message box">
        {/*
          A switch for someone writing multi-line prompts.

          It sits here because it is about how the **message box** is used, and someone looking for
          this arrives thinking of the composer. ("Fold the message box" stood beside it until
          2026-10-20; a short grid or project panel now folds it by itself, SessionPane's foldWhenShort.)

          The reason the default is off is recorded in the protocol's type declaration: Enter as
          send is the chat-box convention, and silently moving it out from under someone already
          used to it would be worse than never offering the option at all.
        */}
        <SettingToggle
          checked={modEnter}
          onChange={(on) => setPrefs({ sendWithModifierEnter: on })}
          label={<>Send with {sc('mod', 'Enter')}</>}
          hint="Enter then writes a new line instead of sending, for prompts that run to several paragraphs. Shift+Enter writes a new line either way."
          testId="settings-send-with-mod-enter"
        />
      </SettingsGroup>
    </SettingsPage>
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
        hint="Closing the window leaves the agent host and its running sessions going."
        more={
          <>
            Opening Centralu again picks them up where they are, waiting approvals included. Off, quitting is always Quit
            completely and stops them. To stop everything anyway, choose <span className="text-ink-muted">Quit completely</span>{' '}
            when you quit: it also stops agents, terminals and running commands. With no window open and nothing running
            for 30 minutes, the background host stops by itself.
          </>
        }
        testId="settings-background-toggle"
      />
      {(error ?? read.error) && (
        <p className="-mt-1 px-4 pb-3 text-xs text-danger" data-testid="settings-background-error">
          {error ?? read.error}
        </p>
      )}
    </section>
  )
}
