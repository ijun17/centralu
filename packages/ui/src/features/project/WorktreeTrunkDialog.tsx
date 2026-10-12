import { useEffect, useState } from 'react'
import type { GitBranch } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Modal } from '../../components/Modal.jsx'

/**
 * The project's worktree trunk (#76). It was chosen when starting the worktree manager, which was folded into
 * ordinary sessions (#561 part 3); the trunk stayed, as the project's own setting.
 *
 * The trunk (base branch) cannot be guessed on our own: whether it is main, master or develop differs by repository, and a
 * wrong default only shows up **after** a worktree has already branched off from the wrong place.
 * So the screen pre-fills the current branch and the person confirms it — this is the spot where a
 * guess is put in front of the person to be confirmed.
 *
 * Once chosen, the trunk becomes the answer to three questions: where a worktree branches off from,
 * where it merges to, and what "merged" is measured against.
 */
export function WorktreeTrunkDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const save = useStore((s) => s.setWorktreeTrunk)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [branch, setBranch] = useState(project?.worktreeManager?.baseBranch || project?.git?.branch || '')
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
    <Modal onClose={onClose} testId="worktree-trunk-dialog">
      <form
        /* The same shell as every other modal — if two dialogs opened side by side had different backgrounds, one would look like it belonged to a different app */
        className="w-[420px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
        onSubmit={async (e) => {
          e.preventDefault()
          const trunk = branch.trim()
          if (!trunk || busy) return
          setBusy(true)
          setError(null)
          try {
            await save(projectId, trunk)
            onClose()
          } catch (err) {
            // A toast disappears after 2.5 seconds and would look like "nothing happened when pressed" — kept inside the dialog instead
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2 className="text-md font-medium text-ink">Worktree trunk · {project?.name}</h2>
        <p className="mt-2 text-xs leading-body text-ink-muted">
          The branch this project’s worktree sessions fork from, yours and the ones a session starts.
        </p>

        <label className="mt-3 block text-xs text-ink-muted" htmlFor="worktree-trunk">
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
          className="mt-1 w-full rounded-md border border-line bg-surface-floor px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          placeholder="main"
        />
        <datalist id="worktree-trunk-options">
          {(branches ?? []).map((b) => (
            <option key={b.name} value={b.name} />
          ))}
        </datalist>
        <p className="mt-1.5 text-xs leading-body text-ink-faint">
          New worktrees branch off here, and a branch counts as merged once this one contains it.
        </p>

        {error && (
          <p className="mt-2 text-xs text-ink" data-testid="worktree-trunk-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!branch.trim() || busy}
            data-testid="worktree-trunk-confirm"
            className="rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
