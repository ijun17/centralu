import type { MailFacts, MailboxRecords } from '../dev-services/store/mailbox.js'
import { PERSON } from './address.js'
import type { MailReach } from './reach.js'
import { ASKS_PER_HOUR, HOUR_MS, MINUTE_MS, REFUSAL_TEXT, REPEAT_WINDOW_MS, WARNING_TEXT, hourlyKey, postsPerMinute, refuse, type SenderClass } from './rules.js'

/** What the guards read and write: the store, who is who, and the person's notice (`MessageService.notice`) */
export type GuardDeps = {
  records: MailboxRecords
  reach: MailReach
  notice: (recipient: string, input: { body: string; facts: MailFacts; dedupeKey: string }) => unknown
}

/** One send as the guards see it: `requests[i]` says whether the message asks `to[i]` for something */
export type GuardedSend = { sender: string; cls: SenderClass; to: readonly string[]; text: string; requests: readonly boolean[] }

/** The guards of a send, over the store so a restart does not reset them (§7.5). Run before the send's transaction (`MessageService.send`) */
export function sendGuards(d: GuardDeps, { sender, cls, to, text, requests }: GuardedSend, now: number): void {
  const label = (a: string) => d.reach.labelOf(a)
  for (const r of to) {
    if ((cls === 'session' || cls === 'app') && d.records.sameBody(sender, r, text, now - REPEAT_WINDOW_MS)) {
      throw guardRefused(d, sender, 'repeat', WARNING_TEXT.repeat(label(sender), r === PERSON ? 'you' : label(r)), REFUSAL_TEXT.repeat(label(r)), now)
    }
  }
  const limit = postsPerMinute(cls)
  if (limit !== Infinity && d.records.postsSince(sender, now - MINUTE_MS) >= limit) {
    throw guardRefused(d, sender, 'rate_limited', WARNING_TEXT.rate_limited(label(sender), limit), `at most ${limit} posts a minute from ${cls === 'app' ? 'an app' : 'a session'}: wait a minute`, now)
  }
  for (const [i, r] of to.entries()) {
    if (requests[i] && d.records.requestsSince(d.reach.askGroupMembers(sender), r, now - HOUR_MS) >= ASKS_PER_HOUR) {
      throw guardRefused(d, sender, 'ask_rate', WARNING_TEXT.ask_rate(label(sender)), REFUSAL_TEXT.ask_rate(), now)
    }
  }
}

/**
 * A guard's refusal (#1684): the sender is refused, and the person hears of it in one line, through the warnings' own path (`WARNING_TEXT`, a notice
 * to the person keyed by the clock hour), once an hour for each sender and kind. The guards run before the send's transaction, so a refusal does not
 * take the person's line back with it
 */
function guardRefused(d: GuardDeps, sender: string, reason: 'repeat' | 'rate_limited' | 'ask_rate', toPerson: string, toSender: string, now: number): Error {
  d.notice(PERSON, { body: toPerson, facts: { guardRefused: { sender, reason } }, dedupeKey: hourlyKey(`guard:${reason}:${sender}`, now) })
  return refuse(reason, toSender)
}
