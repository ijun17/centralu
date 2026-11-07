// How old the board's own code is (#2121): an instance runs whatever its checkout held when it started, which nobody pulls on
// purpose. Two instances ran 252 and 32 commits behind main on 2026-11-06, one of them with a main guard that filed wrong
// reverts (#2087), and nothing said so. This remembers the checkout's HEAD as the app started (Node loads its modules once, so a
// later pull changes the files and not the code that runs) and asks GitHub how far main is ahead of it. It never pulls: the
// checkout may be somebody's working tree.
import { APP_DIR } from './config.mjs'
import { git, GitError } from './git.mjs'
import { COMPARE_FILES_MAX, GitHubError, readBehind, readRepo } from './github.mjs'
import { now as clock } from './clock.mjs'
import { plural } from './util.mjs'

// For the tests only: the folder to read the code's HEAD from (empty: do not look), and how long an answer is kept
const dirEnv = process.env.PROJECT_BOARD_CODE_DIR
const codeDir = () => (dirEnv !== undefined ? dirEnv || null : APP_DIR)
const KEEP_MS = Number(process.env.PROJECT_BOARD_CODE_CHECK_MS ?? 5 * 60_000)

/** The checkout's HEAD, or null where it is not a git checkout (an installed copy) */
async function headOf(dir) {
  try {
    return (await git(dir, ['rev-parse', 'HEAD'])).trim() || null
  } catch (e) {
    if (e instanceof GitError) return null
    throw e
  }
}

// The commit this process's code came from
const LOADED = codeDir() ? await headOf(codeDir()) : null

let kept = { at: -Infinity, key: '', value: null }
let asking = null

async function ask(repo, dir) {
  const current = await headOf(dir)
  if (!LOADED || !current) return null
  try {
    const { defaultBranch } = await readRepo(repo)
    const ahead = await readBehind(repo, LOADED, defaultBranch)
    const moved = current !== LOADED
    if (!ahead || (ahead.behind === 0 && !moved)) return null
    // The app's folder inside the repository: git says it from where it is run ('' at the root, else 'a/b/')
    const app = (await git(dir, ['rev-parse', '--show-prefix'])).trim()
    const appChanged = ahead.behind > 0 && (ahead.files === null || ahead.files.length >= COMPARE_FILES_MAX || ahead.files.some((f) => f.startsWith(app)))
    const lines = []
    if (ahead.behind > 0) lines.push(`Board code: ${plural(ahead.behind, 'commit')} behind ${defaultBranch} (running ${LOADED.slice(0, 7)})${appChanged ? ', and the board app changed since' : ', none of them in the board app'}.`)
    if (moved) lines.push(`The checkout is at ${current.slice(0, 7)} now, not at ${LOADED.slice(0, 7)} as the app started: it runs the code it started with until it is restarted.`)
    return { head: LOADED, current, moved, behind: ahead.behind, appChanged, branch: defaultBranch, text: lines.join(' ') }
  } catch (e) {
    // A GitHub that cannot be asked: nothing known (no warning is better than a wrong one)
    if (e instanceof GitHubError || e instanceof GitError) return null
    throw e
  }
}

/**
 * `{ head, behind, appChanged, moved, text }`: the commit the running code came from, how many commits of main it lacks, whether any
 * of the app's own files changed in them (the files list GitHub gives may be cut: then yes), whether the checkout has moved on
 * since the app started, and the lines `merge_queue` shows. Null when the code is current, is not in a git checkout, is not known
 * to GitHub, or GitHub cannot be asked. Asked at most every few minutes, by one caller at a time.
 */
export async function codeAge(repo, now = clock()) {
  const dir = codeDir()
  if (!dir) return null
  const key = `${repo}\0${dir}`
  if (kept.key === key && now - kept.at < KEEP_MS) return kept.value
  asking ??= ask(repo, dir).finally(() => (asking = null))
  const value = await asking
  kept = { at: now, key, value }
  return value
}

/** The warning when this instance drives the queue or the main guard on code that is behind, else null */
export function staleWarning(age, { queue, guard }) {
  if (!age?.appChanged) return null
  const what = [queue ? 'the merge queue' : null, guard ? 'the main guard' : null].filter(Boolean).join(' and ')
  if (!what) return null
  return `Warning: this instance drives ${what} with board code ${plural(age.behind, 'commit')} behind ${age.branch}. It lacks later fixes (an old main guard once filed wrong reverts, #2087): update its checkout (git pull --ff-only) and restart the app${guard ? ', or stop the guard here (queue-driver.json {"drive": false})' : ''}.`
}
