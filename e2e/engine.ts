/**
 * The engine `pnpm e2e` runs in, or undefined for the mixed run: Chromium, plus the `-webkit.spec.ts`
 * twins in WebKit. `E2E_BROWSER` names one engine and wins. On Windows the app runs in WebView2
 * (Chromium) and Playwright's WebKit there is its own port, not an engine the app ships on: it keeps
 * only the text types of a drag, so the app's `application/x-cc-*` types never reach a drop and
 * every scenario that drags fails in it (#2022), so an unset run is Chromium alone there.
 */
export function e2eEngine(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): 'chromium' | 'webkit' | undefined {
  if (env.E2E_BROWSER === 'chromium' || env.E2E_BROWSER === 'webkit') return env.E2E_BROWSER
  return platform === 'win32' ? 'chromium' : undefined
}

/**
 * Which part of the suite a run plays, for CI's sharding: `only` runs the replay project alone, `skip` runs every other
 * project, and unset (`pnpm e2e`) runs them all. `--shard` cuts the list of tests in the order of the projects into runs of
 * equal length, so the replay's tests, all of one project, fell in one shard however many there were, and its single worker
 * made them a floor under that shard's time. CI runs the replay on its own, cut by `--shard` the same
 * way, and then the rest, so each shard holds its share of both (.github/scripts/e2e-shard.sh).
 */
export function e2eReplayPart(env: NodeJS.ProcessEnv = process.env): 'only' | 'skip' | undefined {
  const part = env.E2E_REPLAY
  if (part === undefined || part === '') return undefined
  if (part === 'only' || part === 'skip') return part
  throw new Error(`E2E_REPLAY is "${part}": it names "only" (the replay project alone) or "skip" (all the others)`)
}
