import { useEffect, useRef, useState } from 'react'
import { columnsFor, visiblePanels } from '@cc/core'
import { useStore } from '../../store/store.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { SESSION_MIME, dropsBefore, moveTo as reorderIds } from '../sidebar/reorder.js'

/**
 * 컨트롤 센터 — 여러 세션을 한 화면에서.
 *
 * 사양서(§5.4)는 그리드를 v1에서 제외했었다. 근거 셋 중 첫 번째 —
 * "패널당 600×400이면 대화도 입력창도 제대로 안 보인다" — 는 지금도 유효하다.
 * 그래서 열 수를 **폭에서 계산해** 패널이 최소 폭 아래로 내려가지 않게 한다
 * (core의 columnsFor). 창이 좁으면 열이 줄고, 끝내 한 줄이 된다.
 *
 * 칸은 포커스 뷰와 **같은 부품(SessionPane)**을 쓴다. 복사본을 두면 여기서 모델을
 * 바꿨을 때 사이드바가 옛 값을 들고 있게 된다 — 화면이 둘이어도 진실은 하나여야 한다.
 */
export function ControlCenter() {
  const panels = useStore((s) => s.gridPanels)
  const sessions = useStore((s) => s.sessions)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1200)
  const [over, setOver] = useState<string | null>(null)

  // 열 수가 폭에서 나오므로 폭이 바뀌면 다시 잰다
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  // 지워진 세션이 배치에 남아 있어도 그리지 않는다 (저장된 값은 그대로 둔다)
  const known = new Set(Object.keys(sessions))
  const visible = visiblePanels(panels, known)
  const cols = columnsFor(width, visible.length)

  /** 사이드바에서 끌어온 세션을 받는다 — 이미 있으면 그 자리로 옮긴다 */
  const dropSession = (id: string, targetId: string | null, before: boolean) => {
    if (!known.has(id)) return
    const next = panels.includes(id)
      ? targetId
        ? reorderIds(panels, id, targetId, before)
        : panels
      : targetId
        ? reorderIds([...panels, id], id, targetId, before)
        : [...panels, id]
    void setGridPanels(next)
  }

  return (
    <section
      ref={ref}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-void p-2"
      data-testid="control-center"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SESSION_MIME)) e.preventDefault()
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SESSION_MIME)
        if (!id) return
        e.preventDefault()
        dropSession(id, null, false)
      }}
    >
      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-center" data-testid="control-center-empty">
          <p className="text-[13px] leading-relaxed text-ash">
            Drag sessions here from the sidebar
            <span className="mt-1 block text-[11px] text-slate">
              They keep running — this is another way to look at them
            </span>
          </p>
        </div>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {visible.map((id) => (
            <div
              key={id}
              /*
                놓을 자리 표시는 inset 그림자다 — border는 칸을 1px 키워서
                끌고 다니는 동안 격자 전체가 밀린다 (사이드바에서 겪은 그 문제).
              */
              className={`relative flex h-[52vh] min-h-[320px] flex-col overflow-hidden rounded-lg border border-edge ${
                over === id ? 'shadow-[inset_0_0_0_2px_var(--color-ash)]' : ''
              }`}
              data-testid={`grid-panel-${id}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(SESSION_MIME, id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SESSION_MIME)) return
                e.preventDefault()
                e.stopPropagation()
                setOver(id)
              }}
              onDragLeave={() => setOver((cur) => (cur === id ? null : cur))}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData(SESSION_MIME)
                setOver(null)
                if (!dragged) return
                e.preventDefault()
                e.stopPropagation()
                const r = e.currentTarget.getBoundingClientRect()
                dropSession(dragged, id, dropsBefore({ top: r.left, height: r.width }, e.clientX))
              }}
            >
              {/*
                빼기는 화면에서만 내린다 — 세션은 사이드바에 그대로 남고 계속 돌아간다.
                그래서 '삭제'가 아니라 '치우기'로 말한다.
              */}
              <span className="absolute right-1 top-1 z-10">
                <IconButton
                  label="Remove from Control Center (the session keeps running)"
                  onClick={() => void setGridPanels(panels.filter((x) => x !== id))}
                  testId={`grid-remove-${id}`}
                  align="right"
                >
                  <CloseIcon size={12} />
                </IconButton>
              </span>
              <SessionPane sessionId={id} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
