// Fetches main's bundle record for build.yml's `verify` job (#1181, tooling/bundle-budget.mjs).
//
// Every `verify` run uploads the size of the app's JS as the `bundle-size` artifact. This finds the
// newest one uploaded by a push to main: it lists main's runs of build.yml (newest first, a page at
// a time) and asks each for its artifact, so pull request and merge-queue runs, which upload too,
// never push main's record out of reach. The same steps run on every event: the audit of build.yml
// (docs/releasing.md, "Workflow event audit") lets a pull request's run stand for main's only when no
// job branches on the event, so main is picked by the run that uploaded, never by this run's event.
//
// When no run of main has a record (the first runs after this landed, or none in the pages read),
// main is measured instead: its tip, built in a worktree the same way styles.test.ts builds. That
// takes a minute or two and keeps the comparison from ever being skipped in CI.
//
// It never fails the step. It leaves, in <folder>, either bundle-size.json (main's record) or
// missing.txt (why there is none), and styles.test.ts fails with that reason.
//
//   node .github/scripts/bundle-base.mjs <folder>   (GH_TOKEN and GH_REPO set; gh, git and pnpm on PATH)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { jsBytesOf, readDeclarations, writeBundleRecord } from '../../tooling/bundle-budget.mjs'

export const ARTIFACT = 'bundle-size'
const PER_PAGE = 50
const PAGES = 6

/**
 * main's newest record: walks main's push runs page by page, newest first, and answers the first
 * unexpired `bundle-size` artifact with its run, or null. `api(path)` answers GitHub's JSON. A run
 * whose head repository is not this one (a fork's branch named main) is passed over.
 */
export function findMainArtifact(api, { branch = 'main', pages = PAGES } = {}) {
  for (let page = 1; page <= pages; page++) {
    const listed = api(`actions/workflows/build.yml/runs?branch=${branch}&event=push&per_page=${PER_PAGE}&page=${page}`)
    const runs = (listed?.workflow_runs ?? [])
      .filter((r) => r?.head_branch === branch && r.head_repository?.id === r.repository?.id)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    for (const run of runs) {
      const found = (api(`actions/runs/${run.id}/artifacts?name=${ARTIFACT}`)?.artifacts ?? []).find((a) => a?.name === ARTIFACT && !a.expired)
      if (found) return { run, artifact: found }
    }
    if ((listed?.workflow_runs ?? []).length < PER_PAGE) break
  }
  return null
}

/** main's size measured here: its tip in a worktree, installed and built as styles.test.ts builds. */
function measureMain(root) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bundle-main-'))
  const out = mkdtempSync(join(tmpdir(), 'cc-bundle-main-out-'))
  const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
  try {
    // Only a shallow checkout gets a shallow fetch: in verify's full one, `--depth=1` would cut main's history, which
    // tooling/type-aware-lint.test.ts reads for the merge base with main (#1339)
    const shallow = run('git', ['rev-parse', '--is-shallow-repository'], root).trim() === 'true'
    run('git', ['fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', 'main'], root)
    const sha = run('git', ['rev-parse', 'FETCH_HEAD'], root).trim()
    run('git', ['worktree', 'add', '--detach', dir, sha], root)
    run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], dir)
    run(process.execPath, [join(dir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir'], join(dir, 'apps/web'), { NODE_ENV: 'production' })
    return { bytes: jsBytesOf(join(out, 'assets')), sha, declared: readDeclarations(dir).map((d) => d.name), measured: true }
  } finally {
    try {
      run('git', ['worktree', 'remove', '--force', dir], root)
    } catch {
      rmSync(dir, { recursive: true, force: true })
    }
    rmSync(out, { recursive: true, force: true })
  }
}

function main() {
  const dir = process.argv[2]
  const repo = process.env.GH_REPO
  if (!dir || !repo) throw new Error('usage: GH_REPO=<owner/name> node .github/scripts/bundle-base.mjs <folder>')
  mkdirSync(dir, { recursive: true })
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const missing = (why) => {
    writeFileSync(join(dir, 'missing.txt'), `${why}\n`)
    console.log(why)
  }
  let found
  try {
    found = findMainArtifact((path) => JSON.parse(gh(['api', `repos/${repo}/${path}`])))
  } catch (e) {
    return missing(`GitHub did not answer the search for main's record: ${String(e.stderr || e.message).trim().split('\n')[0]}`)
  }
  if (found) {
    try {
      gh(['run', 'download', String(found.run.id), '--repo', repo, '--name', ARTIFACT, '--dir', dir])
    } catch (e) {
      return missing(`main's record from run ${found.run.id} could not be downloaded: ${String(e.stderr || e.message).trim().split('\n')[0]}`)
    }
    if (!existsSync(join(dir, 'bundle-size.json'))) return missing(`run ${found.run.id}'s ${ARTIFACT} artifact holds no bundle-size.json`)
    console.log(`main's bundle record: run ${found.run.id}, commit ${found.run.head_sha}.`)
    return
  }
  console.log(`No run of main in its last ${PAGES * PER_PAGE} pushes has a ${ARTIFACT} record: measuring main instead.`)
  try {
    const record = measureMain(process.cwd())
    writeBundleRecord(dir, record)
    console.log(`main at ${record.sha}: ${record.bytes} B, measured.`)
  } catch (e) {
    missing(`no run of main has a ${ARTIFACT} record, and measuring main failed: ${String(e.message).trim().split('\n')[0]}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
