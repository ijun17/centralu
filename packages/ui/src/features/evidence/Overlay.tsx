import { useEffect } from 'react'
import { useStore } from '../../store/store.js'
import { CodeViewer } from '../viewer/CodeViewer.jsx'
import { GitPanel } from '../git/GitPanel.jsx'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 넓은 표면 — 대화 위를 덮는다.
 *
 * 왜 우측 패널 안이 아닌가: 이 앱에서 뷰어의 주 용도는 사실상
 * '에이전트가 만든 diff 확인'인데, 340px에서 diff는 읽을 수가 없다.
 *
 * 왜 대화 자리를 뺏지 않는가: 코드를 읽는 건 깊지만 **짧은** 행위다.
 * 덮었다 걷으면 대화는 스크롤 위치까지 그대로 돌아온다 —
 * 이 앱에서 가장 비싼 자원은 사람의 주의고, 돌아올 때 다시 찾게 만들면 안 된다.
 */
export function Overlay() {
  const overlay = useStore((s) => s.overlay)
  const close = useStore((s) => s.closeOverlay)
  const projectId = useStore((s) => {
    const focused = s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null
    return focused ?? s.focusedProjectId
  })

  // esc로 걷는다. 입력창에서 눌러도 걷혀야 한다 — 덮인 채로 갇히면 안 된다
  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
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
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">
          {overlay.kind === 'git' ? '깃' : '파일'}
        </span>
        <button
          className="ml-auto flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] text-ash transition-colors hover:bg-graphite/50 hover:text-chalk"
          onClick={close}
          data-testid="overlay-close"
        >
          <Kbd>esc</Kbd> 대화로 돌아가기
        </button>
      </header>
      {overlay.kind === 'viewer' ? (
        <CodeViewer projectId={projectId} />
      ) : (
        <GitPanel projectId={projectId} initialPath={overlay.path} initialSha={overlay.sha} initialSub={overlay.sub} />
      )}
    </div>
  )
}
