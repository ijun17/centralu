// Which tier a batch must run before it lands (#1538, the owner's decision of 2026-10-26): the fast tier, or the heavy
// jobs too (the e2e shards, both browsers) when the batch holds a change to the screen. The queue keeps no list of paths
// for that: what counts as a change to the screen is `screenFiles` in .github/scripts/ci-changes.mjs, beside the mapping
// of files to the jobs that run for them. The queue reads that script from the default branch (project.json
// `ci.screen.judge`), runs it in a child process with the files the batch adds to the default branch, and takes its
// answer. Whatever keeps it from answering (no such script yet, an older one without `--screen`, the files not known,
// a crash) is read as "it does": a batch that cannot be judged runs the heavy jobs, as a change that cannot be judged
// is deep (queue-integrate.mjs).
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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

/**
 * Runs the judge (its source text) on the files: `{ screen, file, count }`, or throws with what went wrong (the exit code,
 * the error line it printed, or what it printed instead of an answer).
 *
 * The folder it is written to is taken by its real path. The judge runs its main only when it is the script Node was
 * started with (`import.meta.url` against `process.argv[1]`), and Node resolves the first to the real path but not the
 * second: from a folder behind a symlink (macOS's temp folder, /var/folders under the /var link to /private/var) it
 * printed nothing and exited 0, and every batch was taken for one that changes the screen (queue/batch-220, "Unexpected
 * end of JSON input").
 */
function runJudge(source, files) {
  // The Node this server runs on: the manifest starts it as `node`, so it is a plain Node, whatever PATH the judge gets
  const node = process.execPath
  return mkdtemp(join(tmpdir(), 'cc-queue-screen-')).then(async (made) => {
    try {
      const dir = await realpath(made)
      const file = join(dir, 'ci-changes.mjs')
      await writeFile(file, source)
      const out = await new Promise((resolve, reject) => {
        const child = execFile(node, [file, '--screen'], { cwd: dir, timeout: JUDGE_MS, maxBuffer: 1024 * 1024, windowsHide: true, env: { LC_ALL: 'C', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } }, (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr })
          const how = error.killed ? `a stop after ${JUDGE_MS / 1000} s` : typeof error.code === 'number' ? `exit code ${error.code}` : `${error.code ?? error.signal ?? 'no start'}`
          const line = errorLine(stderr)
          reject(new Error(`the judge ended with ${how}: ${line || error.message}`))
        })
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(files))
      })
      const text = String(out.stdout).trim()
      const said = errorLine(out.stderr)
      if (!text) throw new Error(`the judge printed no answer and ended with exit code 0${said ? `: ${said}` : ''}`)
      let answer
      try {
        answer = JSON.parse(text)
      } catch {
        throw new Error(`the judge printed something else than JSON: ${text.split('\n')[0].slice(0, 120)}`)
      }
      if (typeof answer?.screen !== 'boolean') throw new Error('it answered something else than { screen }')
      return answer
    } finally {
      await rm(made, { recursive: true, force: true }).catch(() => null)
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
