import { useStore } from '../../store/store.js'
import { Tooltip } from '../../components/primitives.jsx'

/**
 * "A new version is available" — a quiet line on the dashboard (issue #43).
 *
 * **It only appears when it has something to say.** That is why the shortcut chips were
 * removed from the top bar (issue #33): something that stays on all the time takes attention
 * every time it is seen, and after the first time it has nothing left to tell. This line is the
 * opposite — most of the time it is not there at all, and it only shows up while something new
 * has landed in the registry, then disappears again. That is what earns it a place on the
 * dashboard.
 *
 * **Clicking it is consent.** That is why the label is not "New version available" but "Update
 * to 9.9.9" — the button has to say what it is about to do, because this is not reversible.
 * And once it finishes, **it does not restart on its own.** The decision to swap out the running
 * app belongs to the person, who may be in the middle of a conversation, and this line is where
 * that decision is left to them.
 */
export function UpdateLine() {
  const update = useStore((s) => s.update)
  const applyUpdate = useStore((s) => s.applyUpdate)
  if (!update) return null

  const tone = 'text-[11px] leading-none'

  if (update.phase === 'updating') {
    return (
      <span className={`${tone} text-slate`} data-testid="update-line" role="status">
        Updating…
      </span>
    )
  }

  if (update.phase === 'restart_required') {
    return (
      // ash, not slate: this one is asking for something. Not beacon either — nothing is
      // blocked, and the brightest thing on screen stays reserved for what waits on me.
      <span className={`${tone} text-ash`} data-testid="update-line" role="status">
        Restart Centralu to finish updating{update.latest ? ` to ${update.latest}` : ''}
      </span>
    )
  }

  if (update.phase === 'failed') {
    /*
     * A failed install is not passed over quietly — it is not the same as a failed check.
     *
     * Nobody asked for the check, so it is fine for it to fail quietly, but the install is
     * something the person started by clicking. If it reverts with no explanation, it becomes
     * "I clicked and nothing happened," and then the person clicks it again next time. The
     * reason can be long, so it only unfolds when asked.
     */
    return (
      <Tooltip content={update.error ?? 'Something went wrong'} testId="update-error" align="right">
        <span className={`${tone} text-beacon`} data-testid="update-line">
          Update failed
        </span>
      </Tooltip>
    )
  }

  if (!update.newer || !update.latest) return null

  return (
    <button
      type="button"
      className={`rounded px-2 py-1 ${tone} text-slate transition-colors hover:bg-graphite/50 hover:text-chalk`}
      data-testid="update-line"
      onClick={() => void applyUpdate()}
      title={`Install ${update.latest} (you will be asked to restart, never restarted for you)`}
    >
      Update to {update.latest}
    </button>
  )
}
