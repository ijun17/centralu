import { useEffect, useRef, useState } from 'react'
import { columnsFor, rowsFor, visiblePanels } from '@cc/core'
import { useStore } from '../../store/store.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { SESSION_MIME, dropsBefore, moveTo as reorderIds } from '../sidebar/reorder.js'
import { dropEdge, dropSide, type DropTarget } from './drop.js'

/**
 * 그리드 — 여러 세션을 한 화면에서.
 *
 * 사양서(§5.4)는 그리드를 v1에서 제외했었다. 근거 셋 중 첫 번째 —
 * "패널당 600×400이면 대화도 입력창도 제대로 안 보인다" — 는 지금도 유효하다.
 * 그래서 열 수를 **폭에서 계산해** 패널이 최소 폭 아래로 내려가지 않게 한다
 * (core의 columnsFor). 창이 좁으면 열이 줄고, 끝내 한 줄이 된다.
 *
 * The height is measured too, but only as a guard — see MAX_PANEL_H. It changes nothing
 * on an ordinary screen, so a panel's shape here is still decided by the width.
 *
 * 칸은 포커스 뷰와 **같은 부품(SessionPane)**을 쓴다. 복사본을 두면 여기서 모델을
 * 바꿨을 때 사이드바가 옛 값을 들고 있게 된다 — 화면이 둘이어도 진실은 하나여야 한다.
 */
export function GridView() {
  const panels = useStore((s) => s.gridPanels)
  const sessions = useStore((s) => s.sessions)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1200)
  /** Only a guard — it splits a row off a screen tall enough to make a panel absurd (MAX_PANEL_H) */
  const [height, setHeight] = useState(800)
  /** 놓으면 어디로 갈지 — 어느 칸의 어느 쪽인가 */
  const [over, setOver] = useState<DropTarget>(null)
  /** 지금 끌고 있는 칸. 원본을 흐리게 해서 "이게 움직이는 중"임을 보인다 */
  const [dragging, setDragging] = useState<string | null>(null)
  /** 끌 때 머리글이 아니라 **칸 전체**를 들어 올리기 위한 참조 */
  const cards = useRef(new Map<string, HTMLDivElement>())

  // 열 수가 화면 크기에서 나오므로 크기가 바뀌면 다시 잰다.
  // Kept as two numbers rather than one object so an observer firing with an unchanged
  // dimension does not re-render the whole grid
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      if (!e) return
      setWidth(e.contentRect.width)
      setHeight(e.contentRect.height)
    })
    ro.observe(el)
    const box = el.getBoundingClientRect()
    setWidth(box.width)
    setHeight(box.height)
    return () => ro.disconnect()
  }, [])

  // 지워진 세션이 배치에 남아 있어도 그리지 않는다 (저장된 값은 그대로 둔다)
  const known = new Set(Object.keys(sessions))
  const visible = visiblePanels(panels, known)
  const cols = columnsFor(width, height, visible.length)
  const rows = rowsFor(visible.length, cols)

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
      /*
        스크롤하지 않는다. 아래에 더 있을지 모른다면 그건 목록이지 관제탑이 아니다 —
        화면에 있는 것이 전부여야 "한눈에 본다"가 성립한다.
      */
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-deck p-2"
      data-testid="grid"
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
        <div className="flex flex-1 items-center justify-center text-center" data-testid="grid-empty">
          <p className="text-[13px] leading-relaxed text-ash">
            Drag sessions here from the sidebar
            <span className="mt-1 block text-[11px] text-slate">
              They keep running — this is another way to look at them
            </span>
          </p>
        </div>
      ) : (
        <div
          /*
            높이도 폭처럼 나눠 갖는다. 줄 수를 미리 세어 각 줄에 1fr을 주면
            칸이 몇 개든 화면에 딱 맞는다 — 남는 공간도, 넘치는 부분도 없다.
            minmax(0, 1fr)의 0이 중요하다: 기본 min-content면 내용이 큰 칸이 줄을 밀어낸다.
          */
          className="grid min-h-0 flex-1 gap-2"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {visible.map((id) => (
            <div
              key={id}
              ref={(el) => {
                if (el) cards.current.set(id, el)
                else cards.current.delete(id)
              }}
              /*
                놓을 자리는 **어느 쪽인지**까지 보여야 한다.
                예전엔 칸 전체에 테두리를 둘렀는데, 그러면 "여기 근처"까지만 알 뿐
                앞에 놓이는지 뒤에 놓이는지 손을 떼기 전까지 알 수 없었다 (도그푸딩).

                선은 inset 그림자로 그린다 — border는 칸을 키워서 격자 전체를 민다
                (사이드바에서 겪은 그 문제).
              */
              /*
                응답 중인 칸은 테두리가 돈다 (사이드바 표식과 같은 궤도).
                칸이 여럿일 때 작은 표식 하나로는 어느 것이 도는지 눈이 못 따라간다 —
                그리드는 읽는 화면이 아니라 **보는 화면**이라 곁눈으로 잡혀야 한다.
              */
              className={`relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-edge bg-void transition-opacity ${
                sessions[id]?.state === 'working' ? 'cc-orbit-ring' : ''
              } ${dragging === id ? 'opacity-40' : ''} ${dropEdge(over, id)}`}
              data-testid={`grid-panel-${id}`}
              data-drop={dropSide(over, id)}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SESSION_MIME)) return
                e.preventDefault()
                e.stopPropagation()
                // 자기 자신 위에서는 자리를 표시하지 않는다 — 옮길 곳이 아니다
                if (dragging === id) return setOver(null)
                const r = e.currentTarget.getBoundingClientRect()
                setOver({ id, before: dropsBefore({ top: r.left, height: r.width }, e.clientX) })
              }}
              onDragLeave={() => setOver((cur) => (cur?.id === id ? null : cur))}
              onDragEnd={() => {
                setDragging(null)
                setOver(null)
              }}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData(SESSION_MIME)
                setOver(null)
                setDragging(null)
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

                머리글 슬롯으로 넘긴다. 예전엔 칸 위에 절대좌표로 얹었는데, 그러면
                헤더의 재시작 버튼과 크기도 높이도 따로 놀았다 (12px vs 14px, 다른 흐름).
                같은 줄에 두면 맞출 것이 없다.
              */}
              <SessionPane
                sessionId={id}
                /*
                  칸을 옮기는 손잡이는 **머리글뿐**이다.
                  예전엔 칸 전체가 draggable이었는데, draggable인 조상이 있으면
                  브라우저가 그 안의 글자를 못 고르게 한다 — 대화를 긁으면 칸이 끌려왔다.

                  동시에 이 머리글은 창을 끄는 손잡이가 아니다. 포커스 뷰에서는
                  머리글이 곧 타이틀바지만 여기서는 아니다 — 그대로 뒀더니
                  칸을 옮기려는데 앱 창이 통째로 움직였다 (도그푸딩).
                */
                headerDrag={(e) => {
                  e.dataTransfer.setData(SESSION_MIME, id)
                  e.dataTransfer.effectAllowed = 'move'
                  /*
                     끌리는 것은 **칸이다**, 머리글이 아니다.
                     draggable인 요소가 머리글이라 브라우저는 머리글만 찍어 들고 다녔다 —
                     칸은 제자리에 있고 얇은 띠 하나만 따라다니니 무엇을 옮기는지 알 수 없었다
                     (도그푸딩). 들어 올릴 그림을 칸으로 바꿔준다.
                   */
                  const card = cards.current.get(id)
                  if (card) {
                    const r = card.getBoundingClientRect()
                    e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top)
                  }
                  setDragging(id)
                }}
                headerExtra={
                  <IconButton
                    label="Remove from the grid (the session keeps running)"
                    onClick={() => void setGridPanels(panels.filter((x) => x !== id))}
                    testId={`grid-remove-${id}`}
                    align="right"
                  >
                    <CloseIcon size={14} />
                  </IconButton>
                }
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
