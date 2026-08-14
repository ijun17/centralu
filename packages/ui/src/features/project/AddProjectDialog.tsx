import { useState } from 'react'
import { useStore } from '../../store/store.js'

/** 웹 dev에서는 디렉토리 피커가 없으므로 경로 입력 (Tauri에서 dialog 플러그인으로 교체) */
export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const addProject = useStore((s) => s.addProject)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/50 pt-32" data-testid="add-project-dialog">
      <form
        className="w-[520px] rounded-lg border border-neutral-700 bg-neutral-950 p-4"
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
        <h2 className="mb-2 text-sm font-medium">프로젝트 추가</h2>
        <input
          autoFocus
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-neutral-500"
          placeholder="/Users/me/projects/my-app"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          data-testid="project-path-input"
        />
        {error && (
          <p className="mt-2 text-xs text-rose-400" data-testid="add-project-error">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2 text-xs">
          <button type="button" className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>
            취소
          </button>
          <button
            className="rounded bg-neutral-700 px-3 py-1 text-white hover:bg-neutral-600 disabled:opacity-50"
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
