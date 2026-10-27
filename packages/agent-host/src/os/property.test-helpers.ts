/**
 * Property tests without a library: a seeded random source and a runner that says the seed and the value that failed,
 * so a failure is run again with `CC_PROPERTY_SEED=<seed>`. Each run starts from the seed, so a test is the same every
 * time unless the seed is changed.
 */
export type Rng = {
  /** In [0, 1) */
  next(): number
  int(lo: number, hi: number): number
  pick<T>(items: readonly T[]): T
  bool(p?: number): boolean
}

export function rng(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    bool: (p = 0.5) => next() < p,
  }
}

const SEED = Number(process.env.CC_PROPERTY_SEED ?? 1599)

/** Checks `check` on `runs` values made by `make`; a failure names the run's seed and the value */
export function forAll<T>(make: (r: Rng) => T, check: (value: T) => void, runs = 300): void {
  for (let i = 0; i < runs; i++) {
    const seed = SEED + i
    const value = make(rng(seed))
    try {
      check(value)
    } catch (e) {
      const error = e as Error
      error.message = `property failed for CC_PROPERTY_SEED=${seed} on ${JSON.stringify(value)}: ${error.message}`
      throw error
    }
  }
}

/** A file name: letters in both cases, digits, a few signs and other scripts; never `.` or `..` */
export function name(r: Rng): string {
  const chars = 'aAbBcCxXyYzZ019_-.é한'
  let s = ''
  const n = r.int(1, 8)
  for (let i = 0; i < n; i++) s += r.pick([...chars])
  return s === '.' || s === '..' || /\.$/.test(s) ? `${s}x` : s
}

/** Its letters in another case at random (`aB` → `Ab`) */
export function recase(r: Rng, s: string): string {
  return [...s].map((c) => (r.bool() ? c.toUpperCase() : c.toLowerCase())).join('')
}
