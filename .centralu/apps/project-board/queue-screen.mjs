// Which tier a batch must run before it lands (#1538, the owner's decision of 2026-10-26): the fast tier, or the heavy
// jobs too (the e2e shards, both browsers) when the batch holds a change to the screen. The queue keeps no list of paths
// for that: what counts as a change to the screen is `screenFiles` in .github/scripts/ci-changes.mjs, beside the mapping
// of files to the jobs that run for them. The queue reads that script from the default branch (project.json
// `ci.screen.judge`), runs it in a child process with the files the batch adds to the default branch, and takes its
// answer. Whatever keeps it from answering (no such script yet, an older one without `--screen`, the files not known,
// a crash) is read as "it does": a batch that cannot be judged runs the heavy jobs, as a change that cannot be judged
// is deep (queue-integrate.mjs).
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CI } from './config.mjs'
import { FATAL, GitHubError, readCompareFiles, readRepoFile } from './github.mjs'

const JUDGE_MS = 30_000

/** The line of a crash that says what it was (not the stack, nor the Node version it ends with) */
const errorLine = (stderr) => {
  const lines = String(stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(Node\.js v|at )/.test(l))
  return lines.find((l) => /^\w*Error\b/.test(l)) ?? lines.at(-1) ?? ''
}

/** Runs the judge (its source text) on the files: `{ screen, file, count }`, or throws. */
function runJudge(source, files) {
  return mkdtemp(join(tmpdir(), 'cc-queue-screen-')).then(async (dir) => {
    try {
      const file = join(dir, 'ci-changes.mjs')
      await writeFile(file, source)
      const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [file, '--screen'], { cwd: dir, timeout: JUDGE_MS, maxBuffer: 1024 * 1024, env: { LC_ALL: 'C', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } }, (error, stdout, stderr) =>
          error ? reject(new Error(errorLine(stderr) || error.message)) : resolve(stdout),
        )
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(files))
      })
      const answer = JSON.parse(String(out))
      if (typeof answer?.screen !== 'boolean') throw new Error('it answered something else than { screen }')
      return answer
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => null)
    }
  })
}

/**
 * The tier the batch on `branch` runs: `{ tier: 'full', why }` when it changes the screen or cannot be judged, else
 * `{ tier: 'quick', why }`. The files are what the branch adds to the default branch (the members merged into it).
 * Only a rate limit, a login or the network (FATAL) throws, as every read of GitHub does: the batch is tried again.
 */
export async function judgeBatch(repo, defaultBranch, branch) {
  const heavy = (why) => ({ tier: 'full', why })
  try {
    const source = await readRepoFile(repo, CI.screen.judge, defaultBranch)
    if (source === null) return heavy(`${CI.screen.judge} is not on ${defaultBranch}, so it cannot be told whether it changes the screen`)
    const files = await readCompareFiles(repo, defaultBranch, branch)
    if (files === null) return heavy(`the files it changes are not known (GitHub lists too many, or none), so it cannot be told whether it changes the screen`)
    const answer = await runJudge(source, files)
    return answer.screen
      ? { tier: 'full', why: `it changes the screen (${answer.file})` }
      : { tier: 'quick', why: `it changes nothing the UI scenarios see (${files.length} file${files.length === 1 ? '' : 's'})` }
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return heavy(`it could not be told whether it changes the screen (${e instanceof GitHubError ? e.message : (e?.message ?? e)})`)
  }
}

/** Whether batches are judged at all: landing after the fast tier, two tiers of CI, and a judge named. */
export const screenOn = () => CI.fullTier !== null && CI.landTier === 'quick' && CI.screen !== null
