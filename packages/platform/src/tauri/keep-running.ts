import type { BackgroundPort } from '../ports/lifecycle.js'

/**
 * "Quit and keep running" (#1512): turns background mode on, then stops the leftover processes the person ticked and
 * quits. The order is the point. Quitting with the mode still off would stop the turns the person just asked to keep, so a
 * keeper that cannot be told (or says the mode is still off) refuses with its reason before anything else is touched: the
 * dialog stays open, the ticked processes keep running and nothing quits.
 *
 * `stopStrays` failing does not stop the quit, as in the plain quit: what the person pressed was quit.
 */
export async function keepRunningThenQuit(opts: {
  background: Pick<BackgroundPort, 'set'> | undefined
  stopStrays: () => Promise<void>
  quit: () => Promise<void>
}): Promise<void> {
  if (!opts.background) throw new Error('Background mode needs the keeper, which this build does not use')
  if (!(await opts.background.set(true))) throw new Error('The keeper did not turn background mode on')
  await opts.stopStrays().catch(() => {})
  await opts.quit()
}
