import { APP_VERSION } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { Tooltip } from '../../components/primitives.jsx'
import { applyOffer, useRelaunchCheck } from './apply-update.js'

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
 * And once it finishes, **it does not restart on its own** unless the person turned on "Apply
 * updates automatically when idle". Where the desktop app can relaunch into the installed build
 * without cutting anything (#352: the keeper holds every agent through it), the line offers
 * "Apply now"; elsewhere it says to restart, as before.
 *
 * @param waiting what an automatic apply waits for (`useAutoApplyUpdate`), null when none is pending
 */
export function UpdateLine({ waiting = null }: { waiting?: string | null }) {
  const update = useStore((s) => s.update)
  const applyUpdate = useStore((s) => s.applyUpdate)
  const applyUpdateNow = useStore((s) => s.applyUpdateNow)
  const relaunch = useRelaunchCheck()
  if (!update) return null

  const tone = 'text-xs leading-none'

  if (update.phase === 'updating') {
    return (
      <span className={`${tone} text-ink-faint`} data-testid="update-line" role="status">
        Updating…
      </span>
    )
  }

  if (update.phase === 'restart_required') {
    const offer = applyOffer(update, APP_VERSION, relaunch)
    // This window is the new build already; the build bar carries the rest (the switch)
    if (offer.kind === 'current') return null
    if (offer.kind === 'apply') {
      return (
        <span className={`${tone} flex items-center gap-1.5 text-ink-muted`} data-testid="update-line" role="status">
          {update.latest ? `${update.latest} installed` : 'Update installed'}
          {waiting && <span className="text-ink-faint" data-testid="update-waiting">· applies when idle</span>}
          <button
            type="button"
            className="rounded-md px-1.5 py-1 text-ink transition-colors hover:bg-surface-hover/50"
            data-testid="update-apply-now"
            onClick={() => void applyUpdateNow()}
            title={
              waiting
                ? `Waiting because ${waiting}. Apply now relaunches Centralu; running agents and terminals keep going.`
                : 'Relaunches Centralu into the new version; running agents and terminals keep going.'
            }
          >
            Apply now
          </button>
        </span>
      )
    }
    return (
      // ink-muted, not ink-faint: this one is asking for something. Not ink-signal either — nothing is
      // blocked, and the brightest thing on screen stays reserved for what waits on me.
      <span className={`${tone} text-ink-muted`} data-testid="update-line" role="status" title={offer.reason}>
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
        <span className={`${tone} text-ink-signal`} data-testid="update-line">
          Update failed
        </span>
      </Tooltip>
    )
  }

  if (!update.newer || !update.latest) return null

  return (
    <button
      type="button"
      className={`rounded-md px-2 py-1 ${tone} text-ink-faint transition-colors hover:bg-surface-hover/50 hover:text-ink`}
      data-testid="update-line"
      onClick={() => void applyUpdate()}
      title={`Install ${update.latest}. Nothing restarts until you apply it.`}
    >
      Update to {update.latest}
    </button>
  )
}
