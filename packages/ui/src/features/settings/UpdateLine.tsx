import { APP_VERSION } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { Tooltip } from '../../components/primitives.jsx'
import { Pill } from '../../components/Pill.jsx'
import { installedUpdate, applyOffer, useRelaunchCheck } from './apply-update.js'

/**
 * "A new version is available" (#43), shown only while something new is in the registry: an always-on item costs
 * attention each time it is seen (as shortcut chips did, #33). A press is consent to an irreversible step, so it says
 * what it does. It never restarts by itself unless automatic updates are on; where the desktop app can relaunch with
 * the keeper holding every agent (#352), it offers "Apply now", elsewhere a restart.
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

  // One small "Update" capsule (Pill), shaped as the inbox's; the version and what a press does are in its tooltip. The
  // words change only while it installs and when it failed.
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
    // This window is the new build already; the build bar carries the rest (the restart into this build)
    if (offer.kind === 'current') return null
    if (offer.kind === 'apply') {
      return (
        <Tooltip
          align="right"
          content={
            <span className="flex flex-col gap-1">
              <span>{update.latest ? `${update.latest} is installed` : 'An update is installed'} (this is {APP_VERSION}).</span>
              <span>Press to relaunch into it; running turns go on once it is back, and open terminals and commands start again.</span>
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
        {/* A failure waits on the person: the signal ink at full strength, dashed */}
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
