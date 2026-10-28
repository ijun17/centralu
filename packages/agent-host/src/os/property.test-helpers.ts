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

/**
 * The letters NTFS reads as one name in either case, as pairs written out here: the oracle of the property tests, so
 * they do not fold case with the function the code under test uses (`foldCase`). Measured on Windows 11: these pairs
 * are one name; the Kelvin sign (U+212A) and `k`, the dotless `ı` and `I`, `ß` and `S`, and the micro sign `µ` and
 * Greek `Μ` are not.
 */
const CASE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['a', 'A'],
  ['b', 'B'],
  ['c', 'C'],
  ['k', 'K'],
  ['x', 'X'],
  ['y', 'Y'],
  ['z', 'Z'],
  ['é', 'É'],
  ['ı', 'ı'],
  ['K', 'K'],
  ['ß', 'ß'],
  ['µ', 'µ'],
]
const OTHER_CASE = new Map<string, string>(
  CASE_PAIRS.flatMap(([lo, up]): Array<[string, string]> => [
    [lo, up],
    [up, lo],
  ]),
)
const FOLDED = new Map<string, string>(
  CASE_PAIRS.flatMap(([lo, up]): Array<[string, string]> => [
    [lo, lo],
    [up, lo],
  ]),
)

/**
 * A file name: letters in both cases, digits, a few signs and other scripts, and letters NTFS does not fold although
 * JavaScript's case functions would (`ı`, the Kelvin sign, `ß`, `µ`); never `.` or `..`
 */
export function name(r: Rng): string {
  const chars = [...'aAbBcCkKxXyYzZ019_-.éÉ한ıßµ', 'K']
  let s = ''
  const n = r.int(1, 8)
  for (let i = 0; i < n; i++) s += r.pick(chars)
  return s === '.' || s === '..' || /\.$/.test(s) ? `${s}x` : s
}

/** Its letters in the other case at random where NTFS has one (`aB` → `Ab`), by the pairs above */
export function recase(r: Rng, s: string): string {
  return [...s].map((c) => (r.bool() ? (OTHER_CASE.get(c) ?? c) : c)).join('')
}

/** Whether NTFS reads two names (or paths) as one, by the pairs above: the oracle for the Windows case rule */
export function sameOnNtfs(a: string, b: string): boolean {
  const fold = (s: string) => [...s].map((c) => FOLDED.get(c) ?? c).join('')
  return fold(a) === fold(b)
}
