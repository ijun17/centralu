import type { Ref } from 'react'
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
 * harness can draw exactly this (e2e/quit-dialog.spec.ts).
 */
export function QuitDialog({
  background,
  strays,
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
  alsoStop: boolean
  error: string | null
  dialogRef?: Ref<HTMLDivElement>
  onAlsoStop: (on: boolean) => void
  onCancel: () => void
  /** `completely`: the keeper is told to stop everything, whatever background mode says */
  onQuit: (completely: boolean) => void
}) {
  const keepsRunning = background === true
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-thin" data-testid="confirm-quit" onClick={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Quit Centralu?"
        className="w-[360px] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal) focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-md text-ink">Quit Centralu?</p>
        {keepsRunning ? (
          <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="confirm-quit-background">
            Quit closes the window and agents keep running in the background. Open Centralu again to come back to
            them, waiting approvals included.
          </p>
        ) : (
          <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="confirm-quit-stops">
            {COMPLETELY_STOPS} Conversations are saved and resume when you come back.
          </p>
        )}
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        {strays.length > 0 && (
          <div className="mt-3 rounded-md border border-line bg-surface-floor p-2" data-testid="quit-strays">
            <p className="text-xs text-ink-muted">
              {strays.length} process{strays.length > 1 ? 'es' : ''} started in your project folders will keep
              running:
            </p>
            <ul className="mt-1 max-h-24 overflow-y-auto">
              {strays.slice(0, 6).map((s) => (
                <li key={s.pid} className="readout truncate text-2xs text-ink-faint" title={s.cwd}>
                  {s.pid} · {s.command}
                </li>
              ))}
              {strays.length > 6 && <li className="text-2xs text-ink-faint">…and {strays.length - 6} more</li>}
            </ul>
            <label className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
              <input
                type="checkbox"
                className="accent-line-strong"
                checked={alsoStop}
                onChange={(e) => onAlsoStop(e.target.checked)}
                data-testid="quit-stop-strays"
              />
              Stop them too
            </label>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink"
            onClick={onCancel}
            data-testid="confirm-quit-no"
          >
            Cancel <span className="text-2xs text-ink-faint">esc</span>
          </button>
          {keepsRunning && (
            <button
              className="rounded-md border border-line px-2 py-1 text-sm text-ink-muted hover:border-line-strong hover:text-ink"
              onClick={() => onQuit(true)}
              title={COMPLETELY_STOPS}
              data-testid="confirm-quit-stop"
            >
              Quit completely
            </button>
          )}
          <button
            className={
              keepsRunning
                ? 'rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink hover:border-line-strong'
                : 'rounded-md border border-danger/40 bg-danger-bg px-3 py-1 text-sm text-danger hover:border-danger/70'
            }
            // Off, the plain quit is the complete one: the keeper stops everything when the last window goes
            onClick={() => onQuit(false)}
            title={keepsRunning ? 'Close the window; everything keeps running in the background' : COMPLETELY_STOPS}
            data-testid="confirm-quit-yes"
          >
            {keepsRunning ? 'Quit' : 'Quit completely'} <span className="text-2xs">⏎</span>
          </button>
        </div>
      </div>
    </div>
  )
}
