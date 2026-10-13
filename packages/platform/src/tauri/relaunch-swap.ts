import { autoSwitch, type AutoSwitchInput } from './switch-plan.js'

type Build = AutoSwitchInput['build'] & { mode: string }
export type RelaunchSwapResult = {
  tried: boolean
  error?: string
  /** The keeper retains its last swap across handoffs; only a different swap can settle this attempt. */
  previousSwapStartedAt?: number
}

/** The relaunched window must not run home tools on the older host that is about to leave. */
export async function finishRelaunchSwap(
  build: Build,
  watch: (cb: (build: Build) => void) => (() => void) | Promise<() => void>,
  switchBuild: () => Promise<void>,
): Promise<RelaunchSwapResult> {
  if (
    build.mode !== 'keeper' ||
    !build.relaunched ||
    autoSwitch({ build, autoApply: false, tried: false, dismissed: false }) !== 'switch'
  )
    return { tried: false }
  let finish!: (error?: Error) => void
  const outcome = new Promise<Error | undefined>((resolve) => {
    finish = resolve
  })
  const timer = setTimeout(() => finish(new Error('The host update did not finish in time')), 120_000)
  let stop: (() => void) | undefined
  try {
    // Tauri's listener registration is asynchronous; wait for it before asking for the swap.
    stop = await watch((next) => {
      if (next.swap?.phase === 'failed') finish(new Error(next.swap.message ?? 'The host update failed'))
      else if (next.sameBuild) finish()
    })
    void switchBuild().catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))))
    const error = await outcome
    if (error) throw error
    return { tried: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.warn('Automatic relaunch swap failed; continuing on the attached host:', error)
    return { tried: true, error }
  } finally {
    clearTimeout(timer)
    stop?.()
  }
}
