import type { Ref } from 'react'
import { useOpenLayer } from '@cc/ui'
// By path, like the switch plan below: @cc/ui exports neither, and this dialog keeps the app's shared parts (#1128)
import { Button } from '../../../packages/ui/src/components/Button.jsx'
import { Switch } from '../../../packages/ui/src/components/Switch.jsx'
// By path, like build-bar.tsx: the browser harness that drives this dialog in e2e has no Tauri
import { COMPLETELY_STOPS } from '../../../packages/platform/src/tauri/switch-plan.js'

export type Stray = { pid: number; command: string; cwd: string }

/**
 * The quit question (dogfooding 2026-09-04, #280). Its buttons follow background mode ("Keep agents
 * running after Centralu quits"):
 *
 * - **Off** (or unknown, or no keeper): quitting already stops the keeper, the host and everything
 *   they hold, so there is one way out and it says so: **Quit completely** (Enter).
 * - **On**: **Quit** (Enter) closes the window and leaves everything running in the background;
 *   **Quit completely** stops it all anyway.
 *
 * "Quit completely" used to read "Quit and stop agents", which undersold it: it also ends every
 * terminal, running command and app process. What each button does did not change: off, both
 * paths are the plain quit, which the keeper turns into a full stop; on, "Quit completely" is the
 * keeper's `stop`.
 *
 * Presentational: the state, the focus trap and Enter/Esc live in main.tsx, so the browser
 * harness can draw exactly this (e2e/quit-dialog.spec.ts). It counts itself as an open layer, so
 * y/n/a and the app's other shortcuts do not act behind it (e2e/desktop-dialog-layers.spec.ts).
 */
export function QuitDialog({
  background,
  strays,
  straysError = null,
  alsoStop,
  error,
  dialogRef,
  onAlsoStop,
  onCancel,
  onQuit,
}: {
  /** Background mode: true on, false off, null unknown or not offered (no keeper) */
  background: boolean | null
  strays: Stray[]
  /**
   * Why the leftover processes could not be listed (#841 item 7, #990 review): the host refuses while the keeper cannot
   * say which processes it holds. Said, so an empty list does not read as "nothing is left running"
   */
  straysError?: string | null
  alsoStop: boolean
  error: string | null
  dialogRef?: Ref<HTMLDivElement>
  onAlsoStop: (on: boolean) => void
  onCancel: () => void
  /** `completely`: the keeper is told to stop everything, whatever background mode says */
  onQuit: (completely: boolean) => void
}) {
  useOpenLayer()
  const keepsRunning = background === true
  /*
   * Drawn in the app's current dialog style (owner, 2026-10-20): a title and one muted line, what is left running as a
   * card of rows with a switch, and the shared buttons with their keys as keycaps. What each button does is unchanged.
   */
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-thin" data-testid="confirm-quit" onClick={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Quit Centralu?"
        className="w-[400px] rounded-lg border border-line bg-surface-side p-5 shadow-(--shadow-modal) focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-lg font-medium tracking-tight text-ink">Quit Centralu?</p>
        {keepsRunning ? (
          <p className="mt-1.5 text-sm leading-body text-ink-muted" data-testid="confirm-quit-background">
            Quit closes the window and agents keep running in the background. Open Centralu again to come back to
            them, waiting approvals included.
          </p>
        ) : (
          <p className="mt-1.5 text-sm leading-body text-ink-muted" data-testid="confirm-quit-stops">
            {COMPLETELY_STOPS} Conversations are saved and resume when you come back.
          </p>
        )}
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        {straysError && (
          <p className="mt-3 text-xs leading-body text-ink-faint" data-testid="quit-strays-unknown">
            Could not check for processes left running in your project folders: {straysError}
          </p>
        )}
        {strays.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface-raised" data-testid="quit-strays">
            <p className="px-3 pb-1.5 pt-2.5 text-xs text-ink-muted">
              {strays.length} process{strays.length > 1 ? 'es' : ''} started in your project folders will keep
              running
            </p>
            <ul className="max-h-28 overflow-y-auto px-3 pb-2">
              {strays.slice(0, 6).map((s) => (
                <li key={s.pid} className="readout truncate py-0.5 text-2xs text-ink-faint" title={s.cwd}>
                  {s.pid} · {s.command}
                </li>
              ))}
              {strays.length > 6 && <li className="py-0.5 text-2xs text-ink-faint">…and {strays.length - 6} more</li>}
            </ul>
            <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-line px-3 py-2.5 text-sm text-ink">
              Stop them too
              <Switch checked={alsoStop} onChange={(e) => onAlsoStop(e.target.checked)} data-testid="quit-stop-strays" />
            </label>
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} data-testid="confirm-quit-no" className="flex items-center gap-1.5">
            Cancel <kbd className="keycap">esc</kbd>
          </Button>
          {keepsRunning && (
            <Button variant="quiet" onClick={() => onQuit(true)} title={COMPLETELY_STOPS} data-testid="confirm-quit-stop">
              Quit completely
            </Button>
          )}
          <Button
            variant={keepsRunning ? 'primary' : 'danger'}
            // Off, the plain quit is the complete one: the keeper stops everything when the last window goes
            onClick={() => onQuit(false)}
            title={keepsRunning ? 'Close the window; everything keeps running in the background' : COMPLETELY_STOPS}
            data-testid="confirm-quit-yes"
            className="flex items-center gap-1.5"
          >
            {keepsRunning ? 'Quit' : 'Quit completely'} <kbd className="keycap">⏎</kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
