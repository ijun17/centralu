import { useEffect, useState } from 'react'
import { APP_VERSION, isNewerVersion, type UpdateStatus } from '@cc/protocol'
import type { RelaunchCheck } from '@cc/platform/ports'
import { useStore } from '../../store/store.js'

/**
 * Applying an installed update (#352): what the update line offers once the host has installed a
 * newer version, and when "Apply updates automatically when idle" relaunches by itself.
 *
 * The decisions are pure so the rules are tested without a window; the hooks below only feed them.
 */

/** What the update line says once the host reports `restart_required` */
export type ApplyOffer =
  /** "Apply now": relaunching starts the new build, and the keeper holds everything through it */
  | { kind: 'apply' }
  /** The old wording: this platform cannot relaunch into it, and `reason` says why when known */
  | { kind: 'restart'; reason?: string }
  /**
   * This window already runs the installed version: the relaunch happened, and what is left is
   * the keeper and host switch, which the desktop build bar shows. Saying "restart" here would ask
   * for a relaunch that changes nothing.
   */
  | { kind: 'current' }

/**
 * @param windowVersion the version this window was built from (`APP_VERSION`); the host's
 *   `current` is the host's, which stays the old one until the switch
 * @param relaunch the platform's answer to "would a relaunch start another build", undefined where
 *   the platform cannot relaunch at all, null while it has not answered yet
 */
export function applyOffer(update: UpdateStatus, windowVersion: string, relaunch: RelaunchCheck | null | undefined): ApplyOffer {
  if (update.latest && !isNewerVersion(update.latest, windowVersion)) return { kind: 'current' }
  if (relaunch?.ready) return { kind: 'apply' }
  return { kind: 'restart', ...(relaunch?.reason ? { reason: relaunch.reason } : {}) }
}

/**
 * How long after the last keystroke in a text field the window counts as "someone is typing". A
 * relaunch reloads the window; the composer keeps a draft, but a sentence half typed into a dialog
 * would be lost, and a window swapping itself out under someone's fingers reads as a crash.
 */
export const TYPING_QUIET_MS = 20_000

export type AutoApplyInput = {
  update: UpdateStatus | null
  windowVersion: string
  relaunch: RelaunchCheck | null | undefined
  /** The keeper's activity report; null while unknown */
  busy: boolean | null
  /** A keystroke in a text field within `TYPING_QUIET_MS` */
  typing: boolean
  /** This window already tried once; a failure is shown, not retried in a loop */
  tried: boolean
}

/**
 * Whether "Apply updates automatically when idle" relaunches now, and if not, what it waits for.
 *
 * - Only with the setting on, an install finished, and a relaunch that starts another build.
 * - Never from a window that already runs the installed version: that window is the relaunched
 *   one, and a relaunch from it would loop.
 * - Never while busy: a session working, waiting for an approval or a question, a terminal or a
 *   command running (the host's one idle rule, `hostBusy`, reported through the keeper). Unknown
 *   counts as busy, as it does for the switch's question.
 * - Never while someone is typing.
 */
export function autoApplyDecision(i: AutoApplyInput): { apply: boolean; waitingFor?: string } {
  const u = i.update
  if (!u?.autoApply || u.phase !== 'restart_required' || i.tried) return { apply: false }
  if (applyOffer(u, i.windowVersion, i.relaunch).kind !== 'apply') return { apply: false }
  if (i.busy !== false) return { apply: false, waitingFor: 'something is running' }
  if (i.typing) return { apply: false, waitingFor: 'you are typing' }
  return { apply: true }
}

/*
 * Typing, seen from the window: the last keydown in an editable field. One capture listener for
 * the whole window, installed on first use; cheap enough to leave on.
 */
let lastTypedAt = 0
let typingTracked = false
function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox')
}
function trackTyping(): void {
  if (typingTracked || typeof window === 'undefined') return
  typingTracked = true
  const mark = (e: Event) => {
    if (isEditable(e.target)) lastTypedAt = Date.now()
  }
  window.addEventListener('keydown', mark, true)
  window.addEventListener('compositionupdate', mark, true)
}
export function typedWithin(ms: number, now = Date.now()): boolean {
  return lastTypedAt > 0 && now - lastTypedAt < ms
}

/**
 * The platform's "would a relaunch start the new build", asked again whenever the update reaches
 * `restart_required`. Undefined where the platform cannot relaunch at all.
 */
export function useRelaunchCheck(): RelaunchCheck | null | undefined {
  const relaunch = useStore((s) => s.platform?.relaunch)
  const phase = useStore((s) => s.update?.phase)
  const [check, setCheck] = useState<RelaunchCheck | null>(null)
  useEffect(() => {
    if (!relaunch || phase !== 'restart_required') return setCheck(null)
    let live = true
    void relaunch
      .check()
      .then((c) => live && setCheck(c))
      .catch((e: Error) => live && setCheck({ ready: false, reason: e.message }))
    return () => {
      live = false
    }
  }, [relaunch, phase])
  return relaunch ? check : undefined
}

/** How often a pending automatic apply looks again, for the typing pause to run out */
const RECHECK_MS = 5_000

/**
 * "Apply updates automatically when idle" (#352), mounted once in the app. Watches the update,
 * the keeper's activity report and typing, and relaunches once `autoApplyDecision` says so.
 * Returns what it waits for, for the update line.
 */
export function useAutoApplyUpdate(): string | null {
  const update = useStore((s) => s.update)
  const relaunchPort = useStore((s) => s.platform?.relaunch)
  const applyUpdateNow = useStore((s) => s.applyUpdateNow)
  const relaunch = useRelaunchCheck()
  const [busy, setBusy] = useState<boolean | null>(null)
  // Only re-renders, so the decision below is taken again when just the clock moved
  const [, setTick] = useState(0)
  const [tried, setTried] = useState(false)
  const pending = !!update?.autoApply && update.phase === 'restart_required'

  useEffect(() => trackTyping(), [])
  useEffect(() => {
    if (!relaunchPort || !pending) return
    return relaunchPort.watchBusy(setBusy)
  }, [relaunchPort, pending])
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => setTick((n) => n + 1), RECHECK_MS)
    return () => clearInterval(t)
  }, [pending])

  const decision = autoApplyDecision({
    update,
    windowVersion: APP_VERSION,
    relaunch,
    busy,
    typing: typedWithin(TYPING_QUIET_MS),
    tried,
  })
  useEffect(() => {
    if (!decision.apply) return
    setTried(true)
    void applyUpdateNow()
  }, [decision.apply, applyUpdateNow])
  return pending ? (decision.waitingFor ?? null) : null
}

/**
 * "Where things stand right now," in one line.
 *
 * **The order itself is the judgment.** Whatever is in progress comes first, the outcome comes
 * after. In particular, `error` must never come after `latest` — the moment a brief network
 * drop gets read back as "you are up to date," the check erases its own finding (this is
 * exactly how #42 stayed hidden for an entire release).
 */
export function updateStateText(u: UpdateStatus | null, offer: ApplyOffer | null): string {
  if (!u) return 'Not checked yet'
  if (u.phase === 'checking') return 'Checking…'
  if (u.phase === 'updating') return `Installing ${u.latest ?? 'the new version'}…`
  if (u.phase === 'restart_required') {
    const v = u.latest ?? 'the new version'
    if (offer?.kind === 'current') return `This window runs ${v}. The agent host switches to it from the bar above.`
    if (offer?.kind === 'apply') return `Installed ${v}. Apply it to relaunch into it.`
    return `Installed ${v}. Restart Centralu to use it.`
  }
  if (u.phase === 'failed') return `Update failed: ${u.error ?? 'unknown reason'}`
  if (u.newer && u.latest) return `${u.latest} is available`
  if (u.error) return u.error
  if (u.latest) return 'Up to date'
  return 'Not checked yet'
}
