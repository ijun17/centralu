import { APP_VERSION } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { Tooltip } from '../../components/primitives.jsx'
import { Pill } from '../../components/Pill.jsx'
import { installedUpdate, applyOffer, useRelaunchCheck } from './apply-update.js'

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
  const reportedUpdate = useStore((s) => s.update)
  const applyUpdate = useStore((s) => s.applyUpdate)
  const applyUpdateNow = useStore((s) => s.applyUpdateNow)
  const relaunch = useRelaunchCheck()
  const update = installedUpdate(reportedUpdate, APP_VERSION, relaunch)
  if (!update) return null

  /*
   * One small capsule that says "Update" (owner, 2026-10-18), in the inbox capsule's shape; the version and what a
   * press does are in its tooltip, not written across the top bar. The words change only where they must: while it
   * installs, and when it failed. The capsule is Pill (components/Pill.tsx).
   */
  if (update.phase === 'updating') {
    return (
      <Tooltip content={`Installing ${update.latest ?? 'the new version'}. Nothing restarts until you apply it.`} align="right">
        <Pill edge="quiet" data-testid="update-line" role="status">
          <UpdateIcon />
          Updating…{update.error && ` ${update.error}`}
        </Pill>
      </Tooltip>
    )
  }

  if (update.phase === 'waiting_for_npm') {
    return (
      <Tooltip content={update.error ?? 'The new version is published, and npm is not serving it yet. It installs once npm does.'} align="right">
        <Pill edge="quiet" data-testid="update-line" role="status">
          <UpdateIcon />
          Update
        </Pill>
      </Tooltip>
    )
  }

  if (update.phase === 'restart_required') {
    const offer = applyOffer(update, APP_VERSION, relaunch)
    // This window is the new build already; the build bar carries the rest (the switch)
    if (offer.kind === 'current') return null
    if (offer.kind === 'apply') {
      return (
        <Tooltip
          align="right"
          content={
            <span className="flex flex-col gap-1">
              <span>{update.latest ? `${update.latest} is installed` : 'An update is installed'} (this is {APP_VERSION}).</span>
              <span>Press to relaunch into it; running agents and terminals keep going.</span>
              {waiting && <span data-testid="update-waiting">It applies by itself once idle: waiting because {waiting}.</span>}
              {update.error && <span>{update.error}</span>}
            </span>
          }
        >
          <span className="flex" data-testid="update-line" role="status">
            <Pill edge="live" data-testid="update-apply-now" onClick={() => void applyUpdateNow()}>
              <UpdateIcon />
              Update
            </Pill>
          </span>
        </Tooltip>
      )
    }
    return (
      <Tooltip content={`${offer.reason ?? ''} Restart Centralu to finish updating${update.latest ? ` to ${update.latest}` : ''}.${update.error ? ` ${update.error}` : ''}`} align="right">
        <Pill edge="quiet" data-testid="update-line" role="status">
          <UpdateIcon />
          Restart to update
        </Pill>
      </Tooltip>
    )
  }

  if (update.phase === 'failed') {
    return (
      <Tooltip content={update.error ?? 'Something went wrong'} testId="update-error" align="right">
        {/* A failure waits on the person: the signal ink at full strength, dashed (owner, 2026-10-18) */}
        <Pill edge="dashed" data-testid="update-line">
          <UpdateIcon />
          Update failed
        </Pill>
      </Tooltip>
    )
  }

  if (!update.newer || !update.latest) return null

  return (
    <Tooltip content={`${update.latest} is out (this is ${APP_VERSION}). Press to install it; nothing restarts until you apply it.`} align="right">
      <Pill edge="live" data-testid="update-line" onClick={() => void applyUpdate()}>
        <UpdateIcon />
        Update
      </Pill>
    </Tooltip>
  )
}

/** An arrow up out of a line: a new version to take */
function UpdateIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path d="M6 8.5V2M3.2 4.8 6 2l2.8 2.8M2 10.5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
