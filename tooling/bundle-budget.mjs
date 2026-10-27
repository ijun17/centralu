/**
 * The app's JS budget, judged against main's bundle instead of a shared constant (#1181).
 *
 * The budget used to be one number in styles.test.ts that every UI pull request raised, so they
 * conflicted with each other in the merge queue (#1091 three times). Now two limits hold:
 *
 *   against main   main's size (a record CI's `verify` job fetches, .github/scripts/bundle-base.mjs)
 *                  plus {@link BUNDLE_ALLOWANCE}, plus the bytes of every declaration main's record
 *                  does not carry yet;
 *   the ceiling    {@link BUNDLE_CEILING} plus every declaration in the tree, so many small changes
 *                  under the allowance cannot add up to a silent megabyte.
 *
 * A declaration is a file of its own in {@link GROWTH_DIR}, `{ "bytes": n, "reason": "…" }`, added by
 * the pull request that grows the bundle, so two of them never conflict. main's record lists the
 * declarations its tree held when it was measured: one it lists is in main's bytes already and adds
 * nothing to the limit against main; one it does not list is new, and counts once. A merge-queue
 * batch landing two declaring pull requests counts both, once each.
 *
 * Plain JavaScript, so the workflow's script (run by the runner's Node, no install) shares it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How much a change may add to main's JS without saying why. 30 KB: the fixed budget was raised
 * 50 KB at a time, each raise lasting a few UI pull requests, and a merge-queue batch is judged as
 * one change, so two ordinary UI changes landing together fit. One small library does not.
 */
export const BUNDLE_ALLOWANCE = 30_000

/**
 * The absolute ceiling before any declaration: main measured 1,784,673 B on 2026-10-18 (Windows,
 * production build), plus about 115 KB, less the 13,484 B that #1648 took out of the UI entry by leaving the
 * protocol's host-only schemas out of it (packages/protocol/src/client.ts), so that room is not spent on something
 * else. Raised only by declarations, never by editing this line.
 */
export const BUNDLE_CEILING = 1_886_516

/** Where declarations live, relative to the repository root: one file per change. */
export const GROWTH_DIR = 'tooling/bundle-growth'

/** The release build's JS: every `.js` file of a vite build's assets folder, in bytes. */
export function jsBytesOf(assets) {
  return readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .reduce((n, f) => n + statSync(join(assets, f)).size, 0)
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The declarations under `root`'s {@link GROWTH_DIR}, by file name, sorted. A malformed one throws:
 * it was meant to say something.
 */
export function readDeclarations(root) {
  const dir = join(root, GROWTH_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((name) => {
      const v = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (!isObject(v) || !Number.isInteger(v.bytes) || v.bytes <= 0 || typeof v.reason !== 'string' || !v.reason.trim()) {
        throw new Error(`${GROWTH_DIR}/${name} must be { "bytes": <a positive whole number>, "reason": "<why>" }, not ${JSON.stringify(v)}`)
      }
      return { name, bytes: v.bytes, reason: v.reason.trim() }
    })
}

/**
 * What the workflow fetched into `dir`: main's record (`bundle-size.json`), or why there is none
 * (`missing.txt`). `{ record }`, `{ missing }`, or `{ missing: null }` when `dir` holds neither.
 */
export function readBundleBase(dir) {
  const file = join(dir, 'bundle-size.json')
  if (existsSync(file)) {
    let v
    try {
      v = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      return { missing: `main's record ${file} is not JSON (${e.message})` }
    }
    if (!isObject(v) || !Number.isInteger(v.bytes) || v.bytes <= 0 || !Array.isArray(v.declared)) {
      return { missing: `main's record ${file} is not a bundle record: ${JSON.stringify(v)}` }
    }
    return { record: { bytes: v.bytes, sha: typeof v.sha === 'string' ? v.sha : null, declared: v.declared.map(String), measured: v.measured === true } }
  }
  const why = join(dir, 'missing.txt')
  return { missing: existsSync(why) ? readFileSync(why, 'utf8').trim() : null }
}

export function writeBundleRecord(dir, record) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'bundle-size.json'), `${JSON.stringify(record)}\n`)
}

const kb = (n) => `${(n / 1000).toFixed(1)} KB`
const sum = (list) => list.reduce((n, d) => n + d.bytes, 0)

/**
 * The verdict on `bytes`: `{ ok, notes, problems }`. `base` is `{ record }` or `{ missing }` from
 * {@link readBundleBase}, or null when this run has no record to compare with; `required` says
 * whether a missing record is a failure (CI's verify job) or only a note (a local run).
 */
export function judgeBundle({ bytes, base, declarations, required, allowance = BUNDLE_ALLOWANCE, ceiling = BUNDLE_CEILING }) {
  const problems = []
  const notes = []
  const howTo = (need) =>
    `Find out what grew first (a heavy dependency, a feature larger than it should be). If the growth is meant, ` +
    `add ${GROWTH_DIR}/<your-branch>.json in this pull request: { "bytes": ${need}, "reason": "<what grew, and why it has to>" }.`
  const roof = ceiling + sum(declarations)
  if (bytes > roof) {
    problems.push(`The app's JS is ${bytes} B, over the ceiling of ${roof} B (${ceiling} B and ${declarations.length} declaration(s) in ${GROWTH_DIR}). ${howTo(Math.ceil((bytes - roof) / 1000) * 1000)}`)
  }
  const record = base?.record
  if (!record) {
    const why = base?.missing ?? "no record of main's bundle was fetched"
    if (required) problems.push(`The app's JS (${bytes} B) could not be compared with main's: ${why}. Run the job again once main's verify job has uploaded its bundle-size record.`)
    else notes.push(`The app's JS is ${bytes} B; not compared with main's here (${why}). CI's verify job compares it.`)
    return { ok: problems.length === 0, notes, problems }
  }
  const listed = new Set(record.declared)
  const fresh = declarations.filter((d) => !listed.has(d.name))
  const limit = record.bytes + allowance + sum(fresh)
  const grew = bytes - record.bytes
  const against = `main's ${record.bytes} B${record.sha ? ` (${record.sha.slice(0, 8)}${record.measured ? ', measured here' : ''})` : ''}`
  const allowed = `${kb(allowance)}${fresh.length ? ` plus ${kb(sum(fresh))} declared (${fresh.map((d) => d.name).join(', ')})` : ''}`
  const change = `${grew >= 0 ? '+' : ''}${grew} B against ${against}`
  if (bytes > limit) problems.push(`The app's JS is ${bytes} B, ${change}: more than the ${allowed} a change may add. ${howTo(Math.ceil((bytes - limit) / 1000) * 1000)}`)
  else notes.push(`The app's JS is ${bytes} B, ${change}; ${allowed} allowed.`)
  return { ok: problems.length === 0, notes, problems }
}
