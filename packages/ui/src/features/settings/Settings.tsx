import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from '@cc/core'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Kbd } from '../../components/primitives.jsx'

type Rule = { id: number; scope: string; matcher: string; decision: string; createdAt: number }

/** FR-17 단축키 표 — 설정에서 보고 확인할 수 있어야 한다 */
const SHORTCUTS: [string, string][] = [
  ['⌘I', 'Waiting'],
  ['⌘⇧A', 'Jump to next waiting'],
  ['⌘K', 'Command palette'],
  ['⌘1~9', 'Jump to project'],
  ['⌘⇧1~4', 'Switch tab (chat · files · git · viewer)'],
  ['y / n / a', 'Approve · deny · always allow'],
  ['⌥a', 'Always allow (project scope)'],
  ['d', 'Dismiss from inbox'],
  ['j / k', 'Move in inbox'],
  ['Enter / Esc', 'Send · close'],
]

/**
 * The window's categories.
 *
 * Named after the errand someone arrives with, not after the module that implements the
 * setting: people come here to stop being pinged, to take back an always-allow they regret,
 * or to look up a key. Naming by module would put the next setting wherever its code lives,
 * which is the one thing the person looking for it cannot know.
 *
 * There are three, and three is meant to hold. A category per setting reads worse than no
 * categories at all, so a new one has to earn its place by having somewhere to belong —
 * quiet hours land in Notifications, a default preset in Permissions, rebinding in Shortcuts.
 */
const CATEGORIES = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'shortcuts', label: 'Shortcuts' },
] as const

type Category = (typeof CATEGORIES)[number]['id']

/**
 * 설정 (E-3, E-4, E-5).
 * 알림 정책·승인 규칙은 **저장만 되고 못 보면 반쪽**이다 — 여기서 보고 지운다.
 *
 * One category at a time, chosen from the rail on the left. The sections used to stack into
 * a single scroll, which reads fine at three and stops reading the moment there are eight —
 * and settings only ever arrive. Choosing where a thing goes is a decision made once, here;
 * scrolling past everything else is a cost paid on every visit.
 */
export function Settings() {
  const open = useStore((s) => s.settingsOpen)
  const toggle = useStore((s) => s.toggleSettings)
  const policy = useStore((s) => s.notifyPolicy)
  const setPolicy = useStore((s) => s.setNotifyPolicy)
  const platform = usePlatform()
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [category, setCategory] = useState<Category>('notifications')

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
      className="absolute inset-0 z-40 flex items-start justify-center bg-void/80 pt-[8vh] backdrop-blur-[2px]"
      onClick={() => toggle(false)}
      data-testid="settings"
    >
      <div
        className="flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline gap-2 border-b border-edge px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-chalk">Settings</h2>
          <span className="ml-auto text-[10px] text-slate">
            <Kbd>esc</Kbd> Close
          </span>
        </header>

        <div className="flex min-h-0 flex-1">
          {/*
            The rail is the index. It says what this window holds without opening anything,
            which a scroll can only do by being short — and it will not stay short.
          */}
          <nav
            className="w-[132px] shrink-0 space-y-0.5 border-r border-edge p-2"
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
                className={`w-full rounded px-2 py-1 text-left text-[12px] transition-colors ${
                  c.id === category ? 'bg-edge text-chalk' : 'text-ash hover:text-chalk'
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
            {/* E-5 알림 정책 */}
            {category === 'notifications' && (
              <section>
                <p className="text-[11px] leading-relaxed text-slate">
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
                      <label className="flex items-center gap-2 text-[12px] text-ash">
                        <input
                          type="checkbox"
                          className="accent-graphite"
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
                    className="text-[11px] text-slate underline-offset-2 hover:text-chalk hover:underline"
                    onClick={() => setPolicy(DEFAULT_NOTIFY_POLICY)}
                  >
                    Reset to defaults
                  </button>
                </div>
              </section>
            )}

            {/* E-4 승인 규칙 */}
            {category === 'permissions' && (
              <section>
                <p className="text-[11px] leading-relaxed text-slate">
                  Pressing <Kbd>a</Kbd> on an approval adds an always-allow rule here. Delete any of them
                  anytime.
                </p>
                {rules === null ? (
                  <p className="mt-2 text-[12px] text-slate">Loading…</p>
                ) : rules.length === 0 ? (
                  <p className="mt-2 text-[12px] text-slate" data-testid="rules-empty">
                    No saved rules
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-edge/60 rounded border border-edge" data-testid="rules-list">
                    {rules.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5">
                        <code className="truncate font-mono text-[12px] text-chalk">{r.matcher}</code>
                        <span className="shrink-0 text-[10px] text-slate">
                          {r.scope === 'project' ? 'Project' : 'Session'}
                        </span>
                        <span className="readout ml-auto shrink-0 text-[10px] text-slate">
                          {new Date(r.createdAt).toLocaleDateString('en-US')}
                        </span>
                        <button
                          className="shrink-0 text-[11px] text-slate hover:text-chalk"
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
              </section>
            )}

            {/* E-3 단축키 */}
            {category === 'shortcuts' && (
              <section>
                <ul className="grid grid-cols-2 gap-x-6 gap-y-1" data-testid="shortcut-list">
                  {SHORTCUTS.map(([key, label]) => (
                    <li key={key} className="flex items-baseline gap-2 text-[12px] text-ash">
                      <Kbd>{key}</Kbd>
                      <span className="truncate">{label}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
