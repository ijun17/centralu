import type { BackgroundPort } from '../ports/lifecycle.js'

/**
 * "Quit and keep running" (#1512). Background mode goes on first: quitting with it off would stop the turns the person
 * asked to keep, so a keeper that does not turn it on refuses before anything is touched. A failed `stopStrays` still
 * quits, as the plain quit does.
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
