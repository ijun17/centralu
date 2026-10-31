// The release's version rules as pure functions (no git, no gh, no IO): the next prerelease, the order of two
// versions, which scheme a commit's version source is in, and which files a pattern names. release.mjs puts them to work.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** `1.2.3-beta.4` as numbers and prerelease parts; null when it is not a version. */
export function parseVersion(text) {
  const m = SEMVER.exec(String(text ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

const isNum = (s) => /^\d+$/.test(s)

/** Negative, zero or positive, as semver orders them (a prerelease comes before its release). */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a
  const y = typeof b === 'string' ? parseVersion(b) : b
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k]
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    if (isNum(p) && isNum(q)) return Number(p) - Number(q)
    if (isNum(p)) return -1
    if (isNum(q)) return 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * The prerelease after `current`: the last number of its prerelease counted up (`1.2.0-beta.3` → `1.2.0-beta.4`).
 * Throws a sentence when there is no such version.
 */
export function nextVersion(current) {
  const v = parseVersion(current)
  if (!v) throw new Error(`"${current}" is not a version (major.minor.patch, with an optional -prerelease).`)
  if (!v.pre.length) throw new Error(`${current} has no prerelease part to count up; give the version.`)
  const i = v.pre.findLastIndex(isNum)
  if (i < 0) throw new Error(`${current} has no number in its prerelease part to count up; give the version.`)
  const pre = [...v.pre]
  pre[i] = String(Number(pre[i]) + 1)
  return `${v.major}.${v.minor}.${v.patch}-${pre.join('.')}`
}

/** The version a source file declares, by `pattern` (a regular expression whose first group is it). */
export function declaredVersion(text, pattern) {
  const m = new RegExp(pattern, 'm').exec(String(text ?? ''))
  return m?.[1] ?? null
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Which release scheme a commit's version source is in (#1501), read the same way by the release workflow's guard
 * (scripts/release-guard.mjs) and by the board, so the two never disagree about a commit. `source`: project.json
 * `release.source`, `{ pattern, marker, name }`.
 * - `{ scheme: 'brand', version }`: `pattern` finds the literal, and `marker` is absent.
 * - `{ scheme: 'tag' }` only on positive evidence: the `marker` line (the version imported from the generated file),
 *   with no other declaration of `name`; or `name` not in the file at all.
 * - `{ scheme: null, problem }` for anything else: a declaration it cannot read (other quotes, a type annotation, a
 *   computed value) is never taken for the tag scheme, which would let a tag of any version through.
 */
export function sourceScheme(text, { pattern, marker, name } = {}) {
  const t = String(text ?? '')
  const version = pattern ? declaredVersion(t, pattern) : null
  const marked = marker ? new RegExp(marker, 'm').test(t) : false
  if (version !== null && !marked) return { scheme: 'brand', version }
  const id = name ? escape(name) : null
  // A declaration of the name other than the marker: `const NAME`, `let NAME`, `NAME =`, `NAME: string =`
  const declares = id ? new RegExp(`\\b(?:const|let|var|function|class)\\s+${id}\\b|\\b${id}\\s*(?::[^=\\n]*)?=(?![=>])`).test(t) : false
  if (marked && version === null && !declares) return { scheme: 'tag' }
  if (id && !marked && !new RegExp(`\\b${id}\\b`).test(t)) return { scheme: 'tag' }
  const what = name ?? 'the version'
  return {
    scheme: null,
    problem:
      version !== null
        ? `declares ${what} as "${version}" and also imports it from the generated file; it must be one or the other.`
        : `declares ${what} in a form that cannot be read: neither a literal matching ${pattern ?? '(no pattern)'} nor ${marker ? `the line matching ${marker}` : 'a marker (none configured)'}.`,
  }
}

/**
 * Whether `path` is named by `pattern`: a path, where `*` stands for any characters inside one folder
 * name (`packaging/npm/*\/package.json`) and `**` for any number of folders.
 */
export function pathMatches(pattern, path) {
  const re = String(pattern)
    .split('/')
    .map((seg) => (seg === '**' ? '(?:[^/]+/)*' : `${seg.split('*').map(escape).join('[^/]*')}/`))
    .join('')
  return new RegExp(`^${re.replace(/\/$/, '')}$`).test(path)
}

/** The files of `all` that `patterns` name, in the order of `all`. */
export const filesNamed = (patterns, all) => all.filter((p) => patterns.some((pat) => pathMatches(pat, p)))

/**
 * The release notes draft: the subjects merged since the last release, newest first, without the
 * release commits themselves.
 */
export function releaseNotes(subjects) {
  return subjects.map((s) => String(s).trim()).filter((s) => s && !/^chore\(release\):/.test(s))
}
