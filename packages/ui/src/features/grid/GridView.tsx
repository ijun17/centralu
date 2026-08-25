import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { columnsFor, rowsFor, visiblePanels } from '@cc/core'
import { useStore, useTextZoom } from '../../store/store.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useOrbitSync } from '../../components/orbit.js'
import { SESSION_MIME, dropsBefore, moveTo as reorderIds } from '../sidebar/reorder.js'

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
  /** Which side of which panel the pointer is on — the preview order derives from this */
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null)
  /** 지금 끌고 있는 칸. 원본을 흐리게 해서 "이게 움직이는 중"임을 보인다 */
  const [dragging, setDragging] = useState<string | null>(null)
  /** 끌 때 머리글이 아니라 **칸 전체**를 들어 올리기 위한 참조 */
  const cards = useRef(new Map<string, HTMLDivElement>())
  /** Conversation scroll positions, taken right before a reorder — see the layout effect below */
  const scrolls = useRef(new Map<string, number>())

  /*
    Reordering panels moves DOM nodes, and the browser resets a moved node's scrollable
    descendants to scrollTop 0 — scroll is layout state, not a DOM property (measured: a
    pane scrolled to 40 came back at 0 after one insertBefore; the node itself survived,
    so `key={id}` was not the culprit and React never learns anything happened — no effect
    in the pane re-runs). Every reflow step would kick each conversation back to the top.

    So the handlers below snapshot every pane's conversation scroll *before* changing the
    order, and this effect puts the values back before paint. It only acts when a snapshot
    was explicitly taken: restoring on every render would clobber a scroll the user made
    while a message streamed in.
  */
  useLayoutEffect(() => {
    if (scrolls.current.size === 0) return
    for (const [id, top] of scrolls.current) {
      const sc = cards.current.get(id)?.querySelector('[data-testid="chat-stream"]')
      if (sc && sc.scrollTop !== top) sc.scrollTop = top
    }
    scrolls.current.clear()
  })

  /** Call before any state change that can reorder the panels */
  const snapshotScroll = () => {
    scrolls.current.clear()
    for (const [id, el] of cards.current) {
      const sc = el.querySelector('[data-testid="chat-stream"]')
      if (sc) scrolls.current.set(id, sc.scrollTop)
    }
  }

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
  /*
   * 실픽셀로 환산해 넘긴다. ResizeObserver의 측정값은 zoom 좌표라, 글자 배율을 올리면
   * 같은 창이 좁게 측정되어 열이 줄었다 — 3단계에서 한 줄이던 그리드가 4단계에서
   * 두 줄이 됐다 (도그푸딩). 칸의 최소 폭(MIN_PANEL_W)은 사이드바·패널 최소와 같은
   * 규칙으로 **실픽셀 고정**이다: 배율은 글자를 키우는 것이지 칸을 좁히는 것이 아니다.
   */
  const zoom = useTextZoom()
  const cols = columnsFor(width * zoom, height * zoom, visible.length)
  const rows = rowsFor(visible.length, cols)

  /*
    While a panel is dragged the grid rearranges live (#53). The old inset edge line said
    "before/after this neighbour", but the grid reflows on drop — so the line pointed at a
    layout that stopped existing the moment you let go. The only display that cannot lie
    about the destination is the destination itself, so we show it: the drop then changes
    nothing visually.

    The preview is **derived**, not stored. The committed order stays in `panels` until the
    drop, so cancelling (Escape, dropping outside — both surface as dragend without drop)
    is nothing more than clearing `over`. Two states that must agree cannot disagree if one
    of them does not exist. A permutation of the same ids also keeps `cols`/`rows` fixed —
    cells must not change size mid-drag, or the cell the hand is aiming at moves.

    Sidebar drags get no preview: dataTransfer payloads are unreadable during dragover
    (browser security), so the grid cannot know *which* session is inbound until the drop —
    and a phantom new cell would change every cell's size anyway.
  */
  const preview = dragging && over ? reorderIds(visible, dragging, over.id, over.before) : null
  const order = preview ?? visible

  /*
    도는 칸의 테두리는 사이드바 표식과 **같은 각도**에 있어야 한다 (components/orbit.ts).
    도는 중인 세션을 뒤늦게 그리드로 데려오면 칸의 궤도만 거기서 0부터 시작하기 때문이다.
  */
  useOrbitSync(visible.filter((id) => sessions[id]?.state === 'working').join(' '))

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
        snapshotScroll()
        /*
          Dropping a grid panel on the padding or a gap: the screen is showing the preview,
          so that is what must survive the drop. Falling through to dropSession here would
          append-or-ignore — the arrangement the user is looking at would silently revert.
        */
        if (id === dragging && preview) {
          void setGridPanels(preview)
        } else {
          dropSession(id, null, false)
        }
        setOver(null)
        setDragging(null)
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
          {order.map((id) => (
            <div
              key={id}
              ref={(el) => {
                if (el) cards.current.set(id, el)
                else cards.current.delete(id)
              }}
              /*
                응답 중인 칸은 테두리가 돈다 (사이드바 표식과 같은 궤도).
                칸이 여럿일 때 작은 표식 하나로는 어느 것이 도는지 눈이 못 따라간다 —
                그리드는 읽는 화면이 아니라 **보는 화면**이라 곁눈으로 잡혀야 한다.
              */
              className={`relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-edge bg-void transition-opacity ${
                sessions[id]?.state === 'working' ? 'cc-orbit-ring' : ''
              } ${dragging === id ? 'opacity-40' : ''}`}
              data-testid={`grid-panel-${id}`}
              /*
                Where the dragged thing lands relative to this panel. The edge line that used
                to draw this is gone — the reflow shows it — but tests and assistive tech
                still need the relation as a value, not as a pixel position to reverse-engineer.
              */
              data-drop={over?.id === id ? (over.before ? 'before' : 'after') : undefined}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SESSION_MIME)) return
                e.preventDefault()
                e.stopPropagation()
                /*
                  Over the dragged panel itself: keep the last target instead of clearing it.
                  The reflow routinely puts the dragged panel under the pointer (hover B's far
                  half → the panels swap → the pointer is now on the dragged panel). Clearing
                  here would snap the preview back and the two orders would flicker in a loop.
                */
                if (dragging === id) return
                const r = e.currentTarget.getBoundingClientRect()
                const before = dropsBefore({ top: r.left, height: r.width }, e.clientX)
                // dragover fires continuously, even with the pointer still — only re-render on change
                if (over?.id === id && over.before === before) return
                snapshotScroll()
                setOver({ id, before })
              }}
              onDragEnd={() => {
                // Fires with or without a drop — Escape and dropping outside land here too,
                // and clearing `over` *is* the rollback (the preview is derived from it)
                snapshotScroll()
                setDragging(null)
                setOver(null)
              }}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData(SESSION_MIME)
                snapshotScroll()
                setOver(null)
                setDragging(null)
                if (!dragged) return
                e.preventDefault()
                e.stopPropagation()
                // A grid panel commits exactly what the preview shows — anything else could
                // make the drop change the screen, which is what #53 removes
                if (dragged === dragging && preview) return void setGridPanels(preview)
                const r = e.currentTarget.getBoundingClientRect()
                dropSession(dragged, id, dropsBefore({ top: r.left, height: r.width }, e.clientX))
              }}
            >
              {/*
                회전 테두리는 실제 자식 레이어가 그린다 (styles/index.css의 cc-orbit-ring-layer).
                칸의 cc-orbit-ring 클래스는 '이 칸이 돌고 있다'는 표식으로 남는다 — 테스트와
                보조 기술이 상태를 픽셀이 아니라 값으로 읽을 수 있게.
              */}
              {sessions[id]?.state === 'working' && <div className="cc-orbit-ring-layer" aria-hidden />}
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
