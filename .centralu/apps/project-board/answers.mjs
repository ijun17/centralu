// The owner's answers to "Needs decision" items, kept on this machine only (pure: no IO).
//
// The repository is public and the owner answers in their own words and language, so an answer from
// the screen never goes to GitHub as written. It is saved in this app's data folder (server.mjs,
// through centralu.readJson/writeJson: outside the repository), and an agent records the decision on
// the issue in English with `comment`, then marks the answer recorded with that comment's address.
// Until then the owner can edit or delete it.

/** At most this many answers are kept; the oldest recorded ones go first. */
export const ANSWERS_MAX = 300

export const answerKey = (repository, number) => `${String(repository).toLowerCase()}#${Number(number)}`
const keyOf = (a) => answerKey(a.repository, a.number)

/** The answer waiting to be recorded for an item, else its latest recorded one, else null. */
export function answerFor(list, repository, number) {
  const key = answerKey(repository, number)
  const mine = list.filter((a) => keyOf(a) === key)
  return mine.find((a) => !a.recordedAt) ?? mine.at(-1) ?? null
}

/** The answers not recorded yet, oldest first. */
export const unrecorded = (list) => list.filter((a) => !a.recordedAt)

const trimTo = (list) => {
  if (list.length <= ANSWERS_MAX) return list
  const drop = new Set(list.filter((a) => a.recordedAt).slice(0, list.length - ANSWERS_MAX))
  return list.filter((a) => !drop.has(a))
}

/**
 * Saves the owner's answer for an item: a new one, or the text of the one not recorded yet replaced
 * (an answer already recorded stays as it was; a new answer starts beside it). Throws a sentence when
 * there is nothing to save.
 */
export function saveAnswer(list, { repository, number, title, text, now }) {
  const body = String(text ?? '').trim()
  if (!body) throw new Error('The answer is empty; write it first.')
  const key = answerKey(repository, number)
  const open = list.find((a) => keyOf(a) === key && !a.recordedAt)
  if (open) {
    const answer = { ...open, text: body, title: title ?? open.title, updatedAt: now }
    return { list: list.map((a) => (a === open ? answer : a)), answer, replaced: true }
  }
  const answer = { repository, number: Number(number), title: title ?? null, text: body, savedAt: now, updatedAt: now, recordedAt: null, recordedUrl: null }
  return { list: trimTo([...list, answer]), answer, replaced: false }
}

/** Deletes the item's answer that is not recorded yet. A recorded one is history and stays. */
export function deleteAnswer(list, repository, number) {
  const key = answerKey(repository, number)
  const open = list.find((a) => keyOf(a) === key && !a.recordedAt)
  if (!open) throw new Error(list.some((a) => keyOf(a) === key) ? 'Its answer is recorded on GitHub already; it is not deleted here.' : 'There is no saved answer for it.')
  return { list: list.filter((a) => a !== open), answer: open }
}

/** The comment id of a GitHub comment address on that item, or a sentence saying why it is not one. */
export function commentIdOf(url, repository, number) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)$/i.exec(String(url ?? '').trim())
  if (!m) return { problem: `"${url}" is not the address of a comment on GitHub (https://github.com/owner/name/issues/N#issuecomment-ID).` }
  if (m[1].toLowerCase() !== String(repository).toLowerCase() || Number(m[2]) !== Number(number))
    return { problem: `${url} is a comment on ${m[1]}#${m[2]}, not on ${repository}#${number}.` }
  return { id: m[3] }
}

/** Marks the item's waiting answer recorded by the comment at `url`. */
export function markRecorded(list, repository, number, url, now) {
  const key = answerKey(repository, number)
  const open = list.find((a) => keyOf(a) === key && !a.recordedAt)
  if (!open) throw new Error('There is no answer waiting to be recorded for it.')
  const answer = { ...open, recordedAt: now, recordedUrl: url }
  return { list: list.map((a) => (a === open ? answer : a)), answer }
}
