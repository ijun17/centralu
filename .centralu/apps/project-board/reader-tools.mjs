// The reader: read_item for the view, read_discussion for agents.
import { z } from './runtime/centralu-app-runtime.mjs'
import { answerFor } from './answers.mjs'
import { board, fieldsOf, itemInput, itemOf, matches, refreshInput, unseen } from './board.mjs'
import { config } from './config.mjs'
import { answerView, ownerAnswers } from './decision-tools.mjs'
import { GitHubError, THREAD_MAX_COMMENTS } from './github.mjs'
import { answering, forView } from './handlers.mjs'
import { decisionSummary } from './markdown.mjs'
import { answer, linesAnswer } from './reply.mjs'
import { html, renderOpts, summaryView, thread } from './threads.mjs'
import { plural } from './util.mjs'

const DEFAULT_COMMENTS = 50

async function readItem({ item, refresh, comments }) {
  const want = itemOf(item)
  const [t, b] = await Promise.all([thread(want.repo, want.number, { fresh: refresh === true }), board().catch(() => null)])
  const ref = want.ref
  if (!t) throw new GitHubError('not-found', unseen(ref))
  const onBoard = b?.items.find(matches(want)) ?? null
  const limit = Math.min(THREAD_MAX_COMMENTS, Math.max(1, Math.floor(comments ?? DEFAULT_COMMENTS)))
  const opts = renderOpts(t)
  const shown = t.comments.slice(-limit)
  const decision = onBoard?.status != null && onBoard.status.toLowerCase() === String(config.decisionStatus).toLowerCase()
  const kind = t.type === 'pull' ? 'pull request' : 'issue'
  const summary = `${ref} ${t.title} (${kind}, ${t.state.toLowerCase()}): ${plural(t.totalComments, 'comment')}, ${shown.length} shown.`
  return answer(summary, {
    ok: true,
    item: {
      ref,
      type: t.type,
      repository: t.repository,
      number: t.number,
      title: t.title,
      url: t.url,
      state: t.state,
      stateReason: t.stateReason,
      draft: t.draft,
      author: t.author,
      createdAt: t.createdAt,
      labels: t.labels,
      inProject: onBoard !== null,
      ...fieldsOf(onBoard),
      html: html(t, t.body, opts),
    },
    comments: shown.map((c) => ({ id: c.id, url: c.url, author: c.author, createdAt: c.createdAt, html: html(c, c.body, opts) })),
    totalComments: t.totalComments,
    loadedComments: t.comments.length,
    needsDecision: decision,
    decisionStatus: config.decisionStatus,
    decision: summaryView(decisionSummary(t.comments), opts),
    // The owner's answer saved on this machine: waiting to be recorded, or the latest recorded one
    ownerAnswer: answerView(answerFor(await ownerAnswers(), want.repo, want.number)),
  })
}

/** A compact thread for agents: raw body, then newest comments first, without view-only HTML. */
async function readDiscussion({ item, comments }) {
  const want = itemOf(item)
  const t = await thread(want.repo, want.number)
  const shown = t?.comments.slice(-Math.min(100, Math.max(1, Math.floor(comments ?? 20)))).reverse() ?? []
  if (!t) throw new GitHubError('not-found', unseen(want.ref))
  const summary = `${want.ref} ${t.title}: body and ${shown.length} newest of ${t.totalComments} comments.`
  const body = String(t.body ?? '').trim()
  const rows = shown.map((c) => `${c.createdAt ?? '?'} ${c.author}: ${c.body}`)
  return linesAnswer(summary, [['body', 'Body:', body ? [body] : ['(empty)']], ['comments', 'Comments, newest first:', rows]], {
    item: { ref: want.ref, type: t.type, state: t.state, url: t.url },
    totalComments: t.totalComments,
  })
}

export const tools = {
  // The reader. Screen-only: an agent has `gh` and the board's own tools; these answer the view with
  // rendered HTML. Failures come back as data (`ok: false`), so the view says why in place.
  read_item: {
    config: {
      title: 'Read an issue or pull request',
      description: 'An issue or pull request with its labels, Status/Priority/Area, body and latest comments, rendered for the view.',
      inputSchema: z.object({
        item: itemInput,
        refresh: refreshInput,
        comments: z.number().int().positive().max(THREAD_MAX_COMMENTS).optional().describe(`How many of the latest comments; default ${DEFAULT_COMMENTS}`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['app'] } },
    },
    handler: forView(readItem),
  },

  read_discussion: {
    config: {
      title: 'Read an issue or pull request discussion',
      description: 'Read the body and latest comments of an issue or pull request. Compact text; comments are newest first.',
      inputSchema: z.object({ item: itemInput, comments: z.number().int().positive().max(100).optional().describe('Newest comments to read; default 20') }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(readDiscussion),
  },
}
