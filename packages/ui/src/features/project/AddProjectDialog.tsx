import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { Kbd } from '../../components/primitives.jsx'
import { Modal } from '../../components/Modal.jsx'

/** 웹 dev에서는 디렉토리 피커가 없으므로 경로 입력 (Tauri에서 dialog 플러그인으로 교체) */
export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const addProject = useStore((s) => s.addProject)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /*
    직접 `absolute inset-0`으로 그리다가 Modal로 바꿨다.
    이 창을 여는 버튼이 사이드바(이슈 #4)로 내려왔는데, 사이드바에는 폭 조절 손잡이
    때문에 `relative`가 붙어 있다 — absolute는 그걸 기준으로 자리를 잡으므로
    창이 **사이드바 폭 안에 갇힌다**. 같은 함정을 Modal이 이미 포털로 막아 두었다.
  */
  return (
    <Modal onClose={onClose} testId="add-project-dialog" align="top">
      <form
        className="w-[480px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
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
        <h2 className="text-[13px] font-medium text-chalk">Add project</h2>
        <p className="mt-1 text-[11px] text-slate">Enter the full path of the directory where agents will run.</p>

        <input
          autoFocus
          className="mt-3 w-full rounded border border-edge bg-panel px-2.5 py-2 font-mono text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="/Users/me/projects/my-app"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          data-testid="project-path-input"
          spellCheck={false}
        />

        {error && (
          <p className="mt-2 text-[11px] text-beacon" data-testid="add-project-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[10px] text-slate">
            <Kbd>esc</Kbd> Close
          </span>
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-[12px] text-slate hover:text-chalk"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={busy || !path.trim()}
            data-testid="project-add-confirm"
          >
            Add
          </button>
        </div>
      </form>
    </Modal>
  )
}
