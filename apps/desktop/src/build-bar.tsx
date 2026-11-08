import { ShellBanner } from '@cc/ui'
import { DesktopDialog } from './dialog-layer.js'
import type { ShellHostBuild } from '@cc/platform/tauri'
// The pure half, by path rather than through `@cc/platform/tauri`: the browser harness that drives
// this bar in e2e (apps/web/src/harness/shell-banner.tsx) has no Tauri, and the index imports it
import { olderBuildText, type BuildBar } from '../../../packages/platform/src/tauri/switch-plan.js'

/**
 * The bar a window shows when the keeper or the host is of another build (#280), drawn from
 * `buildBar`'s decision. Presentational: the state and the actions live in main.tsx, so the browser
 * harness can draw exactly this with a made-up `ShellHostBuild` (e2e/fixtures/shell-banner.ts).
 */
export function BuildBarView({
  build,
  bar,
  error,
  restarting,
  onRestart,
  onDismiss,
}: {
  build: ShellHostBuild
  bar: BuildBar
  /** The restart into this build that failed, next to the bar's own line */
  error: string | null
  /** The restart into this build is under way: the keeper is on its way down and this build's up */
  restarting: boolean
  onRestart: () => void
  onDismiss: () => void
}) {
  if (bar.kind === 'none') return null
  const running = bar.kind === 'other' ? (bar.who === 'host' ? build.host : build.keeper) : undefined
  return (
    <ShellBanner testId="host-other-build" role="status">
      {bar.kind === 'shell' ? (
        // Agents run either way; the reason in full is one hover away (thin-shell plan §6)
        <span className="min-w-0 flex-1 truncate" title={bar.detail} data-testid="host-shell-fallback">
          {bar.text}
        </span>
      ) : restarting ? (
        <span className="min-w-0 flex-1 truncate" data-testid="host-restarting">
          Restarting Centralu on this build…
        </span>
      ) : bar.older ? (
        /*
         * A window of an older build than the one running (#352): it never restarts by itself, and
         * the bar says which way a restart would go. The full builds, paths included, on hover.
         */
        <span
          className="min-w-0 flex-1 truncate"
          title={`Running: ${describeBuild(running)}. This window: ${describeBuild(build.app)}.`}
          data-testid="host-older-build"
        >
          {olderBuildText(build.app, running)}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {bar.who === 'host'
            ? `The agent host is running ${describeBuild(build.host)}.`
            : `The background keeper is running ${describeBuild(build.keeper)}.`}{' '}
          This window is {describeBuild(build.app)}.
        </span>
      )}
      {/* Truncates too: a long error must not push the buttons out of the window */}
      {error && (
        <span className="min-w-0 max-w-[40%] truncate text-danger" title={error} data-testid="host-restart-error">
          {error}
        </span>
      )}
      {bar.kind === 'other' && !restarting && (
        <button
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-ink hover:border-line-strong"
          onClick={onRestart}
          data-testid="host-restart-keeper"
        >
          {bar.older ? 'Go back to this build' : 'Restart into this build'}
        </button>
      )}
      {!restarting && (
        <button className="shrink-0 text-ink-faint hover:text-ink" onClick={onDismiss} data-testid="host-bar-dismiss">
          {bar.kind === 'other' ? 'Not now' : 'Dismiss'}
        </button>
      )}
    </ShellBanner>
  )
}

/**
 * The question before a restart into this build, asked only when something is running (`restartPlan`): the person reads
 * what stops before it does (#387).
 */
export function RestartKeeperDialog({ loses, onCancel, onConfirm }: { loses: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <DesktopDialog onCancel={onCancel} testId="confirm-restart-keeper" label="Restart Centralu into this build?">
      <p className="text-md text-ink">Restart Centralu into this build?</p>
      <p className="mt-2 text-xs leading-body text-ink-muted">
        The background keeper runs another build than this window. Restarting stops it and starts this build in its place.
      </p>
      <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="confirm-restart-keeper-loses">
        {loses}
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
          Restart
        </button>
      </div>
    </DesktopDialog>
  )
}

/** "build abc1234 (0.1.0-beta.6) from /Applications/Centralu.app" — what a person can check against what they installed */
export function describeBuild(b: ShellHostBuild['host']): string {
  if (!b) return 'an unknown build'
  const version = b.version ? ` (${b.version})` : ''
  const from = b.bundlePath ? ` from ${b.bundlePath}` : ''
  return `build ${b.commit}${version}${from}`
}
