/**
 * The release workflow's guard (scripts/release-guard.mjs) decides which version a run builds and
 * whether it publishes, for both schemes (#1501). While brand.ts declares the version, a tag must
 * name it. Once brand.ts declares none, the tag alone is the version, and since the tree no longer
 * ties a run to a version, the guard holds the tag to the previous release instead: only a tag push
 * publishes, the previous release is an ancestor, the tag is the newest, the previous version is on
 * the registry, and npm does not have this version from other code.
 */
import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Facts = Record<string, unknown>
type Decision = { ok: boolean; scheme: string; version: string; dryRun: string; alsoLatest: string; errors: string[]; notes: string[] }

// @ts-expect-error: a plain .mjs script the workflow runs with the runner's own Node
const load = async () => (await import('../scripts/release-guard.mjs')) as { decide: (f: Facts) => Promise<Decision>; schemeOf: (t: string) => { scheme: string | null; version?: string; problem?: string } }

const WORKFLOW = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
/** This repository's brand.ts: under the tag scheme since #1501 (the version imported from the generated file) */
const ownBrand = readFileSync(new URL('../packages/protocol/src/brand.ts', import.meta.url), 'utf8')
/** A brand.ts of the brand scheme, as this repository's was until #1501 */
const version = '0.2.0-beta.4'
const brand = `/** Values that identify the app. */\nexport const APP_NAME = 'Centralu'\n\nexport const APP_VERSION = '${version}'\n\nexport const CLIENT_INFO = { name: 'centralu', title: APP_NAME, version: APP_VERSION } as const\n`
const HEAD = 'a'.repeat(40)

/** A release that is all in order: v1.0.0-beta.2 after v1.0.0-beta.1, on main, nothing of it on the registry yet. */
const facts = (over: Facts = {}): Facts => ({
  event: 'push',
  ref: 'v1.0.0-beta.2',
  inputs: {},
  source: { scheme: 'tag' },
  tags: ['v1.0.0-beta.1', 'v1.0.0-beta.2', 'shell-v1'],
  head: HEAD,
  shallow: false,
  ancestor: async () => true,
  onMain: async () => true,
  registry: async (_: string, v: string) => (v === '1.0.0-beta.1' ? { state: 'present', gitHead: 'b'.repeat(40) } : { state: 'absent' }),
  published: async () => ['1.0.0-beta.1'],
  ...over,
})
const errors = (d: Decision) => d.errors.join(' ')

it('reads the scheme from brand.ts: the literal of this repository, the tag scheme only on its marker or no APP_VERSION at all', async () => {
  const { schemeOf } = await load()
  expect(schemeOf(brand)).toEqual({ scheme: 'brand', version })
  // This repository's own, since the switch: a tag of any version is held to the tag scheme's rules
  expect(schemeOf(ownBrand)).toEqual({ scheme: 'tag' })
  expect(schemeOf("export { APP_VERSION } from './version.generated.js'\n")).toEqual({ scheme: 'tag' })
  expect(schemeOf("import { APP_VERSION } from './version.generated.js'\r\nexport const CLIENT_INFO = { version: APP_VERSION }\r\n")).toEqual({ scheme: 'tag' })
  expect(schemeOf("export const APP_NAME = 'Centralu'\n")).toEqual({ scheme: 'tag' })
  // A declaration the literal's pattern misses is not the tag scheme: that would let a tag of any version publish (review item 2)
  for (const text of ['export const APP_VERSION = "1.0.0-beta.2"', "export const APP_VERSION: string = '1.0.0-beta.2'", 'export const APP_VERSION = readVersion()', "export const APP_VERSION = '1.0.0'\nexport { APP_VERSION } from './version.generated.js'", "import { APP_VERSION } from './version.generated.js'\nexport const APP_VERSION = \"1\""])
    expect(schemeOf(text), text).toMatchObject({ scheme: null })
})

it('stops, building nothing, when brand.ts declares the version in a form it cannot read', async () => {
  const { decide, schemeOf } = await load()
  for (const event of ['push', 'workflow_dispatch']) {
    const r = await decide(facts({ event, source: schemeOf('export const APP_VERSION = "1.0.0-beta.2"') }))
    expect(r, event).toMatchObject({ ok: false, dryRun: 'true', version: '' })
    expect(errors(r)).toContain('in a form that cannot be read')
  }
})

describe('the brand scheme, as before #1501', () => {
  it('publishes a tag push of the declared version and refuses any other tag', async () => {
    const { decide } = await load()
    expect(await decide(facts({ source: { scheme: 'brand', version }, ref: `v${version}` }))).toMatchObject({ ok: true, scheme: 'brand', version, dryRun: 'false', alsoLatest: 'true' })
    const r = await decide(facts({ source: { scheme: 'brand', version }, ref: 'v0.0.0' }))
    expect(r.ok).toBe(false)
    expect(errors(r)).toContain('does not match APP_VERSION')
  })

  it('rehearses a manual run on any branch by default, publishes one only with dry_run unticked, and refuses another version input', async () => {
    const { decide } = await load()
    const run = (inputs: Facts) => decide(facts({ source: { scheme: 'brand', version }, event: 'workflow_dispatch', ref: `chore/release-${version}`, inputs }))
    expect(await run({ dryRun: 'true', alsoLatest: 'true' })).toMatchObject({ ok: true, version, dryRun: 'true' })
    // An empty or unexpected input is a rehearsal too: the reversible answer
    expect(await run({ dryRun: '', alsoLatest: '' })).toMatchObject({ ok: true, dryRun: 'true', alsoLatest: 'true' })
    expect(await run({ dryRun: 'maybe' })).toMatchObject({ dryRun: 'true' })
    expect(await run({ dryRun: 'false' })).toMatchObject({ ok: true, dryRun: 'false' })
    expect(await run({ version: `v${version}` })).toMatchObject({ ok: true, version })
    const other = await run({ version: '9.9.9' })
    expect(other.ok).toBe(false)
    expect(errors(other)).toContain(`is not ${version}`)
  })
})

describe('the tag scheme (#1501)', () => {
  it('publishes the newest tag on main, after the previous release, whose version npm does not have', async () => {
    const { decide } = await load()
    expect(await decide(facts())).toMatchObject({ ok: true, scheme: 'tag', version: '1.0.0-beta.2', dryRun: 'false', alsoLatest: 'true', errors: [] })
  })

  it('never publishes a manual run, whatever dry_run says', async () => {
    // A manual publish of a free version would leave it on npm with no tag: the next release would propose it again
    // and be refused by the registry, stuck until someone tagged by hand (deep review item 1)
    const { decide } = await load()
    const r = await decide(facts({ event: 'workflow_dispatch', ref: 'main', inputs: { dryRun: 'false', version: '1.0.0-beta.3' } }))
    expect(r).toMatchObject({ ok: true, dryRun: 'true', version: '1.0.0-beta.3' })
    expect(r.notes.join(' ')).toContain('only a tag push publishes')
  })

  it('rehearses the next prerelease after the newest tag without a version input, and refuses one that is not after it', async () => {
    const { decide } = await load()
    const run = (inputs: Facts, over: Facts = {}) => decide(facts({ event: 'workflow_dispatch', ref: 'chore/release-x', inputs, ...over }))
    expect(await run({})).toMatchObject({ ok: true, version: '1.0.0-beta.3', dryRun: 'true' })
    expect(errors(await run({ version: '1.0.0-beta.2' }))).toContain('tagged already')
    expect(errors(await run({ version: '0.9.0' }))).toContain('is not after v1.0.0-beta.2')
    expect(errors(await run({ version: '1.0.0+x' }))).toContain('not a version')
    expect(errors(await run({}, { ancestor: async () => false }))).toContain('does not descend from v1.0.0-beta.2')
    expect(errors(await run({}, { tags: [] }))).toContain('no release tag yet')
    expect(await run({ version: '0.1.0-beta.1' }, { tags: [] })).toMatchObject({ ok: true, version: '0.1.0-beta.1' })
  })

  it('refuses a tag on a commit without the previous release, or off main', async () => {
    // A tag pushed by hand on a main commit from before the previous release passes every other check (deep review item 2)
    const { decide } = await load()
    const asked: string[] = []
    const r = await decide(facts({ ancestor: async (t: string) => (asked.push(t), false), onMain: async () => false }))
    expect(asked).toEqual(['v1.0.0-beta.1'])
    expect(r.ok).toBe(false)
    expect(errors(r)).toContain('v1.0.0-beta.1, the release before v1.0.0-beta.2, is not an ancestor')
    expect(errors(r)).toContain('not on the default branch')
  })

  it('refuses a tag that is not the newest, and one whose previous release is not on the registry yet', async () => {
    // Two tags at once: both guards pass before either publishes, and the older shim finishing last leaves latest on it (item 4)
    const { decide } = await load()
    expect(errors(await decide(facts({ tags: ['v1.0.0-beta.1', 'v1.0.0-beta.2', 'v1.0.0-beta.3'] })))).toContain('not the newest release tag (v1.0.0-beta.3 is at or after it)')
    expect(errors(await decide(facts({ registry: async () => ({ state: 'absent' }) })))).toContain('centralu@1.0.0-beta.1 (v1.0.0-beta.1) is not on the registry')
  })

  it('lets a re-run of the same commit through, and refuses a version npm has from other code', async () => {
    // The documented recovery is re-running the run; its guard runs again and finds its own packages (item 5)
    const { decide } = await load()
    const registry = (gitHead: string | null) => async (_: string, v: string) => ({ state: 'present', gitHead: v === '1.0.0-beta.2' ? gitHead : 'b'.repeat(40) })
    expect(await decide(facts({ registry: registry(HEAD) }))).toMatchObject({ ok: true, errors: [] })
    expect(errors(await decide(facts({ registry: registry('c'.repeat(40)) })))).toContain('on the registry already, published from cccccccccccc')
    expect(errors(await decide(facts({ registry: registry(null) })))).toContain('an unknown commit')
    expect(errors(await decide(facts({ registry: async () => Promise.reject(new Error('HTTP 503')) })))).toContain('did not answer (HTTP 503)')
  })

  it('refuses a shallow checkout, a tag below what npm has, and a first tag while npm already has centralu', async () => {
    // With no other tag visible the descent and previous-version checks had nothing to check (review item 3)
    const { decide } = await load()
    expect(errors(await decide(facts({ shallow: true })))).toContain('This checkout is shallow')
    expect(errors(await decide(facts({ event: 'workflow_dispatch', ref: 'main', shallow: true })))).toContain('This checkout is shallow')
    const alone = { tags: ['v0.9.0'], ref: 'v0.9.0' }
    const r = await decide(facts({ ...alone, published: async () => ['0.2.0-beta.4', '1.0.0-beta.1'] }))
    expect(errors(r)).toContain('0.9.0 is not after centralu@1.0.0-beta.1')
    expect(errors(r)).toContain('No release tag before v0.9.0 is visible, but the registry has centralu')
    // The very first release: no tag, nothing on npm
    expect(await decide(facts({ ...alone, published: async () => [] }))).toMatchObject({ ok: true, version: '0.9.0' })
    expect(errors(await decide(facts({ published: async () => Promise.reject(new Error('HTTP 503')) })))).toContain('did not answer (HTTP 503)')
  })

  it('refuses a tag that is not a version, build metadata included', async () => {
    const { decide } = await load()
    for (const ref of ['v1.0', 'v1.0.0+build.1', 'release-1.0.0', 'v01.0.0']) expect((await decide(facts({ ref }))).ok, ref).toBe(false)
  })
})

// The script as the workflow runs it: real git for the ancestry, a local registry, its outputs and its exit code
describe('run as the workflow runs it', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }
  const commit = (dir: string, file: string, text: string, message: string) => {
    writeFileSync(join(dir, file), text)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', message)
  }

  /** Runs the script in a new repository `setup` fills, against a registry that has `published` (path → gitHead). */
  async function run(setup: (dir: string) => void, env: Record<string, string>, published: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'cc-release-guard-'))
    const server = createServer((req, res) => {
      const path = decodeURIComponent(req.url ?? '')
      // A package's document (every version), or one version's
      const versions = Object.fromEntries(Object.entries(published).filter(([p]) => p.startsWith(`${path}/`)).map(([p, gitHead]) => [p.slice(path.length + 1), { gitHead }]))
      const body = published[path] !== undefined ? { gitHead: published[path] } : Object.keys(versions).length ? { versions } : undefined
      res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body ?? { error: 'not found' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      git(dir, 'init', '-q', '-b', 'main')
      mkdirSync(join(dir, 'packages/protocol/src'), { recursive: true })
      setup(dir)
      const out = join(dir, 'output')
      const summary = join(dir, 'summary')
      const { port } = server.address() as AddressInfo
      const script = fileURLToPath(new URL('../scripts/release-guard.mjs', import.meta.url))
      const r = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [script], {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, RELEASE_GUARD_REGISTRY: `http://127.0.0.1:${port}`, DEFAULT_BRANCH: 'main', ...env },
        })
        let stdout = ''
        child.stdout.on('data', (d) => (stdout += d))
        child.on('close', (status) => resolve({ status, stdout }))
      })
      return { ...r, output: existsSync(out) ? readFileSync(out, 'utf8') : '', summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' }
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** main: c0, c1 (tagged v1.0.0-beta.1), c2, with origin/main at c2; v1.0.0-beta.2 on c2, or on a side commit off c0. */
  const history = (dir: string, tagOn: 'main' | 'side') => {
    commit(dir, 'packages/protocol/src/brand.ts', "export { APP_VERSION } from './version.generated.js'\n", 'c0')
    commit(dir, 'a', '1', 'c1')
    git(dir, 'tag', 'v1.0.0-beta.1')
    commit(dir, 'a', '2', 'c2')
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    if (tagOn === 'side') {
      git(dir, 'checkout', '-q', 'HEAD~2')
      commit(dir, 'b', '1', 's1')
    }
    git(dir, 'tag', '-a', '-m', 'notes', 'v1.0.0-beta.2')
  }

  it('publishes an annotated tag on main after the previous release, with the version in its outputs', async () => {
    const r = await run((d) => history(d, 'main'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v1.0.0-beta.2' }, { '/centralu/1.0.0-beta.1': 'x' })
    expect(r.status, r.stdout).toBe(0)
    expect(r.output).toBe('version=1.0.0-beta.2\ndry_run=false\nalso_latest=true\nscheme=tag\n')
    expect(r.summary).toContain('**Publishing.**')
  })

  it('stops, publishing nothing, for a tag on a commit without the previous release', async () => {
    const r = await run((d) => history(d, 'side'), { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v1.0.0-beta.2' }, { '/centralu/1.0.0-beta.1': 'x' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('::error::v1.0.0-beta.1, the release before v1.0.0-beta.2, is not an ancestor')
    expect(r.stdout).toContain('is not on the default branch')
    expect(r.summary).toContain('**Refused.**')
  })

  it('stops in a shallow checkout, which shows no previous tag', async () => {
    const r = await run(
      (d) => {
        const src = `${d}-src`
        mkdirSync(join(src, 'packages/protocol/src'), { recursive: true })
        git(src, 'init', '-q', '-b', 'main')
        history(src, 'main')
        git(d, 'fetch', '-q', '--depth', '1', `file://${src.replace(/\\/g, '/')}`, '+refs/heads/main:refs/remotes/origin/main', '+refs/tags/v1.0.0-beta.2:refs/tags/v1.0.0-beta.2')
        git(d, 'checkout', '-q', 'refs/tags/v1.0.0-beta.2')
        rmSync(src, { recursive: true, force: true })
      },
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v1.0.0-beta.2' },
      { '/centralu/1.0.0-beta.1': 'x' },
    )
    expect(r.status, r.stdout).toBe(1)
    expect(r.stdout).toContain('::error::This checkout is shallow')
    expect(r.stdout).toContain('No release tag before v1.0.0-beta.2 is visible, but the registry has centralu')
  })

  it('rehearses a brand.ts of the brand scheme as the old guard did', async () => {
    const r = await run(
      (d) => commit(d, 'packages/protocol/src/brand.ts', brand, 'c0'),
      { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: `chore/release-${version}`, INPUT_DRY_RUN: 'true', INPUT_ALSO_LATEST: 'true', INPUT_VERSION: '' },
      {},
    )
    expect(r.status, r.stdout).toBe(0)
    expect(r.output).toBe(`version=${version}\ndry_run=true\nalso_latest=true\nscheme=brand\n`)
  })
})

/** The lines of one top-level job of release.yml, comments dropped (as release-workflow.test.ts reads them). */
function job(name: string): string {
  const lines = WORKFLOW.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  expect(start, `release.yml has no job named "${name}"`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}\S/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).filter((l) => !l.trim().startsWith('#')).join('\n')
}

it('is what the workflow runs, with the history, the version input, and a name that says which version a rehearsal is', () => {
  const guard = job('guard')
  expect(guard).toMatch(/actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}fetch-depth: 0/)
  expect(guard).toMatch(
    /- id: plan\n {8}env:\n {10}INPUT_DRY_RUN: \$\{\{ inputs\.dry_run \}\}\n {10}INPUT_ALSO_LATEST: \$\{\{ inputs\.also_latest \}\}\n {10}INPUT_VERSION: \$\{\{ inputs\.version \}\}\n {10}DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}\n {8}run: node scripts\/release-guard\.mjs/,
  )
  expect(guard).toContain('scheme: ${{ steps.plan.outputs.scheme }}')
  expect(guard.indexOf('actions/setup-node')).toBeLessThan(guard.indexOf('- id: plan'))
  expect(WORKFLOW).toContain("run-name: ${{ github.event_name == 'workflow_dispatch' && format('rehearse {0}', inputs.version || 'next') || github.ref_name }}")
  expect(WORKFLOW).toMatch(/\n {6}version:\n {8}description: [^\n]+\n {8}type: string\n {8}required: false/)
  // Job-level, so `pnpm install` sees it too (deep review item 7)
  for (const name of ['platform', 'shim']) expect(job(name), name).toMatch(/\n {4}env:\n {6}CENTRALU_VERSION: \$\{\{ needs\.guard\.outputs\.version \}\}/)
})
