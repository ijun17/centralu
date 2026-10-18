import { Store } from './store.js'

/**
 * The store's step numbers as the tests count them. A step's number can be held for one that lands later (#1134: v59
 * went in while v58 was still in review), so "the steps after vN" is not `latest - N`: it is counted from the
 * list.
 */

type Step = { to: number }
const steps = (): Step[] => (new Store() as unknown as { migrationSteps(): Step[] }).migrationSteps()

/**
 * The numbers no step has yet, below the newest: held for steps in review. Each leaves this list in the pull request
 * that adds its step
 */
export const HELD_STEPS: readonly number[] = [58]

/** How many steps a store at `version` has still to run */
export function stepsAfter(version: number): number {
  return steps().filter((s) => s.to > version).length
}

/** Every step number from `from` to the newest, in order, but the held ones */
export function stepNumbersFrom(from: number): number[] {
  const latest = new Store().latestKnownVersion
  return Array.from({ length: latest - from + 1 }, (_, i) => from + i).filter((n) => !HELD_STEPS.includes(n))
}
