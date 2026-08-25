import { useCallback, useEffect, useState } from 'react'
import { APP_VERSION, type UpdateStatus } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from '@cc/core'
import { TEXT_SCALES, TEXT_SCALE_DEFAULT, useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'

type Rule = { id: number; scope: string; matcher: string; decision: string; createdAt: number }

/**
 * FR-17 단축키 표 — 설정에서 보고 확인할 수 있어야 한다.
 *
 * 조합은 **뜻으로** 적는다: `'mod'`·`'alt'`는 이 기계의 자판이 이름을 붙이고
 * (`⌘`/`Ctrl`, `⌥`/`Alt`), 나머지 조각은 키 이름 그대로다 (이슈 #32).
 *
 * 데스크톱 앱의 단축키 표는 **지금 이 기계의 자판**을 보여준다. 다른 답은 없다 —
 * 여기 적힌 키를 누르는 곳이 이 기계이기 때문이고, 두 벌을 다 적으면 정작 자기 것을
 * 찾는 데 시간이 든다.
 */
const SHORTCUTS: [string[], string][] = [
  [['mod', 'I'], 'Waiting'],
  // `⇧`는 저 자판들에도 찍혀 있어서 옮길 말이 없다. 뒤 키에 붙여 두는 편이
  // `Ctrl+⇧+A`보다 읽힌다
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
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'updates', label: 'Updates' },
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
  const sc = useShortcut()
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

            {category === 'appearance' && <AppearanceSection />}

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
                  {SHORTCUTS.map(([keys, label]) => (
                    <li key={label} className="flex items-baseline gap-2 text-[12px] text-ash">
                      <Kbd>{sc(...keys)}</Kbd>
                      <span className="truncate">{label}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 업데이트 (이슈 #43) */}
            {category === 'updates' && <UpdatesSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 업데이트 (이슈 #43).
 *
 * 이 화면이 하는 말은 세 문장이다: 지금 도는 것은 이것이고, 저쪽에는 저것이 있고,
 * 올릴지는 당신이 정한다. **자동으로 올리지 않는다** — 도는 앱을 갈아 끼우는 것은
 * 되돌릴 수 없는 일이고, 이 앱은 되돌릴 수 없는 일을 조용히 하지 않는다.
 *
 * 확인은 host가 한다. 실행기(launcher)에도 같은 코드가 있지만 도는 것은 사용자 기계에
 * 이미 깔린 사본이고, 그 사본의 비교가 틀려 있었다 (#42) — 여기서 확인하면 앱과 같이
 * 배포된 코드가 도므로 낡은 실행기를 통째로 건너뛴다.
 */
/**
 * 전체 글자 크기 — 다섯 단계, 가운데가 기본.
 *
 * 미리보기가 곧 라벨이다: 각 단추의 "가Aa"가 실제 그 단계의 배율로 그려지므로,
 * 누르기 전에 결과를 안다. 숫자(85%…)를 따로 쓰지 않는 이유다 — 비율은 읽어도
 * 크기는 보여야 안다.
 */
function AppearanceSection() {
  const scale = useStore((s) => s.textScale)
  const setScale = useStore((s) => s.setTextScale)
  return (
    <section>
      <p className="text-[11px] leading-relaxed text-slate">Text size for the whole app.</p>
      <div className="mt-3 flex items-end gap-2" role="radiogroup" aria-label="Text size">
        {TEXT_SCALES.map((factor, i) => (
          <button
            key={factor}
            type="button"
            role="radio"
            aria-checked={i === scale}
            data-testid={`settings-scale-${i}`}
            onClick={() => setScale(i)}
            className={`rounded border px-2.5 py-1 leading-none transition-colors ${
              i === scale
                ? 'border-ash bg-graphite/40 text-chalk'
                : 'border-edge text-ash hover:bg-graphite/25 hover:text-chalk'
            }`}
            title={i === TEXT_SCALE_DEFAULT ? 'Default' : `${Math.round(factor * 100)}%`}
          >
            <span style={{ fontSize: `${Math.round(13 * factor)}px` }}>가Aa</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate">Applies immediately and is remembered.</p>
    </section>
  )
}

function UpdatesSection() {
  const update = useStore((s) => s.update)
  const checkUpdate = useStore((s) => s.checkUpdate)
  const setUpdateAuto = useStore((s) => s.setUpdateAuto)
  const applyUpdate = useStore((s) => s.applyUpdate)

  /*
   * host가 아직 답하기 전에도 **지금 버전은 말할 수 있다.**
   *
   * 같은 빌드에서 나온 같은 상수이므로(`tooling/brand.test.ts`가 어디서든 같음을 지킨다)
   * 어긋날 여지가 없고, 그 덕에 이 갈래는 여는 순간부터 비어 있지 않다 — 비교의 한쪽이
   * 안 보이면 나머지 줄도 읽을 수 없다.
   */
  const current = update?.current ?? APP_VERSION
  const busy = update?.phase === 'checking' || update?.phase === 'updating'

  return (
    <section>
      <p className="text-[11px] leading-relaxed text-slate">
        Centralu updates through npm, the same way it was installed. Checking only asks the
        registry which version is newest; installing happens when you ask for it, and never
        restarts the app for you.
      </p>

      <p className="mt-3 text-[12px] text-ash" data-testid="update-current">
        Running {current}
      </p>
      <p className="mt-1 text-[12px] text-slate" data-testid="update-state">
        {describe(update)}
      </p>

      <div className="mt-2 flex items-center gap-3">
        <button
          className="rounded border border-edge px-2 py-1 text-[11px] text-ash transition-colors hover:bg-graphite/50 hover:text-chalk disabled:opacity-50"
          data-testid="update-check-now"
          disabled={busy}
          onClick={() => void checkUpdate(true)}
        >
          Check now
        </button>
        {update?.newer && update.latest && update.phase !== 'restart_required' && (
          <button
            className="rounded border border-edge px-2 py-1 text-[11px] text-chalk transition-colors hover:bg-graphite/50 disabled:opacity-50"
            data-testid="update-apply"
            disabled={busy}
            onClick={() => void applyUpdate()}
          >
            Update to {update.latest}
          </button>
        )}
      </div>

      <label className="mt-3 flex items-center gap-2 text-[12px] text-ash">
        <input
          type="checkbox"
          className="accent-graphite"
          data-testid="update-auto"
          checked={update?.auto ?? true}
          onChange={(e) => void setUpdateAuto(e.target.checked)}
        />
        Check for updates automatically
      </label>
      {/*
        켜 두는 것이 기본인 이유를 여기 적어 둔다. 끄는 사람이 무엇을 끄는 것인지 알아야
        하고, 켜 두는 사람도 무엇이 나가는지 알아야 한다 — 몰래 나가는 요청은 없다.
      */}
      <p className="mt-1 text-[11px] leading-relaxed text-slate">
        Once at startup and every six hours while the app is open. It asks the public npm
        registry for one version number and nothing else; if it cannot reach it, nothing
        happens and nothing interrupts you.
      </p>
    </section>
  )
}

/**
 * 한 줄로 "지금 어디쯤인가".
 *
 * **순서가 곧 판단이다.** 진행 중인 것이 먼저고, 그다음이 결과다. 특히 `error`가
 * `latest`보다 뒤에 오면 안 된다 — 네트워크가 잠깐 끊긴 것을 "최신입니다"로 읽어 주는
 * 순간, 확인이 자기 발견을 스스로 지운다 (#42가 한 릴리스 내내 숨어 있던 방식이다).
 */
function describe(u: UpdateStatus | null): string {
  if (!u) return 'Not checked yet'
  if (u.phase === 'checking') return 'Checking…'
  if (u.phase === 'updating') return `Installing ${u.latest ?? 'the new version'}…`
  if (u.phase === 'restart_required') {
    return `Installed ${u.latest ?? 'the new version'}. Restart Centralu to use it.`
  }
  if (u.phase === 'failed') return `Update failed: ${u.error ?? 'unknown reason'}`
  if (u.newer && u.latest) return `${u.latest} is available`
  if (u.error) return u.error
  if (u.latest) return 'Up to date'
  return 'Not checked yet'
}
