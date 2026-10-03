// Posts one Discord message for a GitHub event, so that what other people say on the
// repository reaches the owner without opening GitHub (2026-10-03: a contributor's reply on
// #82 went unanswered for two weeks; nothing had told anyone it was there).
//
// Run by .github/workflows/discord-notify.yml. Reads the event from GITHUB_EVENT_PATH and
// posts to DISCORD_WEBHOOK. Everything taken from the event is used as data only (JSON in,
// JSON out); nothing from it reaches a shell, which matters because pull_request_target runs
// with secrets on events that strangers can trigger.
//
// Local check: GITHUB_EVENT_NAME=issue_comment GITHUB_EVENT_PATH=event.json \
//   DISCORD_WEBHOOK=http://127.0.0.1:8787/ node .github/scripts/discord-notify.mjs

import { readFileSync } from 'node:fs'

const webhook = process.env.DISCORD_WEBHOOK ?? ''
const eventName = process.env.GITHUB_EVENT_NAME ?? ''
const skip = (process.env.SKIP_ACTORS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

if (!webhook) {
  console.log('::notice::DISCORD_WEBHOOK is not set; nothing sent.')
  process.exit(0)
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'))
const actor = event.sender?.login ?? ''
if (event.sender?.type === 'Bot' || actor.endsWith('[bot]')) {
  console.log(`Skipped: ${actor} is a bot.`)
  process.exit(0)
}
if (skip.includes(actor.toLowerCase())) {
  console.log(`Skipped: ${actor} is in SKIP_ACTORS.`)
  process.exit(0)
}

const COLOR = { open: 0x2da44e, closed: 0x8250df, comment: 0x0969da, review: 0xbf8700 }

/** Discord rejects an embed description over 4096 characters; a notification needs far less. */
const excerpt = (text, max = 700) => {
  const t = (text ?? '').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const ref = (item) => `#${item.number} ${item.title}`

function describe() {
  const repo = event.repository?.full_name ?? ''
  switch (eventName) {
    case 'issues': {
      const i = event.issue
      const verb = { opened: 'opened', closed: 'closed', reopened: 'reopened' }[event.action]
      if (!verb) return null
      return {
        title: `Issue ${verb}: ${ref(i)}`,
        url: i.html_url,
        description: event.action === 'opened' ? excerpt(i.body) : '',
        color: event.action === 'closed' ? COLOR.closed : COLOR.open,
      }
    }
    case 'issue_comment': {
      if (event.action !== 'created') return null
      const i = event.issue
      const kind = i.pull_request ? 'PR' : 'issue'
      return {
        title: `Comment on ${kind} ${ref(i)}`,
        url: event.comment.html_url,
        description: excerpt(event.comment.body),
        color: COLOR.comment,
      }
    }
    case 'pull_request_target': {
      const p = event.pull_request
      const from = p.head?.repo && p.head.repo.full_name !== repo ? ` (from ${p.head.repo.full_name})` : ''
      if (event.action === 'opened' || event.action === 'reopened' || event.action === 'ready_for_review') {
        const verb = { opened: 'opened', reopened: 'reopened', ready_for_review: 'ready for review' }[event.action]
        return { title: `PR ${verb}: ${ref(p)}${from}`, url: p.html_url, description: excerpt(p.body), color: COLOR.open }
      }
      if (event.action === 'closed') {
        return { title: `PR ${p.merged ? 'merged' : 'closed'}: ${ref(p)}`, url: p.html_url, description: '', color: COLOR.closed }
      }
      if (event.action === 'review_requested') {
        const who = event.requested_reviewer?.login ?? event.requested_team?.name ?? 'a reviewer'
        return { title: `Review requested from ${who}: ${ref(p)}${from}`, url: p.html_url, description: '', color: COLOR.review }
      }
      return null
    }
    case 'pull_request_review': {
      if (event.action !== 'submitted') return null
      const state = { approved: 'Approved', changes_requested: 'Changes requested', commented: 'Review' }[event.review.state] ?? 'Review'
      return {
        title: `${state} on PR ${ref(event.pull_request)}`,
        url: event.review.html_url,
        description: excerpt(event.review.body),
        color: COLOR.review,
      }
    }
    case 'pull_request_review_comment': {
      if (event.action !== 'created') return null
      return {
        title: `Review comment on PR ${ref(event.pull_request)}`,
        url: event.comment.html_url,
        description: `\`${event.comment.path}\`\n${excerpt(event.comment.body)}`,
        color: COLOR.review,
      }
    }
    case 'discussion':
    case 'discussion_comment': {
      const d = event.discussion
      if (eventName === 'discussion' && event.action !== 'created') return null
      if (eventName === 'discussion_comment' && event.action !== 'created') return null
      const isComment = eventName === 'discussion_comment'
      return {
        title: `${isComment ? 'Comment on discussion' : 'Discussion opened'}: ${ref(d)}`,
        url: isComment ? event.comment.html_url : d.html_url,
        description: excerpt(isComment ? event.comment.body : d.body),
        color: COLOR.comment,
      }
    }
    default:
      return null
  }
}

const d = describe()
if (!d) {
  console.log(`Skipped: ${eventName}/${event.action} is not announced.`)
  process.exit(0)
}

const body = {
  username: 'GitHub · centralu',
  allowed_mentions: { parse: [] },
  embeds: [
    {
      title: d.title.slice(0, 256),
      url: d.url,
      description: d.description || undefined,
      color: d.color,
      author: { name: actor, url: event.sender?.html_url, icon_url: event.sender?.avatar_url },
      timestamp: new Date().toISOString(),
    },
  ],
}

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
if (!res.ok) {
  console.log(`::error::Discord answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  process.exit(1)
}
console.log(`Sent: ${d.title}`)
