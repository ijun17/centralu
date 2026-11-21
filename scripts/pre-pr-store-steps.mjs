// Store step numbers (#1203) for `pnpm pre-pr` (scripts/pre-pr.mjs): the ones a branch adds, and the ones main and the other
// open pull requests have.
import { otherPrs, prFiles } from './pre-pr-open-prs.mjs'
import { git } from './pre-pr-worktrees.mjs'

/** Where the store's migration steps are written: each step is a `to: N,` line of one of these files. */
export const STEP_DIR = 'packages/agent-host/src/dev-services/store/migrations/'
const STEP_LINE = /^[ \t]*to:[ \t]*(\d+)[ \t]*,/

/** The step numbers a file's text declares. */
export function stepNumbers(text) {
  return [...String(text).matchAll(new RegExp(STEP_LINE.source, 'gm'))].map((m) => Number(m[1]))
}

/**
 * The step numbers a unified diff adds under {@link STEP_DIR}: a `to: N,` line added and not removed again
 * in the same diff (a step moved to another file, or reformatted, is not a new number).
 */
export function stepsAddedByDiff(diff) {
  const added = new Set()
  const removed = new Set()
  let inSteps = false
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) inSteps = line.slice(line.lastIndexOf(' b/') + 3).startsWith(STEP_DIR)
    else if (inSteps && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      const m = STEP_LINE.exec(line.slice(1))
      if (m) (line[0] === '+' ? added : removed).add(Number(m[1]))
    }
  }
  return [...added].filter((n) => !removed.has(n)).sort((a, b) => a - b)
}

/**
 * The findings for the step numbers a branch adds: one for each that main already has, and for each that
 * another open pull request adds. `onMain` maps a number to the file that declares it; `others` is
 * `[{ number, title, head, steps }]`.
 */
export function stepFindings({ added, onMain, others }) {
  const findings = []
  const ask = 'The Assistant assigns store step numbers (CONTRIBUTING.md): ask for a free one and renumber, or exempt this check with the reason it stands.'
  for (const n of added) {
    if (onMain.has(n)) findings.push({ check: 'store-step', message: `Store step ${n} is already on main (${onMain.get(n)}). ${ask}` })
    for (const pr of others) {
      if (pr.steps.includes(n)) findings.push({ check: 'store-step', message: `Store step ${n} is also added by open pull request #${pr.number} "${pr.title}" (${pr.head}): whichever lands second conflicts. ${ask}` })
    }
  }
  return findings
}

/** The number to file of each step under {@link STEP_DIR} at a commit. */
export function stepsAt(root, commit) {
  const found = new Map()
  let out = ''
  try {
    out = git(root, ['grep', '-n', '-E', '^[[:space:]]*to:[[:space:]]*[0-9]+[[:space:]]*,', commit, '--', STEP_DIR])
  } catch {
    return found // git grep exits 1 when nothing matches
  }
  for (const l of out.split('\n').filter(Boolean)) {
    const [path, , ...text] = l.slice(commit.length + 1).split(':')
    const m = STEP_LINE.exec(text.join(':'))
    if (m) found.set(Number(m[1]), path.slice(STEP_DIR.length))
  }
  return found
}

/**
 * The open pull requests that add store steps, leaving out the stack's own (a head that is one of its
 * `commits`, or one of its branches' `names`). Only a pull request that touches {@link STEP_DIR} costs a full diff.
 */
export function otherPrsAddingSteps({ gh, root, listed, commits, names }) {
  const others = []
  for (const pr of otherPrs(listed, commits, names)) {
    if (!prFiles(gh, root, pr).some((f) => f.startsWith(STEP_DIR))) continue
    const steps = stepsAddedByDiff(gh(['pr', 'diff', String(pr.number)], root))
    if (steps.length) others.push({ number: pr.number, title: pr.title, head: pr.headRefName, steps })
  }
  return others
}
