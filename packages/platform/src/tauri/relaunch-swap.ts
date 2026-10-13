import { autoSwitch, type AutoSwitchInput } from './switch-plan.js'

type Build = AutoSwitchInput['build'] & { mode: string }

/** The relaunched window must not run home tools on the older host that is about to leave. */
export async function finishRelaunchSwap(
  build: Build,
  watch: (cb: (build: Build) => void) => (() => void) | Promise<() => void>,
  switchBuild: () => Promise<void>,
): Promise<void> {
  if (
    build.mode !== 'keeper' ||
    !build.relaunched ||
    autoSwitch({ build, autoApply: false, tried: false, dismissed: false }) !== 'switch'
  )
    return
  let finish!: (error?: Error) => void
  const outcome = new Promise<Error | undefined>((resolve) => {
    finish = resolve
  })
  const timer = setTimeout(() => finish(new Error('The host update did not finish in time')), 120_000)
  let stop: (() => void) | undefined
  try {
    // Tauri's listener registration is asynchronous; wait for it before asking for the swap.
    stop = await watch((next) => {
      if (next.sameBuild || next.swap?.phase === 'failed') finish()
    })
    void switchBuild().catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))))
    const error = await outcome
    if (error) throw error
  } finally {
    clearTimeout(timer)
    stop?.()
  }
}
