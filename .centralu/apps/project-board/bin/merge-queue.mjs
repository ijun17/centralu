#!/usr/bin/env node
// The merge queue's watch command (#956): a session runs it in the background after queue_merge, and
// it exits with the message when one of that session's items needs attention or lands, which wakes
// the session. While it waits it also drives the queue (the same lease as the board app's server), so
// the queue carries on when Centralu has stopped the idle app.
//
//   node .centralu/apps/project-board/bin/merge-queue.mjs watch --data <app data folder>
//        [--owner <name>] [--after <seq>] [--minutes <n>]
//
// queue_merge answers the whole command. Exit codes: 0 news without attention (merged, closed) or
// nothing left queued, 3 an item needs attention, 6 no news before the deadline (run it again),
// 2 a wrong argument or an unreadable queue, 130 or 143 stopped by SIGINT or SIGTERM (the tick in
// flight finishes and is written down first).
import { releaseLease, readQueue, startDriver, TICK_MS } from '../queue-driver.mjs'
import { watchState } from '../queue.mjs'
import { noticeText, watchStart } from '../notice-acks.mjs'
import { shellQuote } from '../util.mjs'

const USAGE = 'Usage: node .centralu/apps/project-board/bin/merge-queue.mjs watch --data <folder> [--owner <name>] [--after <seq>] [--minutes <n>]'
const args = process.argv.slice(2)
const opts = { data: null, owner: null, after: null, minutes: 100 }
let ok = args[0] === 'watch'
for (let i = 1; ok && i < args.length; i += 2) {
  const [k, v] = [args[i], args[i + 1]]
  if (v === undefined) ok = false
  else if (k === '--data') opts.data = v
  else if (k === '--owner') opts.owner = v
  else if (k === '--after') opts.after = Number(v)
  else if (k === '--minutes') opts.minutes = Number(v)
  else ok = false
}
if (!ok || !opts.data || (opts.after !== null && !Number.isInteger(opts.after)) || !(opts.minutes > 0)) {
  console.error(USAGE)
  process.exit(2)
}

let after
try {
  // With no --after, from the owner's oldest message not acknowledged yet (#1351), so nothing missed is skipped
  after = opts.after ?? watchStart(readQueue(opts.data), opts.owner)
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
const again = (seq) => ['node', shellQuote(process.argv[1]), 'watch', '--data', shellQuote(opts.data), ...(opts.owner ? ['--owner', shellQuote(opts.owner)] : []), '--after', String(seq)].join(' ')
const holder = `watch:${process.pid}`
const driver = startDriver(opts.data, { holder })
const deadline = Date.now() + opts.minutes * 60_000

let finishing = false
async function finish(code, lines) {
  if (finishing) return
  finishing = true
  // A merge in flight finishes and is written down before the process ends
  await driver.stop()
  releaseLease(opts.data, holder)
  for (const l of lines) console.log(l)
  process.exit(code)
}

function look() {
  let q
  try {
    q = readQueue(opts.data)
  } catch (e) {
    console.error(e.message)
    return finish(2, [])
  }
  // A batch whose last member landed still has its end to do (and maybe a notice): wait for it
  const { news, left, batchPending, done } = watchState(q, { owner: opts.owner, after })
  const tail = left.length
    ? [`${left.length} still queued${opts.owner ? ` for ${opts.owner}` : ''}. To hear about them, run again in the background:`, again(q.seq)]
    : batchPending
      ? ['A batch is still finishing. To hear when it has, run again in the background:', again(q.seq)]
      : ['Nothing left queued.']
  const code = news.some((e) => e.kind === 'attention') ? 3 : 0
  if (done && news.length) return finish(code, [...news.map(noticeText), ...tail])
  if (done) return finish(0, [`Nothing queued${opts.owner ? ` for ${opts.owner}` : ''}.`])
  if (Date.now() > deadline) return news.length ? finish(code, [...news.map(noticeText), ...tail]) : finish(6, [`No news in ${opts.minutes} minutes.`, ...tail])
  // The driver's timer does not hold the process; this one does
  setTimeout(look, TICK_MS)
}
process.on('SIGINT', () => finish(130, []))
process.on('SIGTERM', () => finish(143, []))
look()
