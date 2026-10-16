// The reader's threads: an issue or pull request with its comments, cached like the board, and
// rendered once per body.
import { freshCache } from './cache.mjs'
import { CACHE_MS } from './config.mjs'
import { readThread } from './github.mjs'
import { renderInline, renderMarkdown } from './markdown.mjs'

// --- The reader: an item's thread, read in the view -------------------------------------------------
// The view shows an issue or pull request (body, comments, labels, board fields) without the browser,
// and answers a "Needs decision" item with a comment. Threads are cached like the board: in memory,
// for CACHE_MS, at most THREADS_MAX of them; a comment posted forgets its thread, and a read that
// started before the post never refills it.

const THREADS_MAX = 40
// A thread that is not there (null) is not kept: it is asked again next time
const threads = freshCache({ ttlMs: CACHE_MS, max: THREADS_MAX, keep: (t) => Boolean(t) })
const threadKey = (repo, number) => `${String(repo).toLowerCase()}#${number}`
export const thread = (repo, number, { fresh = false } = {}) => threads.get(threadKey(repo, number), () => readThread(repo, number), { fresh })
export const forgetThread = (repo, number) => threads.forget(threadKey(repo, number))

// Rendered once per body: the same thread read again from the cache is not rendered again
const rendered = new WeakMap()
export function html(holder, text, opts) {
  let h = rendered.get(holder)
  if (h === undefined) {
    h = renderMarkdown(text, opts)
    rendered.set(holder, h)
  }
  return h
}
export const renderOpts = (t) => ({ repo: t.repository, base: t.url })

/** A decision summary's fields as inline HTML, for the view's "Needs decision" list and the reader. */
export function summaryView(s, opts) {
  if (!s) return null
  const inline = (v) => (v ? renderInline(v, { ...opts, breaks: true }) : null)
  return { date: s.date, question: inline(s.question), options: inline(s.options), recommendation: inline(s.recommendation), url: s.url, answered: s.answered }
}
