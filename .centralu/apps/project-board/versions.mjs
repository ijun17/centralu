// The release's version rules as pure functions (no git, no gh, no IO): reading the version from its
// one declaration, the next version, the order of two versions, which files a pattern names, and the
// bump itself. release.mjs puts them to work; the tests hold them to this repository's own files.

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

export const BUMPS = ['prerelease', 'patch', 'minor', 'major']

/**
 * The version after `current`. `prerelease` counts up the last number of the prerelease
 * (`1.2.0-beta.3` → `1.2.0-beta.4`); the others leave the prerelease behind (`patch` of a
 * prerelease is its release, as semver has it). Throws a sentence when there is no such version.
 */
export function nextVersion(current, bump = 'prerelease') {
  const v = parseVersion(current)
  if (!v) throw new Error(`"${current}" is not a version (major.minor.patch, with an optional -prerelease).`)
  if (bump === 'prerelease') {
    if (!v.pre.length) throw new Error(`${current} has no prerelease part to count up; give the version, or bump patch, minor or major.`)
    const i = v.pre.findLastIndex(isNum)
    if (i < 0) throw new Error(`${current} has no number in its prerelease part to count up; give the version.`)
    const pre = [...v.pre]
    pre[i] = String(Number(pre[i]) + 1)
    return `${v.major}.${v.minor}.${v.patch}-${pre.join('.')}`
  }
  if (bump === 'patch') return v.pre.length ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`
  if (bump === 'minor') return v.pre.length && v.patch === 0 ? `${v.major}.${v.minor}.0` : `${v.major}.${v.minor + 1}.0`
  if (bump === 'major') return v.pre.length && v.patch === 0 && v.minor === 0 ? `${v.major}.0.0` : `${v.major + 1}.0.0`
  throw new Error(`"${bump}" is not a bump; use one of ${BUMPS.join(', ')}.`)
}

/** The version a source file declares, by `pattern` (a regular expression whose first group is it). */
export function declaredVersion(text, pattern) {
  const m = new RegExp(pattern, 'm').exec(String(text ?? ''))
  return m?.[1] ?? null
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where a file carries `version`: the exact version as a whole quoted string, `"1.2.0-beta.3"` or
 * `'1.2.0-beta.3'`. That is how every file of this repository writes it (package.json, Cargo.toml,
 * Cargo.lock, tauri.conf.json, brand.ts), and it leaves the version alone in prose ("released in
 * 1.2.0-beta.3") and inside longer versions (`1.2.0-beta.30`).
 */
export const versionPattern = (version) => new RegExp(`(["'])${escape(version)}\\1`, 'g')

export const carries = (text, version) => versionPattern(version).test(String(text ?? ''))

/**
 * Detection is broader than replacement: suffixes, templates and unquoted text can all pin a
 * release. Only local/build suffixes extend this version; other prereleases are different versions.
 * Return each matching line once, even when it holds several references.
 */
export function versionLines(text, version, path = '') {
  const pattern = new RegExp(`(?<![0-9.])${escape(version)}(?:\\.local\\.(?:[1-9]\\d*|\\$\\{[^}\\r\\n]+\\})|\\+build(?:\\.[0-9A-Za-z-]+)*)?(?![0-9A-Za-z+-]|\\.[0-9A-Za-z])`)
  const source = String(text ?? '')
  return (/(?:^|\/)package\.json$/.test(path) ? withoutDependencyRanges(source) : source)
    .split('\n')
    .flatMap((line, i) => (pattern.test(line) ? [i + 1] : []))
}

const DEPENDENCY_FIELDS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])

/** Mask only dependency specifier values, preserving lines and other values on the same line. */
function withoutDependencyRanges(text) {
  try {
    JSON.parse(text)
  } catch {
    return text // Invalid JSON must not hide a release reference.
  }
  const stack = []
  return text.replace(/"(?:\\.|[^"\\])*"|[{}[\],:]/g, (token) => {
    const parent = stack.at(-1)
    if (token === '{' || token === '[') {
      stack.push({ object: token === '{', key: null, expectsKey: token === '{', dependencies: token === '{' && stack.length === 1 && DEPENDENCY_FIELDS.has(parent?.key) })
    } else if (token === '}' || token === ']') {
      stack.pop()
    } else if (token === ',') {
      if (parent?.object) parent.expectsKey = true
    } else if (token.startsWith('"')) {
      const value = JSON.parse(token)
      if (parent?.expectsKey) {
        parent.key = value
        parent.expectsKey = false
      } else if (parent?.dependencies && /^(?:\^|~|>=|workspace:)/.test(value.trim())) {
        return ' '.repeat(token.length)
      }
    }
    return token
  })
}

/** `text` with every quoted `from` turned into `to`, and how many there were. */
export function bumpText(text, from, to) {
  let count = 0
  const out = String(text).replace(versionPattern(from), (_, q) => {
    count += 1
    return `${q}${to}${q}`
  })
  return { text: out, count }
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
