import { useEffect, useState } from 'react'
import type { GitBranch } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Modal } from '../../components/Modal.jsx'

/**
 * Starting the worktree manager (#76).
 *
 * **This dialog is entirely about choosing the trunk.** There is nothing else to set for the
 * manager itself — the project already decides its name and its tool. But the trunk (base branch)
 * cannot be guessed on our own: whether it is main, master or develop differs by repository, and a
 * wrong default only shows up **after** a worktree has already branched off from the wrong place.
 * So the screen pre-fills the current branch and the person confirms it — this is the spot where a
 * guess is put in front of the person to be confirmed.
 *
 * Once chosen, the trunk becomes the answer to three questions: where a worktree branches off from,
 * where it merges to, and what "merged" is measured against.
 */
export function WorktreeManagerDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const create = useStore((s) => s.createWorktreeManager)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [branch, setBranch] = useState(project?.git?.branch ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The list only assists — even if it fails to load, the current branch is already in hand, so it does not block creation
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
        /* The same shell as every other modal — if two dialogs opened side by side had different backgrounds, one would look like it belonged to a different app */
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
            // A toast disappears after 2.5 seconds and would look like "nothing happened when pressed" — kept inside the dialog instead
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
          Pick from the list if there is one, or type it directly if there is not. The reason these
          are not merged into a plain select: in a repository with hundreds of branches, a select
          becomes unusable, and in a repository where the list failed to load, having only a select
          would leave nothing that can be done at all.
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
