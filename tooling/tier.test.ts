import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, so pre-pr and the board can run it with Node alone
import { classify, globToRegExp, parseArgs, parseRules, RULES_FILE, subjectsOf, tierLine, tierOfChange, tierOfLabels } from '../scripts/tier.mjs'

/**
 * Risk tiers by path (#1259 step 2): the repository's own .centralu/tiers.json on representative
 * changes. Each case names the rule it stands on, and is checked to come out otherwise without that
 * rule, so no case passes by the fallback alone.
 */

type Rule = { id: string; tier: string }
type Rules = { fallback: string; rules: Rule[] }
type Result = { tier: string; files: { path: string; tier: string; rules: string[] }[]; because: { path: string; rules: string[] }[]; counts: Record<string, number> }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RULES: Rules = parseRules(readFileSync(join(ROOT, RULES_FILE), 'utf8'))
const without = (id: string): Rules => ({ ...RULES, rules: RULES.rules.filter((r) => r.id !== id) })
const tierOf = (paths: string[], rules = RULES): Result => classify(paths, rules)

/** `rule`: the rule the case stands on; null when it is light because no rule matches */
const CASES: { name: string; paths: string[]; tier: string; rule: string | null; because?: string[] }[] = [
  { name: 'documents only', paths: ['docs/apps.md', 'README.md', 'docs/generated/schema.md'], tier: 'auto', rule: 'docs' },
  { name: 'a change to docs/security-boundaries.md', paths: ['docs/security-boundaries.md'], tier: 'deep', rule: 'security-doc' },
  { name: 'docs with docs/security-boundaries.md among them', paths: ['docs/apps.md', 'docs/security-boundaries.md'], tier: 'deep', rule: 'security-doc', because: ['docs/security-boundaries.md'] },
  {
    name: 'fixture data only',
    paths: ['packages/agent-host/src/adapters/surface-fixtures/claude-2.1.302-help.txt', 'packages/agent-host/src/dev-services/store-fixtures/v1.sql', 'packages/agent-host/src/dev-services/store-migrations.golden.json'],
    tier: 'auto',
    rule: 'fixture-data',
  },
  {
    name: 'tests of ordinary code, scenarios and fixture code',
    paths: ['packages/agent-host/src/sessions/manager.test.ts', 'packages/ui/src/features/inbox/Inbox.test.tsx', 'e2e/control-grid.spec.ts', 'e2e/fixtures/control.ts', 'e2e/ux/core.task.ts', 'packages/agent-host/src/fake-exe.test-helpers.ts', 'packages/agent-host/src/apps/external/test-fixtures/app.mjs'],
    tier: 'light',
    rule: null,
  },
  { name: 'UI icons and fonts', paths: ['packages/ui/src/assets/file-icons/file_type_text.svg', 'packages/ui/src/assets/fonts/x.woff2'], tier: 'auto', rule: 'ui-assets' },
  { name: 'global CSS, which can hide a card', paths: ['packages/ui/src/styles/index.css'], tier: 'light', rule: null },
  {
    name: 'tests next to deep files, which guard them',
    paths: ['packages/agent-host/src/sessions/app-access.test.ts', 'packages/agent-host/src/sessions/project-consents.test.ts', 'packages/agent-host/src/dev-services/path-guard.test.ts', 'packages/agent-host/src/apps/external/capabilities.test.ts'],
    tier: 'deep',
    rule: 'trust',
  },
  { name: 'signed content checking\'s tests and their data', paths: ['apps/desktop/content-verify/tests/copy.rs', 'apps/desktop/content-verify/tests/fixtures/paths.json'], tier: 'deep', rule: 'release' },
  { name: 'repository-wide guards', paths: ['tooling/test-timing.test.ts', 'tooling/rpc-recovery.test.ts', 'tooling/build-workflow.test.ts', 'tooling/desktop-permissions.test.ts', 'tooling/test-timing.ts'], tier: 'deep', rule: 'guards' },
  { name: 'what CI runs the UI scenarios with', paths: ['e2e/playwright.config.ts', 'e2e/flaky-report.ts', 'e2e/ux/playwright.config.ts', 'e2e/ux/baseline.json', 'scripts/e2e-web-server.mjs'], tier: 'deep', rule: 'e2e-harness' },
  { name: 'dependencies', paths: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/agent-host/package.json'], tier: 'deep', rule: 'dependencies' },
  {
    name: 'the board\'s merge and check decisions',
    paths: ['.centralu/apps/project-board/ci.mjs', '.centralu/apps/project-board/batch.mjs', '.centralu/apps/project-board/run-failure.mjs', '.centralu/apps/project-board/pre-pr.mjs', '.centralu/apps/project-board/contribute-tools.mjs', '.centralu/apps/project-board/project.json'],
    tier: 'deep',
    rule: 'ci',
  },
  { name: 'everything under .github', paths: ['.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug.md'], tier: 'deep', rule: 'ci' },
  { name: 'a store migration', paths: ['packages/agent-host/src/dev-services/store/migrations/v58.ts'], tier: 'deep', rule: 'store' },
  { name: 'a test under the store, which guards it', paths: ['packages/agent-host/src/dev-services/store/json.test.ts'], tier: 'deep', rule: 'store' },
  { name: 'the store\'s entry', paths: ['packages/agent-host/src/dev-services/store.ts'], tier: 'deep', rule: 'store' },
  { name: 'which tools a session has', paths: ['packages/agent-host/src/sessions/tool-profiles.ts'], tier: 'deep', rule: 'trust' },
  { name: 'a project consent', paths: ['packages/agent-host/src/sessions/project-consents.ts'], tier: 'deep', rule: 'trust' },
  { name: 'Codex\'s launch trust', paths: ['packages/agent-host/src/adapters/codex/launch-config.ts'], tier: 'deep', rule: 'trust' },
  {
    name: 'the trust code split out of the session manager (#1143)',
    paths: ['packages/agent-host/src/sessions/orchestrator-slot.ts', 'packages/agent-host/src/sessions/session-settings.ts', 'packages/agent-host/src/sessions/approval-rules.ts', 'packages/agent-host/src/sessions/launch-inputs.ts', 'packages/agent-host/src/sessions/project-registry.ts', 'packages/agent-host/src/dev-services/project-files.ts'],
    tier: 'deep',
    rule: 'trust',
  },
  { name: 'the session manager\'s linked-machine side (#1143)', paths: ['packages/agent-host/src/sessions/linked-host.ts'], tier: 'deep', rule: 'processes' },
  { name: 'the session layout and the tool registry (#1143)', paths: ['packages/agent-host/src/sessions/session-layout.ts', 'packages/agent-host/src/sessions/tool-registry.ts'], tier: 'light', rule: null },
  { name: 'the host\'s transport', paths: ['packages/agent-host/src/transport/http.ts'], tier: 'deep', rule: 'transport' },
  { name: 'the desktop capabilities', paths: ['apps/desktop/src-tauri/capabilities/default.json'], tier: 'deep', rule: 'desktop-permissions' },
  { name: 'a linked machine\'s tunnel', paths: ['packages/agent-host/src/links/tunnel.ts'], tier: 'deep', rule: 'processes' },
  { name: 'centralu serve', paths: ['packaging/npm/centralu/bin/serve-run.mjs'], tier: 'deep', rule: 'processes' },
  { name: 'the keeper', paths: ['apps/desktop/src-tauri/keeper/src/keeper/swap.rs'], tier: 'deep', rule: 'processes' },
  { name: 'the host\'s start', paths: ['packages/agent-host/src/lifecycle/start.ts'], tier: 'deep', rule: 'processes' },
  { name: 'app secrets', paths: ['packages/agent-host/src/apps/external/secrets.ts'], tier: 'deep', rule: 'trust' },
  { name: 'the desktop shell\'s install', paths: ['apps/desktop/src-tauri/src/shell/install.rs'], tier: 'deep', rule: 'processes' },
  { name: 'a release script', paths: ['scripts/release-npm.mts'], tier: 'deep', rule: 'release' },
  { name: 'signed content checking', paths: ['apps/desktop/content-verify/src/lib.rs'], tier: 'deep', rule: 'release' },
  { name: 'the merge queue', paths: ['.centralu/apps/project-board/queue-driver.mjs'], tier: 'deep', rule: 'ci' },
  { name: 'the code that reads the tier rules', paths: ['scripts/tier.mjs'], tier: 'deep', rule: 'tier-rules' },
  { name: 'the protocol', paths: ['packages/protocol/src/entities.ts'], tier: 'deep', rule: 'protocol' },
  { name: 'a protocol test', paths: ['packages/protocol/src/app-id.test.ts'], tier: 'deep', rule: 'protocol' },
  { name: 'a workflow', paths: ['.github/workflows/build.yml'], tier: 'deep', rule: 'ci' },
  { name: 'what CI skips', paths: ['.github/scripts/ci-changes.mjs'], tier: 'deep', rule: 'ci' },
  { name: 'the tier rules', paths: ['.centralu/tiers.json'], tier: 'deep', rule: 'tier-rules' },
  {
    name: 'a mixed change: docs, a test, ordinary logic',
    paths: ['docs/apps.md', 'packages/ui/src/app/labelClock.test.ts', 'packages/ui/src/app/labelClock.ts', 'packages/ui/src/styles/index.css'],
    tier: 'light',
    rule: 'docs',
    because: ['packages/ui/src/app/labelClock.test.ts', 'packages/ui/src/app/labelClock.ts', 'packages/ui/src/styles/index.css'],
  },
  {
    name: 'a mixed change reaching the protocol',
    paths: ['docs/apps.md', 'packages/agent-host/src/rpc.ts', 'packages/protocol/src/brand.ts', 'packages/agent-host/src/rpc.test.ts'],
    tier: 'deep',
    rule: 'protocol',
    because: ['packages/protocol/src/brand.ts'],
  },
]

describe('the repository\'s tier rules', () => {
  it.each(CASES)('$name is $tier', ({ paths, tier, because }) => {
    const r = tierOf(paths)
    expect(r.tier).toBe(tier)
    if (because) expect(r.because.map((f) => f.path)).toEqual(because)
  })

  it.each(CASES.filter((c) => c.rule))('$name stands on the $rule rule', ({ paths, tier, rule }) => {
    expect(RULES.rules.map((r) => r.id)).toContain(rule)
    // A mixed light change stands on its auto rules too: without docs, docs/apps.md is light like the logic
    const r = tierOf(paths, without(rule!))
    if (tier === 'light') expect(r.files.find((f) => f.path === paths[0])!.tier).not.toBe(tierOf(paths).files[0]!.tier)
    else expect(r.tier).not.toBe(tier)
  })

  it('leaves ordinary logic and copy inside .tsx light, and says no rule matched', () => {
    const r = tierOf(['packages/ui/src/components/TextField.tsx', 'packages/agent-host/src/sessions/manager.ts', 'AGENTS.md'])
    expect(r.tier).toBe('light')
    expect(r.files.every((f) => f.rules.length === 0)).toBe(true)
  })

  it('gives a test the tier of the file it tests, and says so', () => {
    const r = tierOf(['packages/agent-host/src/sessions/app-access.test.ts'])
    expect(r.files[0]).toEqual({ path: 'packages/agent-host/src/sessions/app-access.test.ts', tier: 'deep', rules: ['trust'], tests: 'packages/agent-host/src/sessions/app-access.ts' })
    expect(tierLine(r, RULES)).toBe('Tier: deep, from `packages/agent-host/src/sessions/app-access.test.ts` (trust, as the test of packages/agent-host/src/sessions/app-access.ts).')
    expect(subjectsOf('a/b.test.tsx').slice(0, 2)).toEqual(['a/b.tsx', 'a/b.ts'])
    expect(subjectsOf('e2e/grid.spec.ts')).toEqual([])
    expect(subjectsOf('a/b.test-helpers.ts')[0]).toBe('a/b.ts')
    expect(subjectsOf('k/server/tests.rs')).toEqual(['k/server/mod.rs', 'k/server.rs'])
    expect(subjectsOf('a/b.ts')).toEqual([])
    const rules = parseRules(JSON.stringify({ tiers: ['auto', 'light', 'deep', 'person'], fallback: 'light', rules: [{ id: 'k', tier: 'deep', paths: ['k/server/mod.rs'], why: 'k' }, { id: 'a', tier: 'auto', paths: ['a/**'], why: 'a' }] }))
    expect(classify(['k/server/tests.rs'], rules).tier).toBe('deep')
    // Never lower: a test of an auto file keeps its own tier
    expect(classify(['a/x.test.ts', 'b/x.test.ts'], rules).files.map((f: { tier: string }) => f.tier)).toEqual(['auto', 'light'])
  })

  it('takes nothing changed as auto', () => {
    expect(tierOf([]).tier).toBe('auto')
    expect(tierLine(tierOf([]), RULES)).toBe('Tier: auto (no files changed).')
  })

  it('names in one line what put the change at its tier, and how many files fell elsewhere', () => {
    const r = tierOf(['docs/apps.md', 'packages/agent-host/src/rpc.ts', 'packages/protocol/src/brand.ts', 'packages/protocol/src/entities.ts'])
    expect(tierLine(r, RULES)).toBe('Tier: deep, from `packages/protocol/src/brand.ts` (protocol), `packages/protocol/src/entities.ts` (protocol); the other files: 1 auto, 1 light.')
    expect(tierLine(tierOf(['a.ts', 'b.ts', 'c.ts']), RULES, 2)).toBe('Tier: light, from `a.ts` (no rule matches: light), `b.ts` (no rule matches: light) and 1 more.')
  })

  it('matches every glob against at least one file in the repository, so a rename cannot drop a path silently', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    const raw = JSON.parse(readFileSync(join(ROOT, RULES_FILE), 'utf8')) as { rules: { id: string; paths: string[]; except?: string[] }[] }
    const dead = raw.rules.flatMap((r) => [...r.paths, ...(r.except ?? [])].filter((g) => !files.some((f) => globToRegExp(g).test(f))).map((g) => `${r.id}: ${g}`))
    expect(dead).toEqual([])
  })
})

describe('the rules file and its globs', () => {
  const file = (rules: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({ tiers: ['auto', 'light', 'deep', 'person'], fallback: 'light', rules, ...over })

  it('reads ** as whole folders, * and ? within one name, {a,b} as either', () => {
    const re = (g: string) => globToRegExp(g) as RegExp
    expect(re('docs/**').test('docs/a/b.md')).toBe(true)
    expect(re('docs/**').test('docsx/a.md')).toBe(false)
    expect(re('**/*.test.ts').test('a.test.ts')).toBe(true)
    expect(re('**/*.test.ts').test('a/b/c.test.ts')).toBe(true)
    expect(re('a/*.ts').test('a/b/c.ts')).toBe(false)
    expect(re('a/**/b.ts').test('a/b.ts')).toBe(true)
    expect(re('**/{fixtures,tests}/**').test('x/tests/y.rs')).toBe(true)
    expect(re('tauri*.conf.json').test('tauriXconf.json')).toBe(false)
    expect(() => globToRegExp('a**b')).toThrow('** stands only for whole folders')
  })

  it('takes a rule\'s exceptions out of it', () => {
    const rules = parseRules(file([{ id: 'docs', tier: 'auto', paths: ['docs/**'], except: ['docs/secret.md'], why: 'documents' }]))
    expect(classify(['docs/a.md'], rules).tier).toBe('auto')
    expect(classify(['docs/secret.md'], rules).tier).toBe('light')
  })

  it('refuses a person rule, an unknown tier, a rule without its why, and two rules of one id', () => {
    expect(() => parseRules(file([{ id: 'x', tier: 'person', paths: ['a'], why: 'w' }]))).toThrow('person is set by hand, never by path')
    expect(() => parseRules(file([{ id: 'x', tier: 'huge', paths: ['a'], why: 'w' }]))).toThrow('no tier is called huge')
    expect(() => parseRules(file([{ id: 'x', tier: 'deep', paths: ['a'] }]))).toThrow('rule x needs its why')
    expect(() => parseRules(file([{ id: 'x', tier: 'deep', paths: ['a'], why: 'w' }, { id: 'x', tier: 'auto', paths: ['b'], why: 'w' }]))).toThrow('two rules are called x')
    expect(() => parseRules(file([], { fallback: 'person' }))).toThrow('fallback must be auto, light or deep')
  })
})

describe('a pull request\'s tier from its labels: the merge queue\'s hook', () => {
  it('takes the highest tier:<name> label, and deep without one: an unknown tier is never a lower one', () => {
    expect(tierOfLabels(['bug', 'tier:light'])).toBe('light')
    expect(tierOfLabels([{ name: 'tier:light' }, { name: 'tier:person' }])).toBe('person')
    expect(tierOfLabels(['tier:huge', 'bug'])).toBe('deep')
    expect(tierOfLabels([])).toBe('deep')
  })
})

describe('pnpm tier on a git repository', () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C' }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim()
  let repo = ''
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const commit = (message: string) => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
  }
  const rules = (tierOfSrc: string) => JSON.stringify({ tiers: ['auto', 'light', 'deep', 'person'], fallback: 'light', rules: [{ id: 'src', tier: tierOfSrc, paths: ['src/**'], why: 'the source' }] })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-tier-test-'))
    git('init', '-q', '-b', 'main')
    write(RULES_FILE, rules('deep'))
    write('src/a.ts', 'a\n')
    commit('main')
    git('checkout', '-q', '-b', 'top')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('judges the change by the base\'s rules, so a change cannot loosen the rules that judge it', () => {
    write('src/a.ts', 'b\n')
    write(RULES_FILE, rules('auto'))
    commit('loosen')
    const r = tierOfChange({ root: repo, base: 'main', head: 'top' })
    expect(r.tier).toBe('deep')
    expect(r.rulesFrom).toBe('main')
    expect(r.because.map((f: { path: string }) => f.path)).toEqual(['src/a.ts'])
  })

  it('counts a deleted file, and only what the head adds over where it left the base', () => {
    git('rm', '-q', 'src/a.ts')
    commit('delete')
    git('checkout', '-q', 'main')
    write('src/b.ts', 'b\n')
    commit('main moves on')
    expect(tierOfChange({ root: repo, base: 'main', head: 'top' }).files.map((f: { path: string }) => f.path)).toEqual(['src/a.ts'])
  })

  it('takes the head\'s rules when the base has none, and answers deep when neither has', () => {
    git('checkout', '-q', '--orphan', 'bare')
    git('rm', '-rq', '--cached', '.')
    rmSync(join(repo, '.centralu'), { recursive: true, force: true })
    write('x.txt', 'x\n')
    commit('no rules')
    expect(tierOfChange({ root: repo, base: 'bare', head: 'bare' })).toMatchObject({ tier: 'deep', line: 'Tier: deep (no .centralu/tiers.json at bare or bare).' })
    expect(tierOfChange({ root: repo, base: 'top', head: 'main', rulesRef: 'bare' }).rulesFrom).toBe('main')
  })

  it('answers deep, and exits 2, when the change cannot be judged', () => {
    let out = ''
    let status = 0
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts/tier.mjs'), '--json', '--base', 'nowhere'], { cwd: repo, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '')
      status = (e as { status?: number }).status ?? 0
    }
    expect(status).toBe(2)
    expect(JSON.parse(out)).toMatchObject({ tier: 'deep', line: 'Tier: deep (the change could not be judged: nowhere is not a commit here.).' })
  })

  it('reads its arguments, and refuses one it does not know', () => {
    expect(parseArgs([])).toEqual({ base: 'origin/main', head: 'HEAD', json: false, paths: null })
    expect(parseArgs(['--base', 'main', '--json', '--', 'a.ts', '--b'])).toEqual({ base: 'main', head: 'HEAD', json: true, paths: ['a.ts', '--b'] })
    expect(() => parseArgs(['--bass', 'x'])).toThrow('Unknown argument --bass')
    expect(() => parseArgs(['--base', '--json'])).toThrow('--base needs a ref.')
  })

  it('refuses a rules ref that is not there, rather than judging the change by its own rules', () => {
    write('src/a.ts', 'b\n')
    commit('change')
    expect(() => tierOfChange({ root: repo, base: 'main', head: 'top', rulesRef: 'origin/main' })).toThrow('origin/main is not a commit here.')
  })
})
