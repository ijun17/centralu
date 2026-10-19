// What the main guard does about a red main (#1259 step 1, main-guard.mjs finds the culprit): tells the
// session that queued the culprit and files an issue with the failure. The decisions are pure here;
// `actOnRed` does what they say.
import { createIssue } from './github.mjs'
import { config } from './config.mjs'
import { pushEvent } from './queue.mjs'
import { short } from './util.mjs'

/** The pull request a squash commit's subject names, `… (#N)`, or null */
export const prOfSubject = (subject) => {
  const m = /\(#(\d+)\)\s*$/.exec(String(subject ?? ''))
  return m ? Number(m[1]) : null
}

/** The queue's item that landed `sha`: by the commit it landed as, else by the pull request its subject names */
export function landedItem(q, sha, subject) {
  const byCommit = q.items.find((i) => i.state === 'merged' && i.commit === sha)
  if (byCommit) return byCommit
  const pr = prOfSubject(subject)
  if (pr === null) return null
  return [...q.items].reverse().find((i) => i.state === 'merged' && i.pr === pr && String(i.repo).toLowerCase() === String(config.repository).toLowerCase()) ?? null
}

/** What failed, in one line: the jobs and the first failing line */
export const failureLine = (red) => `${red.jobs?.length ? red.jobs.join(', ') : 'CI'} failed at ${short(red.red)}${red.line ? `: ${red.line}` : ''}`

/** The issue a red main files: title and body */
export function redIssue({ red, culprit, how, why, did, ref }) {
  const pr = culprit ? prOfSubject(culprit.subject) : null
  const title = culprit ? `Main is red since ${pr ? `${ref(config.repository, pr)} ` : `${short(culprit.sha)} `}${culprit.subject.replace(/\s*\(#\d+\)\s*$/, '')}`.slice(0, 120) : `Main is red at ${short(red.red)}; the culprit was not found`
  const body = [
    `## What failed`,
    '',
    `The full tier on main failed at ${red.red}${red.url ? ` (${red.url})` : ''}: ${red.jobs?.length ? red.jobs.join(', ') : 'see the run'}.`,
    ...(red.line ? ['', '```', red.line, '```'] : []),
    '',
    `## The culprit`,
    '',
    culprit ? `${culprit.sha} "${culprit.subject}": ${how}.` : `Not found: ${why}`,
    ...(red.commits?.length ? ['', `Commits since main was last fully green (${short(red.green)}):`, ...red.commits.map((c) => `- ${short(c.sha)} ${c.subject}`)] : []),
    '',
    `## What the merge queue did`,
    '',
    did,
    '',
    'Filed by the merge queue\'s main guard (#1259): changes land after the fast tier, and the full tier runs on main after they land.',
  ].join('\n')
  return { title, body }
}

/**
 * Acts on a red main: `found` is the guard's (`{ red, culprit, how }`, or `{ red, culprit: null, why }`).
 * Files the issue, tells the culprit's session through its queue item (a message event: the session
 * hears it as a notice, or through its watch command), and answers what to record on the hunt.
 */
export async function actOnRed(dir, found, { now = Date.now(), ref, update }) {
  const { red, culprit, how, why } = found
  const did = culprit ? 'Reported it here and to the session that queued it; it was not reverted.' : 'Reported it here; nothing was reverted.'
  const issue = await createIssue(config.repository, redIssue({ red, culprit, how, why, did, ref }))
  const at = new Date(now).toISOString()
  update((q) => {
    const item = culprit ? landedItem(q, culprit.sha, culprit.subject) : null
    const pr = culprit ? prOfSubject(culprit.subject) : null
    const text = culprit
      ? `Merge queue: main went red after ${pr ? ref(config.repository, pr) : short(culprit.sha)} (${culprit.subject}) landed: ${failureLine(red)}. Found as ${how}. Fix it on a new branch and queue it; ${ref(config.repository, issue.number)} has the failure.`
      : `Merge queue: main went red at ${short(red.red)} (${failureLine(red)}), and its culprit was not found: ${why} ${ref(config.repository, issue.number)} has the failure.`
    pushEvent(q, item ?? { repo: config.repository, pr: pr ?? null, owner: null }, { kind: 'main-red', text, notify: true, at, data: { issue: issue.number } })
  })
  return { outcome: 'reported', issue: issue.number }
}
