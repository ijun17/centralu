import { useEffect } from 'react'
import { useStore } from '../../store/store.js'
import { CodeViewer } from '../viewer/CodeViewer.jsx'
import { GitPanel } from '../git/GitPanel.jsx'
import { Kbd } from '../../components/primitives.jsx'

/**
 * The wide surface — it covers the conversation, and nothing else.
 *
 * Why not inside the right-hand panel: what the viewer is really for here is checking a
 * diff an agent just wrote, and a diff is unreadable at 340px.
 *
 * Why it no longer covers that panel as well: the sentence above got read as "so take the
 * panel's width too", which does not follow from it. The overlay competes with the
 * *conversation* for room, not with the panel. Covering the panel took away the file tree
 * and the change list — the thing you use to open the next file — so the shape of the work
 * became: click a file, watch the tree disappear, press escape, click the next one. Giving
 * up ~340px of diff to stop that is cheap, because the diff is unified: the loss is line
 * width, not a whole column (issue #15). It applies to both kinds, and the `git` kind is
 * the worse of the two to cover, since the list it was opened from is the list you are
 * working down.
 *
 * Why it covers the conversation rather than replacing it: reading code is deep but
 * **short**. Draw the cover back and the conversation is exactly as you left it, scroll
 * position included — the most expensive resource in this app is a person's attention, and
 * making them find their place again on the way back spends it.
 *
 * `inset-0` does not decide **what** gets covered; the parent does. So which lane this
 * component is mounted inside *is* the answer to that question — see Body in App.tsx.
 */
export function Overlay() {
  const overlay = useStore((s) => s.overlay)
  const close = useStore((s) => s.closeOverlay)
  const projectId = useStore((s) => {
    // 연 쪽이 프로젝트를 말했으면 그것이 답이다 — 그리드의 옆 칸 링크 (#182)
    if (s.overlay?.kind === 'viewer' && s.viewerProjectId) return s.viewerProjectId
    // 프로젝트 없는 세션(반장)은 직전 프로젝트로 폴백하지 않는다 — EvidencePanel과 같은 규칙
    const sess = s.focusedSessionId ? s.sessions[s.focusedSessionId] : null
    return sess ? sess.projectId : s.focusedProjectId
  })

  /*
   * esc로 걷는다. 입력창에서 눌러도 걷혀야 한다 — 덮인 채로 갇히면 안 된다.
   *
   * **단, 이 층이 맨 위이고 키가 이 층 쪽에서 왔을 때만이다** (#181). 창의 캡처 단계에서 가로채면 모든 요소보다 먼저
   * 받으므로, 옆에 그대로 보이는 증거 패널의 터미널(vim·less)에 Esc가 가지 않고 오버레이가 닫혔다. 위에 뜬 설정 창·
   * 모달의 Esc도 먼저 가로채, 가려진 오버레이가 닫히고 설정 창은 한 번 더 눌러야 닫혔다.
   */
  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!overlayTakesEscape(useStore.getState(), e.target)) return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [overlay, close])

  if (!overlay || !projectId) return null

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-void" data-testid="overlay">
      <header className="flex items-center gap-2 border-b border-edge bg-pit px-3 py-1.5">
        <span className="text-[11px] uppercase text-slate">
          {overlay.kind === 'git' ? 'Git' : 'Files'}
        </span>
        <button
          className="ml-auto flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] text-ash transition-colors hover:bg-graphite/50 hover:text-chalk"
          onClick={close}
          data-testid="overlay-close"
        >
          <Kbd>esc</Kbd> back to chat
        </button>
      </header>
      {overlay.kind === 'viewer' ? (
        <CodeViewer projectId={projectId} />
      ) : (
        <GitPanel
          projectId={projectId}
          initialPath={overlay.path}
          initialStaged={overlay.staged}
          initialSha={overlay.sha}
          initialSub={overlay.sub}
          pick={overlay.pick}
        />
      )}
    </div>
  )
}

/**
 * 오버레이가 이 Esc를 받는가 (#181). 위에 다른 층(모달·명령 창·설정·팔레트·인박스·사용량)이 떠 있으면 그 층의 것이고,
 * 오버레이 옆의 증거 패널에서 온 키는 그 패널의 것이다(터미널의 Esc).
 */
export function overlayTakesEscape(
  st: { openLayers: number; settingsOpen: boolean; paletteOpen: boolean; inboxOpen: boolean; usageOpen: boolean },
  target: EventTarget | null,
): boolean {
  if (st.openLayers > 0 || st.settingsOpen || st.paletteOpen || st.inboxOpen || st.usageOpen) return false
  const el = target as Element | null
  return !(el && typeof el.closest === 'function' && el.closest('[data-testid="evidence-panel"]'))
}

