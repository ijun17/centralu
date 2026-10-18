/**
 * The app's JS budget, judged against main's bundle instead of a constant (#1181).
 *
 * The budget used to be one number in styles.test.ts that every UI pull request raised, so they
 * conflicted with each other in the merge queue (#1091 three times). Now CI keeps a record of
 * main's size (build.yml's `verify` job: main's runs save it in the Actions cache, every other run
 * restores the newest), and a change may grow the JS by {@link BUNDLE_ALLOWANCE} over it. A change
 * that grows it more says so in {@link GROWTH_FILE}, with the reason, in the same pull request.
 *
 * The declaration stays in the tree after it lands, but it is spent: main's next record carries
 * its reason, and a declaration whose reason the base record already carries adds nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * How much a change may add to main's JS without saying why. 30 KB: the fixed budget was raised
 * 50 KB at a time, each raise lasting a few UI pull requests (`git log -L` on its old line), and
 * a merge-queue batch is judged as one change, so two ordinary UI changes landing together must
 * fit. One dependency the size of a small library does not.
 */
export const BUNDLE_ALLOWANCE = 30_000

/** Where a pull request declares growth beyond the allowance, relative to the repository root. */
export const GROWTH_FILE = 'tooling/bundle-growth.json'

/** What main's run measured: the bytes, its commit, and the growth declaration its tree held. */
export interface BundleRecord {
  bytes: number
  sha: string | null
  growth: string | null
}

export interface GrowthDeclaration {
  bytes: number
  reason: string
}

export type BundleVerdict =
  | { kind: 'no-base'; note: string }
  | { kind: 'within'; limit: number; note: string }
  | { kind: 'over'; limit: number; note: string }

const kb = (n: number) => `${(n / 1000).toFixed(1)} KB`

export function judgeBundle(input: {
  bytes: number
  base: BundleRecord | null
  declared: GrowthDeclaration | null
  allowance?: number
}): BundleVerdict {
  const { bytes, base, declared } = input
  const allowance = input.allowance ?? BUNDLE_ALLOWANCE
  if (!base) {
    return {
      kind: 'no-base',
      note: `The app's JS is ${bytes} B. No record of main's bundle here, so it was not compared (CI's verify job compares it).`,
    }
  }
  const applies = declared !== null && declared.reason !== base.growth
  const limit = base.bytes + allowance + (applies ? declared.bytes : 0)
  const grew = bytes - base.bytes
  const against = `main's ${base.bytes} B${base.sha ? ` (${base.sha.slice(0, 8)})` : ''}`
  const allowed = applies ? `${kb(allowance)} plus the ${kb(declared.bytes)} declared in ${GROWTH_FILE}` : kb(allowance)
  const change = `${grew >= 0 ? '+' : ''}${grew} B against ${against}`
  if (bytes <= limit) return { kind: 'within', limit, note: `The app's JS is ${bytes} B, ${change}; ${allowed} allowed.` }
  const need = Math.ceil((bytes - base.bytes - allowance) / 1000) * 1000
  return {
    kind: 'over',
    limit,
    note:
      `The app's JS is ${bytes} B, ${change}: more than the ${allowed} a change may add without a reason. ` +
      `Find out what grew first (a heavy dependency, a feature larger than it should be). ` +
      `If the growth is meant, write ${GROWTH_FILE} in this pull request as ` +
      `{ "bytes": ${need}, "reason": "<what grew, and why it has to>" } (a reason main's record does not carry yet).`,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** main's record, or null when there is none (no file: a local run, or the cache had nothing yet). */
export function readBundleRecord(path: string | undefined): BundleRecord | null {
  if (!path || !existsSync(path)) return null
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(v) || !Number.isInteger(v.bytes) || (v.bytes as number) <= 0) {
    throw new Error(`${path} is not a bundle record: ${JSON.stringify(v)}`)
  }
  return {
    bytes: v.bytes as number,
    sha: typeof v.sha === 'string' ? v.sha : null,
    growth: typeof v.growth === 'string' ? v.growth : null,
  }
}

/** The tree's growth declaration, or null when it has none. A malformed one throws: it was meant to say something. */
export function readGrowthDeclaration(path: string): GrowthDeclaration | null {
  if (!existsSync(path)) return null
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(v) || !Number.isInteger(v.bytes) || (v.bytes as number) <= 0 || typeof v.reason !== 'string' || !v.reason.trim()) {
    throw new Error(`${GROWTH_FILE} must be { "bytes": <a positive whole number>, "reason": "<why>" }, not ${JSON.stringify(v)}`)
  }
  return { bytes: v.bytes as number, reason: v.reason.trim() }
}

export function writeBundleRecord(path: string, record: BundleRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record)}\n`)
}
