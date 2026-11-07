// How old the board's own code is (#2121): an instance runs whatever its checkout holds, which nobody pulls on purpose. Two
// instances ran 252 and 32 commits behind main on 2026-11-06, one of them with a main guard that filed wrong reverts (#2087),
// and nothing said so. This reads the checkout's HEAD and asks GitHub how far main is ahead of it. It never pulls: the
// checkout may be somebody's working tree.
import { relative } from 'node:path'
import { APP_DIR } from './config.mjs'
import { git, GitError, topLevel } from './git.mjs'
import { COMPARE_FILES_MAX, GitHubError, readBehind, readRepo } from './github.mjs'
import { now as clock } from './clock.mjs'
import { plural } from './util.mjs'

// For the tests only: the folder to read the code's HEAD from (empty: do not look), and how long an answer is kept
const dirEnv = process.env.PROJECT_BOARD_CODE_DIR
const codeDir = () => (dirEnv !== undefined ? dirEnv || null : APP_DIR)
const KEEP_MS = Number(process.env.PROJECT_BOARD_CODE_CHECK_MS ?? 5 * 60_000)

let kept = { at: -Infinity, key: '', value: null }

/**
 * `{ head, behind, appChanged, text }`: the commit the app's code is at, how many commits of main it lacks, whether any of
 * the app's own files changed in them (the files list GitHub gives may be cut: then yes), and the line `merge_queue` shows.
 * Null when the code is current, is not in a git checkout, or GitHub cannot be asked: no warning is better than a wrong one.
 * Asked at most every few minutes.
 */
export async function codeAge(repo, now = clock()) {
  const dir = codeDir()
  if (!dir) return null
  const key = `${repo}\0${dir}`
  if (kept.key === key && now - kept.at < KEEP_MS) return kept.value
  let value = null
  try {
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const { defaultBranch } = await readRepo(repo)
    const ahead = await readBehind(repo, head, defaultBranch)
    if (ahead && ahead.behind > 0) {
      const root = await topLevel(dir)
      const app = `${relative(root, dir).replaceAll('\\', '/').replace(/\/$/, '')}/`
      const appChanged = ahead.files === null || ahead.files.length >= COMPARE_FILES_MAX || ahead.files.some((f) => f.startsWith(app))
      value = {
        head,
        behind: ahead.behind,
        appChanged,
        branch: defaultBranch,
        text: `Board code: ${plural(ahead.behind, 'commit')} behind ${defaultBranch} (running ${head.slice(0, 7)})${appChanged ? ', and the board app changed since' : ', none of them in the board app'}.`,
      }
    }
  } catch (e) {
    // A checkout that is not git's, or a GitHub that cannot be asked: nothing known
    if (!(e instanceof GitHubError || e instanceof GitError)) throw e
  }
  kept = { at: now, key, value }
  return value
}

/** The warning when this instance drives the queue or the main guard with code that is behind, else null */
export function staleWarning(age, { queue, guard }) {
  if (!age?.appChanged) return null
  const what = [queue ? 'the merge queue' : null, guard ? 'the main guard' : null].filter(Boolean).join(' and ')
  if (!what) return null
  return `Warning: this instance drives ${what} with board code ${plural(age.behind, 'commit')} behind ${age.branch}. It lacks later fixes (an old main guard once filed wrong reverts, #2087): update its checkout (git pull --ff-only) and restart the app, or stop it driving (queue-driver.json {"drive": false}).`
}
