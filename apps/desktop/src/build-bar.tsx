import { ShellBanner } from '@cc/ui'
import type { HostBuild } from '@cc/platform/tauri'
// The pure half, by path rather than through `@cc/platform/tauri`: the browser harness that drives
// this bar in e2e (apps/web/src/harness/shell-banner.tsx) has no Tauri, and the index imports it
import { RESTART_COMPLETELY_LOSES, type BuildBar } from '../../../packages/platform/src/tauri/switch-plan.js'

/**
 * The bar a window shows when the keeper or the host is of another build (#280), drawn from
 * `buildBar`'s decision. Presentational: the state and the actions live in main.tsx, so the browser
 * harness can draw exactly this with a made-up `HostBuild` (e2e/fixtures/shell-banner.ts).
 */
export function BuildBarView({
  build,
  bar,
  error,
  restarting,
  onSwitch,
  onDismiss,
  onRestart,
}: {
  build: HostBuild
  bar: BuildBar
  /** A request the window made that failed (the switch or the restart), next to the bar's own line */
  error: string | null
  /** "Restart completely" was confirmed and the keeper is on its way down and up again */
  restarting: boolean
  onSwitch: () => void
  onDismiss: () => void
  onRestart: () => void
}) {
  if (bar.kind === 'none') return null
  const danger = bar.kind === 'failed'
  return (
    <ShellBanner testId="host-other-build" role={danger ? 'alert' : 'status'}>
      {bar.kind === 'other' ? (
        <span className="min-w-0 flex-1 truncate">
          {bar.who === 'host'
            ? `The agent host is running ${describeBuild(build.host)}.`
            : `The background keeper is running ${describeBuild(build.keeper)}.`}{' '}
          This window is {describeBuild(build.app)}.
        </span>
      ) : (
        <span
          className={`min-w-0 flex-1 truncate ${danger ? 'text-danger' : ''}`}
          // The keeper's own reason stays one hover away: worth having, not worth alarming anyone
          title={bar.kind === 'keeper_later' ? bar.detail : (build.swap?.message ?? build.swap?.keeperMessage)}
          data-testid="host-switch-progress"
        >
          {bar.kind === 'keeper_later' && restarting ? 'Restarting the background keeper on this build…' : bar.text}
        </span>
      )}
      {/* Truncates too: a long error must not push the buttons out of the window */}
      {error && (
        <span className="min-w-0 max-w-[40%] truncate text-danger" title={error} data-testid="host-switch-error">
          {error}
        </span>
      )}
      {(bar.kind === 'other' || ((bar.kind === 'failed' || bar.kind === 'notice') && bar.retry)) && (
        <button
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-ink hover:border-line-strong"
          onClick={onSwitch}
          data-testid="host-switch-build"
        >
          {bar.kind === 'failed' ? 'Try again' : 'Switch to this build'}
        </button>
      )}
      {bar.kind === 'keeper_later' && !restarting && (
        <button
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-ink-muted hover:border-line-strong hover:text-ink"
          onClick={onRestart}
          title={RESTART_COMPLETELY_LOSES}
          data-testid="host-restart-keeper"
        >
          Restart completely
        </button>
      )}
      {bar.kind !== 'switching' && !restarting && (
        <button className="shrink-0 text-ink-faint hover:text-ink" onClick={onDismiss} data-testid="host-bar-dismiss">
          {bar.kind === 'other' ? 'Not now' : 'Dismiss'}
        </button>
      )}
    </ShellBanner>
  )
}

/**
 * The question before "Restart completely" (#387): it stops what "Quit completely" stops, and the
 * person should read that before it happens, not after.
 */
export function RestartKeeperDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-thin"
      data-testid="confirm-restart-keeper"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Restart Centralu completely?"
        className="w-[380px] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-md text-ink">Restart Centralu completely?</p>
        <p className="mt-2 text-xs leading-body text-ink-muted">
          The background keeper that holds the agents is on an older build and could not move to this one by
          itself. Restarting it now starts it on this build.
        </p>
        <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="confirm-restart-keeper-loses">
          {RESTART_COMPLETELY_LOSES}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink" onClick={onCancel}>
            Not now
          </button>
          <button
            className="rounded-md border border-danger/40 bg-danger-bg px-3 py-1 text-sm text-danger hover:border-danger/70"
            data-testid="confirm-restart-keeper-yes"
            onClick={onConfirm}
          >
            Restart completely
          </button>
        </div>
      </div>
    </div>
  )
}

/** "build abc1234 (0.1.0-beta.6) from /Applications/Centralu.app" — what a person can check against what they installed */
export function describeBuild(b: HostBuild['host']): string {
  if (!b) return 'an unknown build'
  const version = b.version ? ` (${b.version})` : ''
  const from = b.bundlePath ? ` from ${b.bundlePath}` : ''
  return `build ${b.commit}${version}${from}`
}
