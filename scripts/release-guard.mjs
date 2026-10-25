// The release workflow's guard: which version a run of release.yml builds, and whether it publishes.
// It runs first and alone, so a run it refuses has built nothing and published nothing.
//
// Two schemes, told apart by brand.ts (#1501):
//
// * **brand** (until the switch): `APP_VERSION` is a literal in packages/protocol/src/brand.ts, kept
//   equal to every other version file by tooling/brand.test.ts. A tag push must name exactly that
//   version; a manual run rehearses it, or publishes when `dry_run` is unticked (the hand fallback in
//   docs/releasing.md). A `version` input, if given, must be that version.
// * **tag** (once brand.ts imports the version from the generated file, or does not name it at all):
//   no file carries the release version; the tag is the only statement of it, and the build stamps it.
//   Told by `sourceScheme`, which the project board reads commits with too, from project.json
//   `release.source`: only positive evidence is the tag scheme, and a declaration neither reading
//   understands stops the run (#1501 review item 2). Since the tree no longer ties a run to a version,
//   the guard does what the literal used to:
//   - only a tag push publishes; a manual run is always a rehearsal, whatever `dry_run` says (a manual
//     publish of a free version would leave a version on npm with no tag, and the next release stuck);
//   - the tag is the newest `v[0-9]*` tag, and the previous one is an ancestor of the tagged commit
//     (a tag on an older commit would ship without the previous release's fixes);
//   - the tagged commit is on the default branch, in a checkout with its whole history (a shallow one
//     shows no previous tag, and every check against it would pass unasked);
//   - the version is after every version of `centralu` on the registry, and with no previous tag
//     visible the registry must have none (the tags were not fetched, or were deleted);
//   - the previous version's `centralu` is on the registry (two tags at once: the older one's shim
//     finishing last would leave `latest` on it);
//   - `centralu@<version>` is not on the registry from another commit (a re-run of this release's
//     own run finds its own packages, from this commit, and goes on: docs/releasing.md "When a job
//     fails halfway").
//   A rehearsal builds the `version` input, or the next prerelease after the newest tag, which must
//   be after every tag and on a commit that descends from the newest one.
//
// In the workflow: node scripts/release-guard.mjs   (with the history and tags: fetch-depth 0)

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { sourceScheme } from '../.centralu/apps/project-board/versions.mjs'

// Where the version is declared and how its two schemes read: the board's release configuration, one definition for both
const SOURCE = JSON.parse(readFileSync(new URL('../.centralu/apps/project-board/project.json', import.meta.url), 'utf8')).release.source
export const BRAND = SOURCE.path
// SemVer without build metadata: content-verify's Rust parser refuses `+meta`, and npm drops it
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/
export const TAG_PREFIX = 'v'
export const SHIM = 'centralu'

/** brand.ts's scheme: `{ scheme: 'brand', version }`, `{ scheme: 'tag' }`, or `{ scheme: null, problem }` (`sourceScheme`). */
export const schemeOf = (text) => sourceScheme(text, SOURCE)

export function parseVersion(text) {
  const m = SEMVER.exec(String(text ?? ''))
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

const isNum = (s) => /^\d+$/.test(s)

/** Negative, zero or positive, as SemVer orders them. */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
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

/** The next prerelease: the last number of the prerelease counted up. Null when there is none to count. */
export function nextPrerelease(version) {
  const v = parseVersion(version)
  if (!v?.pre.length) return null
  const i = v.pre.findLastIndex(isNum)
  if (i < 0) return null
  const pre = [...v.pre]
  pre[i] = String(Number(pre[i]) + 1)
  return `${v.major}.${v.minor}.${v.patch}-${pre.join('.')}`
}

/** Release tags (`v` and a version) of `names`, newest first. */
export function releaseTags(names) {
  return names
    .filter((n) => n.startsWith(TAG_PREFIX) && parseVersion(n.slice(TAG_PREFIX.length)))
    .map((name) => ({ name, version: name.slice(TAG_PREFIX.length) }))
    .sort((a, b) => compareVersions(b.version, a.version))
}

const truthy = (v, fallback) => (v === 'true' || v === 'false' ? v : fallback)

/**
 * The guard's answer. `facts`: `event` (GITHUB_EVENT_NAME), `ref` (GITHUB_REF_NAME), `inputs`
 * (`dryRun`, `alsoLatest`, `version`, as the workflow gives them: strings, maybe empty), `source`
 * (brand.ts's `schemeOf`), `tags` (every tag name), `head` (the commit being built), `shallow` (the
 * checkout's history is cut short), and four questions: `ancestor(tag)` (is that tag's commit an
 * ancestor of head), `onMain()` (is head on the default branch), `registry(name, version)`
 * (`{ state: 'absent' }` or `{ state: 'present', gitHead }`), `published(name)` (every version the
 * registry has of it, empty when none); the last two throw when the registry does not answer. Answers `{ ok, scheme, version, dryRun, alsoLatest,
 * errors, notes }`; `ok` false means the run stops here.
 */
export async function decide(facts) {
  const { event, ref, inputs = {}, source = { scheme: null, problem: 'was not read.' } } = facts
  const literal = source.scheme === 'brand' ? source.version : null
  const errors = []
  const notes = []
  const push = event === 'push'
  const want = String(inputs.version ?? '').trim().replace(/^v/, '')
  const answer = (scheme, version, dryRun, alsoLatest) => ({ ok: errors.length === 0, scheme, version, dryRun, alsoLatest, errors, notes })

  if (source.scheme === null) {
    // Never the tag scheme by default: a literal in another form would let a tag of any version publish
    errors.push(`${BRAND} ${source.problem} Nothing is built until it reads as one scheme or the other.`)
    return answer(null, '', 'true', 'true')
  }
  if (literal !== null) {
    // The brand scheme, as before #1501
    if (!literal) errors.push(`${BRAND} declares an empty APP_VERSION.`)
    if (push) {
      if (ref !== `${TAG_PREFIX}${literal}`) {
        errors.push(`tag ${ref} does not match APP_VERSION ${literal}: expected ${TAG_PREFIX}${literal}.`)
        errors.push('Either the version bump was never committed, or the tag went on the wrong commit. Delete the tag, fix, tag again.')
      }
      // A tag push is the release. No stable release exists yet, so `npm i -g centralu` (no tag) has
      // to resolve to the beta; flip this the day 1.0 ships (docs/releasing.md, --also-latest)
      return answer('brand', literal, 'false', 'true')
    }
    if (want && want !== literal) errors.push(`The version input ${want} is not ${literal}, the APP_VERSION this commit declares; a rehearsal builds what the commit declares.`)
    // Default to the reversible answer when the value is missing or unexpected
    return answer('brand', literal, truthy(inputs.dryRun, 'true'), truthy(inputs.alsoLatest, 'true'))
  }

  // The tag scheme (#1501)
  const tags = releaseTags(facts.tags ?? [])
  if (facts.shallow) errors.push('This checkout is shallow: without the whole history and every tag, the previous release cannot be seen, and the checks against it would pass unasked. Check out with fetch-depth: 0.')
  if (push) {
    const version = ref?.startsWith(TAG_PREFIX) ? ref.slice(TAG_PREFIX.length) : ''
    if (!parseVersion(version)) {
      errors.push(`tag ${ref} is not ${TAG_PREFIX} and a version (major.minor.patch with an optional -prerelease, no +build).`)
      return answer('tag', version, 'false', 'true')
    }
    const others = tags.filter((t) => t.name !== ref)
    const newer = others.filter((t) => compareVersions(t.version, version) >= 0)
    if (newer.length) errors.push(`${ref} is not the newest release tag (${newer.map((t) => t.name).join(', ')} ${newer.length === 1 ? 'is' : 'are'} at or after it); only the newest tag may publish, or two releases race for npm's dist-tags.`)
    const previous = others.find((t) => compareVersions(t.version, version) < 0) ?? null
    if (previous && !(await facts.ancestor(previous.name)))
      errors.push(`${previous.name}, the release before ${ref}, is not an ancestor of ${short(facts.head)}: this tag is on a commit without the previous release, which would ship without its changes. Delete the tag and put it on a commit of main after ${previous.name}.`)
    if (!(await facts.onMain())) errors.push(`${short(facts.head)} is not on the default branch; a release is cut from main.`)
    await registryChecks({ facts, version, previous, errors })
    return answer('tag', version, 'false', 'true')
  }

  // A rehearsal: never a publish, whatever dry_run says
  if (inputs.dryRun === 'false') notes.push('dry_run was unticked, but under the tag scheme only a tag push publishes: this run is a rehearsal.')
  const newest = tags[0] ?? null
  let version = want
  if (!version) {
    version = newest ? nextPrerelease(newest.version) : null
    if (!version) {
      errors.push(newest ? `${newest.name} has no prerelease number to count up; give the version input.` : 'There is no release tag yet; give the version input.')
      return answer('tag', '', 'true', truthy(inputs.alsoLatest, 'true'))
    }
    notes.push(`No version input: rehearsing ${version}, the next prerelease after ${newest.name}.`)
  }
  if (!parseVersion(version)) errors.push(`The version input "${version}" is not a version (major.minor.patch with an optional -prerelease, no +build).`)
  else {
    if (tags.some((t) => t.version === version)) errors.push(`${TAG_PREFIX}${version} is tagged already; a release is never built twice.`)
    else if (newest && compareVersions(version, newest.version) <= 0) errors.push(`${version} is not after ${newest.name}, the newest release tag.`)
    if (newest && !(await facts.ancestor(newest.name))) errors.push(`${short(facts.head)} does not descend from ${newest.name}, the newest release; rehearse a commit of main after it.`)
  }
  return answer('tag', version, 'true', truthy(inputs.alsoLatest, 'true'))
}

async function registryChecks({ facts, version, previous, errors }) {
  try {
    // After everything npm has (the design's check): a tag below a published version, on an old commit with no tag before it, passed every other check
    const all = (await facts.published(SHIM)).filter((v) => parseVersion(v)).sort(compareVersions)
    const newest = all.at(-1) ?? null
    if (newest && !all.includes(version) && compareVersions(version, newest) <= 0) errors.push(`${version} is not after ${SHIM}@${newest}, the newest version on the registry.`)
    if (!previous && all.length) errors.push(`No release tag before ${TAG_PREFIX}${version} is visible, but the registry has ${SHIM} (newest ${newest}): the tags were not fetched, or were deleted. Fetch them (fetch-depth: 0) and run again.`)
    const p = await facts.registry(SHIM, version)
    if (p.state === 'present' && p.gitHead !== facts.head)
      errors.push(`${SHIM}@${version} is on the registry already, published from ${p.gitHead ? short(p.gitHead) : 'an unknown commit'}, not ${short(facts.head)}: npm never takes a version twice. Release the next version instead.`)
    if (previous) {
      const q = await facts.registry(SHIM, previous.version)
      if (q.state !== 'present') errors.push(`${SHIM}@${previous.version} (${previous.name}) is not on the registry: finish or abandon that release first, or the two race for npm's dist-tags.`)
    }
  } catch (e) {
    errors.push(`The npm registry did not answer (${e?.message ?? e}); nothing is published without knowing what is there. Re-run the job.`)
  }
}

const short = (sha) => String(sha ?? '').slice(0, 12)

const REGISTRY = String(process.env.RELEASE_GUARD_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')

/** Every version of `name` the registry has; empty when it has none. */
async function published(name) {
  const r = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(20_000) })
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return Object.keys((await r.json()).versions ?? {})
}

async function registry(name, version) {
  const r = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}/${encodeURIComponent(version)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (r.status === 404) return { state: 'absent' }
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const v = await r.json()
  return { state: 'present', gitHead: typeof v.gitHead === 'string' ? v.gitHead : null }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function isAncestor(a, b) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function main() {
  const env = process.env
  const head = git(['rev-parse', 'HEAD'])
  const main = env.DEFAULT_BRANCH || 'main'
  const result = await decide({
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF_NAME,
    inputs: { dryRun: env.INPUT_DRY_RUN ?? '', alsoLatest: env.INPUT_ALSO_LATEST ?? '', version: env.INPUT_VERSION ?? '' },
    source: schemeOf(readFileSync(BRAND, 'utf8')),
    tags: git(['tag', '--list', `${TAG_PREFIX}[0-9]*`]).split('\n').filter(Boolean),
    head,
    shallow: git(['rev-parse', '--is-shallow-repository']) === 'true',
    ancestor: async (tag) => isAncestor(`refs/tags/${tag}^{commit}`, head),
    onMain: async () => isAncestor(head, `refs/remotes/origin/${main}`),
    registry,
    published,
  })
  for (const n of result.notes) console.log(`::notice::${n}`)
  for (const e of result.errors) console.log(`::error::${e}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${result.version}\ndry_run=${result.dryRun}\nalso_latest=${result.alsoLatest}\nscheme=${result.scheme ?? ''}\n`)
  // Say out loud what the jobs after this one are about to do, on the run's summary page
  if (env.GITHUB_STEP_SUMMARY) {
    const lines = [`## centralu ${result.version || '(no version)'}`, '']
    if (!result.ok) lines.push('**Refused.** Nothing was built or published:', '', ...result.errors.map((e) => `- ${e}`), '')
    else if (result.dryRun === 'false') lines.push('**Publishing.** Each publish waits for approval on the `npm-publish` environment.', '')
    else lines.push('**Rehearsal.** Builds and `npm pack` only: nothing reaches the registry and no approval is asked for.', '', 'The shim job will warn that the platform packages are not on the registry at this version. That is correct: this run published none.', '')
    for (const n of result.notes) lines.push(`- ${n}`)
    lines.push(`- version from: ${result.scheme === 'brand' ? `\`${BRAND}\`` : result.scheme === 'tag' ? 'the tag (or the rehearsal input)' : 'not read'}`, `- move the \`latest\` dist-tag: \`${result.alsoLatest}\``, `- triggered by: \`${env.GITHUB_EVENT_NAME}\` \`${env.GITHUB_REF_NAME}\``)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
  process.exitCode = result.ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
