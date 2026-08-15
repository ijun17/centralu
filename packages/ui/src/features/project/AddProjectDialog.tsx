import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { Kbd } from '../../components/primitives.jsx'

/** 웹 dev에서는 디렉토리 피커가 없으므로 경로 입력 (Tauri에서 dialog 플러그인으로 교체) */
export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const addProject = useStore((s) => s.addProject)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-void/80 pt-[16vh] backdrop-blur-[2px]"
      onClick={onClose}
      data-testid="add-project-dialog"
    >
      <form
        className="w-[480px] max-w-[90vw] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await addProject(path.trim())
            onClose()
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2 className="text-[13px] font-medium text-chalk">프로젝트 추가</h2>
        <p className="mt-1 text-[11px] text-slate">에이전트를 실행할 디렉토리의 전체 경로를 입력하세요.</p>

        <input
          autoFocus
          className="mt-3 w-full rounded border border-edge bg-panel px-2.5 py-2 font-mono text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="/Users/me/projects/my-app"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          data-testid="project-path-input"
          spellCheck={false}
        />

        {error && (
          <p className="mt-2 text-[11px] text-signal-fault" data-testid="add-project-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[10px] text-slate">
            <Kbd>esc</Kbd> 닫기
          </span>
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-[12px] text-slate hover:text-chalk"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={busy || !path.trim()}
            data-testid="project-add-confirm"
          >
            추가
          </button>
        </div>
      </form>
    </div>
  )
}
