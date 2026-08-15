import { useStore, type Tab } from '../../store/store.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 포커스 뷰 탭 셸 (B-0).
 * 깃 패널·파일 트리·뷰어가 들어갈 자리를 먼저 만든다 — 없으면 "어디에 렌더할지"가
 * 실행 시점에 즉흥 결정된다 (플랜 재검증에서 지적된 누락).
 */
const TABS: { id: Tab; label: string; key: string }[] = [
  { id: 'chat', label: '대화', key: '1' },
  { id: 'files', label: '파일', key: '2' },
  { id: 'git', label: '깃', key: '3' },
  { id: 'viewer', label: '뷰어', key: '4' },
]

export function TabBar({ gitDisabled, chatDisabled }: { gitDisabled?: boolean; chatDisabled?: boolean }) {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)

  // 탭 오른쪽 빈 공간도 창을 옮기는 손잡이다 — 잡을 곳이 넓어야 실제로 쓴다
  return (
    <nav
      className="flex items-center gap-0.5 border-b border-edge bg-pit px-2 py-1"
      data-testid="tab-bar"
      data-tauri-drag-region
    >
      {TABS.map((t) => {
        const disabled = (t.id === 'git' && gitDisabled) || (t.id === 'chat' && chatDisabled)
        return (
          <button
            key={t.id}
            onClick={() => !disabled && setTab(t.id)}
            disabled={disabled}
            data-testid={`tab-${t.id}`}
            aria-selected={tab === t.id}
            title={disabled ? (t.id === 'git' ? 'git 저장소가 아닙니다' : '세션을 선택하세요') : `⌘⇧${t.key}`}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] transition-colors disabled:opacity-30 ${
              tab === t.id ? 'bg-graphite/50 text-chalk' : 'text-ash hover:text-chalk'
            }`}
          >
            {t.label}
            <Kbd>{`⌘⇧${t.key}`}</Kbd>
          </button>
        )
      })}
      <span className="h-5 flex-1" data-tauri-drag-region />
    </nav>
  )
}
