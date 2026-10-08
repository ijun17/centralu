import { useCallback, useEffect, useState } from 'react'
import type { SessionInfo, ToolName, ToolStatus } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, appKeyOf, explainGridSpan, type NotifyPolicy } from '@cc/core'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useTools } from '../../store/selectors.js'
import { useNavShortcut, useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'
import { Modal } from '../../components/Modal.jsx'
import { useFocusReturn } from '../../components/focusReturn.js'
import { useAppCatalog, type ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppSecrets, missingSecrets } from '../pinned-app/AppSecrets.jsx'
import { SpanButton } from '../../components/SpanPicker.jsx'
import { TrashSection } from './TrashSection.jsx'
import { ProjectConsentsSection } from './ProjectConsentsSection.jsx'
import { ThemeSection } from './ThemeSection.jsx'
import { TypographySection } from './TypographySection.jsx'
import { AgentCliUpdates, UpdatesSection } from './UpdatesSection.jsx'
import { MachinesSection } from './MachinesSection.jsx'
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
  [['mod', '⇧1~4'], 'Panel tab (git · history · files · terminal)'],
  [['y / n / a'], 'Approve · deny · always allow'],
  [['alt', 'a'], 'Always allow (project scope)'],
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
   * what it costs. Shown only where the platform can do it (the desktop app's keeper).
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
  useFocusReturn(open)
  const toggle = useStore((s) => s.toggleSettings)
  const policy = useStore((s) => s.notifyPolicy)
  const setPolicy = useStore((s) => s.setNotifyPolicy)
  const platform = usePlatform()
  const sc = useShortcut()
  const nav = useNavShortcut()
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [category, setCategory] = useState<Category>('notifications')
  // Another screen asked for a category (a machine's header in the sidebar opens Machines, #82)
  const request = useStore((s) => s.settingsRequest)
  useEffect(() => {
    const asked = CATEGORIES.find((c) => c.id === request?.category)
    if (asked) setCategory(asked.id)
  }, [request])

  const loadRules = useCallback(() => {
    void platform.rules
      .list()
      .then(setRules)
      .catch(() => setRules([]))
  }, [platform])

  useEffect(() => {
    if (open) loadRules()
  }, [open, loadRules])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && toggle(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, toggle])

  if (!open) return null

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-scrim pt-[calc(8vh/var(--text-zoom))] backdrop-blur-[2px]"
      onClick={() => toggle(false)}
      data-testid="settings"
    >
      <div
        className="flex max-h-[calc(80vh/var(--text-zoom))] w-[640px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)"
        onClick={(e) => e.stopPropagation()}
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
            {CATEGORIES.filter((c) => c.id !== 'background' || platform.background).map((c) => (
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
                      <label className="flex items-center gap-2 text-sm text-ink-muted">
                        <input
                          type="checkbox"
                          className="accent-line-strong"
                          checked={policy[key]}
                          onChange={(e) => setPolicy({ ...policy, [key]: e.target.checked })}
                          data-testid={`notify-${key}`}
                        />
                        {label}
                      </label>
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

            {category === 'background' && platform.background && <BackgroundSection port={platform.background} />}

            {category === 'machines' && <MachinesSection onOpenCategory={setCategory} />}

            {category === 'appearance' && <AppearanceSection />}

            {/* E-4 approval rules */}
            {category === 'permissions' && (
              <section>
                <p className="text-xs leading-body text-ink-faint">
                  Pressing <Kbd>a</Kbd> on an approval adds an always-allow rule here. Delete any of them
                  anytime.
                </p>
                {rules === null ? (
                  <p className="mt-2 text-sm text-ink-faint">Loading…</p>
                ) : rules.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-faint" data-testid="rules-empty">
                    No saved rules
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-line/60 rounded-md border border-line" data-testid="rules-list">
                    {rules.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5">
                        <code className="truncate font-mono text-sm text-ink">{r.matcher}</code>
                        <span className="shrink-0 text-2xs text-ink-faint">
                          {r.scope === 'project' ? 'Project' : 'Session'}
                        </span>
                        <RuleOwner rule={r} />
                        <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">
                          {new Date(r.createdAt).toLocaleDateString('en-US')}
                        </span>
                        <button
                          className="shrink-0 text-xs text-ink-faint hover:text-ink"
                          data-testid={`delete-rule-${r.id}`}
                          onClick={async () => {
                            await platform.rules.remove(r.id)
                            loadRules()
                          }}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
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
              <p className="readout text-2xs uppercase text-ink-faint">{projects[pid]?.name ?? 'Project'}</p>
              <ul className="mt-2 space-y-2">
                {catalog.byProject[pid]!.map((a) => (
                  <ExternalAppRow key={a.key} app={a} />
                ))}
              </ul>
            </div>
          ))}
          {catalog.user.length > 0 && (
            <div>
              <p className="readout text-2xs uppercase text-ink-faint">Your apps</p>
              <ul className="mt-2 space-y-2">
                {catalog.user.map((a) => (
                  <ExternalAppRow key={a.key} app={a} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
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
  const trustProject = useStore((s) => s.setProjectTrusted)
  const toggleSettings = useStore((s) => s.toggleSettings)
  const openApp = useStore((s) => s.openApp)
  const removeUserApp = useStore((s) => s.removeUserApp)
  const [confirming, setConfirming] = useState(false)
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
      {status.reason && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-body text-ink-muted" data-testid="external-app-reason">
          {status.reason}
        </p>
      )}
      {app.info.status === 'untrusted' && app.projectId && (
        <button
          type="button"
          className="mt-1.5 rounded-md border border-line bg-surface-floor px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong"
          onClick={() => void trustProject(app.projectId!, true)}
          data-testid="external-app-trust"
        >
          Trust this project
        </button>
      )}
      {/* An imported app (M4 E-3) — where it came from, and, if it is waiting on the person's confirmation, the path to that confirmation */}
      {app.info.imported && (
        <p className="mt-1 break-words text-xs text-ink-faint" data-testid="external-app-imported">
          Imported from {app.info.imported.source}
        </p>
      )}
      {app.info.status === 'unconfirmed' && (
        <button
          type="button"
          className="mt-1.5 rounded-md border border-line bg-surface-floor px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong"
          onClick={() => {
            toggleSettings(false)
            openApp(app.projectId, app.appId)
          }}
          data-testid="external-app-review"
        >
          Review and enable…
        </button>
      )}
      <SecretsLine app={app} />
      <ShareLine app={app} />
      <GridSpanLine app={app} />
      {app.projectId === null &&
        (confirming ? (
          <div className="mt-2 rounded-md border border-line bg-surface-floor px-2.5 py-2" data-testid="external-app-remove-confirm">
            <p className="text-xs leading-body text-ink-muted">
              Remove {app.title}? Its folder moves to the app trash and agents lose its tools. Its run records stay.
            </p>
            <div className="mt-1.5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink"
                onClick={() => setConfirming(false)}
                data-testid="external-app-remove-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-line bg-surface-raised px-2 py-0.5 text-xs text-ink transition-colors hover:text-ink-signal"
                onClick={() => void removeUserApp(app.appId).then((ok) => ok || setConfirming(false))}
                data-testid="external-app-remove-yes"
              >
                Remove
              </button>
            </div>
          </div>
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
  const setting = useStore((s) => s.appSpans[appKeyOf(app.projectId, app.appId)])
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
        onPick={(span) => setAppSpan(app.projectId, app.appId, span)}
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
 * A user-folder app has no switch: it is the person's own and available to every project already.
 */
function ShareLine({ app }: { app: ExternalCatalogApp }) {
  const setShared = useStore((s) => s.setAppShared)
  if (app.projectId === null) return null
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
function OrchestratorSkills() {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const [skills, setSkills] = useState<{ name: string; content: string }[]>([])
  const load = useCallback(() => {
    void platform.agents
      .orchestratorSkills()
      .then((r) => setSkills(r.skills))
      .catch(() => {})
  }, [platform])
  useEffect(load, [load])

  if (skills.length === 0) return null
  return (
    <div className="mt-5 border-t border-line pt-3" data-testid="orchestrator-skills">
      <p className="readout text-2xs uppercase text-ink-faint">Approved skills</p>
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
  const switchTool = useStore((s) => s.switchTool)
  const setToast = useStore((s) => s.setToast)
  /*
   * Holds onto **the session itself**, not the saved choice.
   *
   * Before, only the tool name was pulled out. So whether there was something to switch was
   * decided by `orchestratorId`, and that value only gets filled once the orchestrator has
   * actually been **opened** during this run. For someone who launches the app and opens
   * Settings first, it is always null, so even with a live session sitting there, the flow fell
   * through to configureOrchestrator — a value the host has documented as "not read again once
   * a session exists." The choice gets written, nobody reads it, and on the next render, peek
   * read the old tool back from the session (dogfooding: "switch it, and it still comes back as
   * Codex").
   */
  const [peeked, setPeeked] = useState<SessionInfo | null>(null)
  // Holds onto the whole thing that was picked, not just its name — the confirmation dialog never has to hunt for the name again
  const [asking, setAsking] = useState<ToolStatus | null>(null)
  const tools = useTools()

  // If there is no session yet, the only value the screen can show is the saved choice (whatever was picked on the intro screen)
  useEffect(() => {
    const alive = true
    void platform.agents
      .orchestratorPeek()
      .then((s) => alive && setPeeked(s))
      .catch(() => {})
  }, [platform])

  /** What to swap out — whether it was opened during this run or not, existing is enough */
  const existingId = orchestratorId ?? peeked?.id ?? null
  const current = live ?? peeked?.tool ?? (tools[0]?.name ?? null)

  const apply = async (tool: ToolName) => {
    try {
      // If it is alive, swap it out; if not yet, only record the choice
      if (existingId) await switchTool(existingId, tool)
      else await platform.agents.configureOrchestrator(tool)
      setPeeked((p: SessionInfo | null) => (p ? { ...p, tool } : p))
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  return (
    <section data-testid="settings-orchestrator">
      <p className="text-xs leading-body text-ink-faint">
        The orchestrator is the one session that belongs to the app rather than a project. Pick
        which agent it runs on.
      </p>
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
              <button
                className="rounded-md border border-line-strong px-2.5 py-1 text-sm text-ink hover:bg-surface-hover/50"
                onClick={() => {
                  void apply(asking.name)
                  setAsking(null)
                }}
                data-testid="orchestrator-switch-confirm-btn"
              >
                Switch
              </button>
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
  const setPrefs = useStore((s) => s.setPrefs)
  return (
    <div className="mt-6 border-t border-line pt-4">
      <label className="flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          className="accent-line-strong"
          data-testid="settings-session-tools"
          checked={on}
          onChange={(e) => void setPrefs({ sessionTools: e.target.checked })}
        />
        Let sessions look at their own project
      </label>
      <p className="mt-1 text-xs leading-body text-ink-faint">
        Every session can read the other sessions in its project, search that project&apos;s past
        conversations, and read Centralu&apos;s guide. It cannot send to or create sessions — that
        stays with the orchestrator. Turning this off stops those tools at once; turning it on
        reaches a session the next time it starts.
      </p>
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
  const spinGrid = useStore((s) => s.spinGrid)
  const setSpinGrid = useStore((s) => s.setSpinGrid)
  const spinIcon = useStore((s) => s.spinSessionIcon)
  const setSpinIcon = useStore((s) => s.setSpinSessionIcon)
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
        <label className="flex items-start gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            className="mt-0.5 accent-line-strong"
            checked={fold}
            onChange={(e) => setFold(e.target.checked)}
            data-testid="settings-fold-composer"
          />
          <span>
            Fold the message box in the grid and on project screens
            <span className="mt-1 block text-xs leading-body text-ink-faint">
              It rests as a card peeking from the bottom and rises over the conversation when you
              reach for it. Off keeps it open, as before.
            </span>
          </span>
        </label>
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
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            className="accent-line-strong"
            data-testid="settings-send-with-mod-enter"
            checked={modEnter}
            onChange={(e) => void setPrefs({ sendWithModifierEnter: e.target.checked })}
          />
          Send with {sc('mod', 'Enter')}
        </label>
        <p className="mt-1 text-xs leading-body text-ink-faint">
          Enter then writes a new line instead of sending, which is what you want when a prompt
          runs to several paragraphs. Shift+Enter writes a new line either way.
        </p>
      </div>

      {/*
        A switch to stop the spinning indicator (user request, 2026-09-13).

        It looks like a preference, but it is really a **power setting**. That is why the
        description states a measurement — nobody touches a switch when they do not know what
        turning it off improves. The grid and the icon are kept separate because what bothers
        people about each is different: the panel border is large and catches the corner of the
        eye, while the sidebar icon is small but always visible.
      */}
      <div className="mt-6 border-t border-line pt-4">
        <p className="text-sm text-ink-muted">Spinning mark while a session is working</p>
        <p className="mt-1 text-xs leading-body text-ink-faint">
          Turning it off does not hide the mark — it stops moving and stays a bright grey. Motion
          that never stops holds the display at full refresh: measured, turning both off took this
          app from 7.0% to 2.9% CPU while one session was running.
        </p>
        <label className="mt-2.5 flex items-start gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            className="mt-0.5 accent-line-strong"
            checked={spinGrid}
            onChange={(e) => setSpinGrid(e.target.checked)}
            data-testid="settings-spin-grid"
          />
          <span>Panel border in the grid and on project screens</span>
        </label>
        <label className="mt-1.5 flex items-start gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            className="mt-0.5 accent-line-strong"
            checked={spinIcon}
            onChange={(e) => setSpinIcon(e.target.checked)}
            data-testid="settings-spin-icon"
          />
          <span>Session icon in the sidebar</span>
        </label>
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
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    port
      .get()
      .then((v) => alive && setOn(v))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [port])

  return (
    <section data-testid="settings-background">
      <label className="flex items-start gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          className="mt-0.5 accent-line-strong"
          data-testid="settings-background-toggle"
          checked={on ?? false}
          disabled={on === null}
          onChange={(e) => {
            const next = e.target.checked
            setError(null)
            port
              .set(next)
              .then(setOn)
              .catch((err: Error) => setError(err.message))
          }}
        />
        <span>
          Keep agents running after Centralu quits
          <span className="mt-1 block text-xs leading-body text-ink-faint">
            Closing the window leaves the agent host and its running sessions going. Opening
            Centralu again picks them up where they are, waiting approvals included. Off, quitting
            is always Quit completely and stops them.
          </span>
        </span>
      </label>
      <p className="mt-3 text-xs leading-body text-ink-faint">
        To stop everything anyway, choose <span className="text-ink-muted">Quit completely</span>{' '}
        when you quit: it also stops agents, terminals and running commands. With no window open and
        nothing running for 30 minutes, the background host stops by itself.
      </p>
      {error && (
        <p className="mt-2 text-xs text-danger" data-testid="settings-background-error">
          {error}
        </p>
      )}
    </section>
  )
}
