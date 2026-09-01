import { useEffect, useState } from 'react'
import type { GitBranch } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Modal } from '../../components/Modal.jsx'

/**
 * 워크트리 매니저 시작 (#76).
 *
 * **이 창의 전부는 줄기를 고르는 것이다.** 매니저 자체에는 정할 것이 없다 — 이름도
 * 도구도 프로젝트가 정한다. 대신 줄기(base branch)는 우리가 지어낼 수 없다:
 * main·master·develop 중 무엇인지는 저장소마다 다르고, 틀린 기본값은 워크트리가
 * 엉뚱한 데서 갈라진 **뒤에야** 드러난다. 그래서 화면이 현재 브랜치를 채워 두고
 * 사람이 확인한다 — 짐작을 사람 눈앞에 놓고 확인받는 자리다.
 *
 * 한 번 정한 줄기는 세 질문의 답이 된다: 워크트리가 어디서 갈라지는가, 어디로
 * 병합하는가, 무엇을 기준으로 "병합됨"을 재는가.
 */
export function WorktreeManagerDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const create = useStore((s) => s.createWorktreeManager)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [branch, setBranch] = useState(project?.git?.branch ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 목록은 거들 뿐이다 — 못 읽어도 현재 브랜치는 이미 손에 있으므로 만들기를 막지 않는다
  useEffect(() => {
    let alive = true
    void platform.git
      .branches(projectId)
      .then((list) => alive && setBranches(list.filter((b) => !b.remote)))
      .catch(() => alive && setBranches([]))
    return () => {
      alive = false
    }
  }, [platform, projectId])

  return (
    <Modal onClose={onClose} testId="worktree-manager-dialog">
      <form
        /* 다른 모달과 같은 껍데기 — 나란히 열리는 창 둘의 바탕이 다르면 한쪽이 남의 앱처럼 보인다 */
        className="w-[420px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onSubmit={async (e) => {
          e.preventDefault()
          const trunk = branch.trim()
          if (!trunk || busy) return
          setBusy(true)
          setError(null)
          try {
            await create(projectId, trunk)
            onClose()
          } catch (err) {
            // 토스트는 2.5초 뒤 사라져 '눌러도 아무 일이 없다'로 보인다 — 창 안에 남긴다
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2 className="text-[13px] font-medium text-chalk">Worktree manager · {project?.name}</h2>
        <p className="mt-2 text-[11px] leading-relaxed text-ash">
          A session that watches this project’s worktree branches — it can propose new ones, read how they are
          going, and merge when you ask it to.
        </p>

        <label className="mt-3 block text-[11px] text-ash" htmlFor="worktree-trunk">
          Branch to fork from
        </label>
        {/*
          목록이 있으면 고르고, 없으면 직접 친다. 하나로 합치지 않는 이유: 브랜치가
          수백 개인 저장소에서 select는 못 쓸 물건이 되고, 목록을 못 읽은 저장소에서
          select만 있으면 아무것도 못 한다.
        */}
        <input
          id="worktree-trunk"
          list="worktree-trunk-options"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          spellCheck={false}
          data-testid="worktree-trunk-input"
          className="mt-1 w-full rounded border border-edge bg-void px-2 py-1.5 font-mono text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="main"
        />
        <datalist id="worktree-trunk-options">
          {(branches ?? []).map((b) => (
            <option key={b.name} value={b.name} />
          ))}
        </datalist>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate">
          New worktrees branch off here, and a branch counts as merged once this one contains it.
        </p>

        {error && (
          <p className="mt-2 text-[11px] text-chalk" data-testid="worktree-manager-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!branch.trim() || busy}
            data-testid="worktree-manager-confirm"
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
          >
            {busy ? 'Starting…' : 'Start manager'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
