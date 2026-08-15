import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from '@cc/core'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Kbd } from '../../components/primitives.jsx'

type Rule = { id: number; scope: string; matcher: string; decision: string; createdAt: number }

/** FR-17 단축키 표 — 설정에서 보고 확인할 수 있어야 한다 */
const SHORTCUTS: [string, string][] = [
  ['⌘I', '기다리는 항목'],
  ['⌘⇧A', '다음 대기로 이동'],
  ['⌘K', '커맨드 팔레트'],
  ['⌘1~9', '프로젝트 점프'],
  ['⌘⇧1~4', '탭 전환 (대화·파일·깃·뷰어)'],
  ['y / n / a', '승인 · 거부 · 항상 허용'],
  ['⌥a', '항상 허용 (프로젝트 범위)'],
  ['d', '인박스에서 정리'],
  ['j / k', '인박스 이동'],
  ['Enter / Esc', '보내기 · 닫기'],
]

/**
 * 설정 (E-3, E-4, E-5).
 * 알림 정책·승인 규칙은 **저장만 되고 못 보면 반쪽**이다 — 여기서 보고 지운다.
 */
export function Settings() {
  const open = useStore((s) => s.settingsOpen)
  const toggle = useStore((s) => s.toggleSettings)
  const policy = useStore((s) => s.notifyPolicy)
  const setPolicy = useStore((s) => s.setNotifyPolicy)
  const platform = usePlatform()
  const [rules, setRules] = useState<Rule[] | null>(null)

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
          <h2 className="text-[13px] font-medium text-chalk">설정</h2>
          <span className="ml-auto text-[10px] text-slate">
            <Kbd>esc</Kbd> 닫기
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* E-5 알림 정책 */}
          <section>
            <h3 className="text-[11px] uppercase tracking-[0.12em] text-slate">알림</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-slate">
              알림은 주의를 강제로 가져오는 유일한 수단이라 가장 아껴 씁니다.
            </p>
            <ul className="mt-2 space-y-1.5">
              {(
                [
                  ['approval', '승인 대기 — 에이전트가 막혀 있을 때'],
                  ['error', '오류'],
                  ['allDone', '모든 세션이 일을 마쳤을 때 1회'],
                  ['whenFocused', '앱을 보고 있을 때도 알림'],
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
            <button
              className="mt-2 text-[11px] text-slate underline-offset-2 hover:text-chalk hover:underline"
              onClick={() => setPolicy(DEFAULT_NOTIFY_POLICY)}
            >
              기본값으로
            </button>
          </section>

          {/* E-4 승인 규칙 */}
          <section className="mt-6">
            <h3 className="text-[11px] uppercase tracking-[0.12em] text-slate">항상 허용 규칙</h3>
            <p className="mt-1 text-[11px] text-slate">
              승인 화면에서 <Kbd>a</Kbd>를 누르면 여기에 쌓입니다. 언제든 지울 수 있습니다.
            </p>
            {rules === null ? (
              <p className="mt-2 text-[12px] text-slate">읽는 중…</p>
            ) : rules.length === 0 ? (
              <p className="mt-2 text-[12px] text-slate" data-testid="rules-empty">
                저장된 규칙이 없습니다
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-edge/60 rounded border border-edge" data-testid="rules-list">
                {rules.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <code className="truncate font-mono text-[12px] text-chalk">{r.matcher}</code>
                    <span className="shrink-0 text-[10px] text-slate">
                      {r.scope === 'project' ? '프로젝트' : '세션'}
                    </span>
                    <span className="readout ml-auto shrink-0 text-[10px] text-slate">
                      {new Date(r.createdAt).toLocaleDateString('ko-KR')}
                    </span>
                    <button
                      className="shrink-0 text-[11px] text-slate hover:text-chalk"
                      data-testid={`delete-rule-${r.id}`}
                      onClick={async () => {
                        await platform.rules.remove(r.id)
                        loadRules()
                      }}
                    >
                      지우기
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* E-3 단축키 */}
          <section className="mt-6">
            <h3 className="text-[11px] uppercase tracking-[0.12em] text-slate">단축키</h3>
            <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1" data-testid="shortcut-list">
              {SHORTCUTS.map(([key, label]) => (
                <li key={key} className="flex items-baseline gap-2 text-[12px] text-ash">
                  <Kbd>{key}</Kbd>
                  <span className="truncate">{label}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
