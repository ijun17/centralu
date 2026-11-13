import { errorMessage, notifyPolicyOf } from '@cc/protocol/client'
import type { MailThreadRow, MailThreadView, NormalizedEvent, WatchView } from '@cc/protocol/client'
import { mailNotification } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { alertPerson } from './events/notices.js'
import { coalescedRead } from './single-flight.js'

/**
 * The person's mailbox (#1347, docs/plans/mailbox.md §10.1): its list, a thread, and the acts that are the person's. The host
 * owns every fact; this keeps a copy and asks again when `mail_changed` says something moved. Nothing is drawn ahead of the
 * host's answer: a reply shows when the host has it.
 */

type MailActions = Pick<
  AppState,
  'loadMail' | 'openMailThread' | 'loadOlderMail' | 'closeMailThread' | 'replyMail' | 'closeMail' | 'heldMail' | 'resumeMail' | 'wakeMail' | 'loadWatches' | 'cancelWatch'
>

/** How many messages of a thread the Inbox reads at once (the host's page) */
const MAIL_PAGE = 100

/** The open thread, brought up to date with the messages after the last one it holds (and the host's task fields) */
async function refreshThread(get: StoreGet, set: StoreSet, threadId: string): Promise<void> {
  const platform = get().platform
  const open = get().mailThread
  if (!platform || open?.thread.id !== threadId) return
  const last = open.messages.at(-1)?.seq ?? 0
  try {
    const view = await platform.mail.thread(threadId, { after: last })
    const now = get().mailThread
    if (get().platform !== platform || now?.thread.id !== threadId) return
    set({ mailThread: merged(now, view) })
  } catch {
    /* the thread is gone (retention) or the host is: the list says so when it is read */
  }
}

export const mailActions = (set: StoreSet, get: StoreGet): MailActions => {
  /** Runs one of the person's acts and says why in a toast when the host refuses it */
  const act = async (what: string, run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run()
      return true
    } catch (e) {
      set({ toast: `Could not ${what}: ${errorMessage(e)}` })
      return false
    }
  }

  return {
    // Another `mail_changed` while the list is read asks for one more read after it, not one each, and waits for that one
    loadMail() {
      return coalescedRead('mail', get, (platform) => platform.mail.list(), (mail) => void set({ mail }))
    },

    async openMailThread(threadId) {
      const platform = get().platform
      if (!platform) return
      try {
        // Its end: where the question waiting for the person is, however long the thread (what was unread is read now); `loadOlderMail` goes back
        const view = await platform.mail.thread(threadId, { tail: MAIL_PAGE })
        if (get().platform !== platform) return
        set({ mailThread: view })
        void get().loadMail()
      } catch (e) {
        set({ toast: `Could not open this mail: ${errorMessage(e)}` })
      }
    },

    async loadOlderMail() {
      const platform = get().platform
      const open = get().mailThread
      const first = open?.messages[0]?.seq
      if (!platform || !open || first === undefined || !open.older) return
      try {
        const page = await platform.mail.thread(open.thread.id, { tail: MAIL_PAGE, before: first })
        const now = get().mailThread
        if (get().platform !== platform || now?.thread.id !== open.thread.id) return
        set({ mailThread: merged(now, page, true) })
      } catch (e) {
        set({ toast: `Could not load earlier messages: ${errorMessage(e)}` })
      }
    },

    closeMailThread() {
      set({ mailThread: null })
    },

    async replyMail(text, kind, answers, threadId) {
      const platform = get().platform
      const id = threadId ?? get().mailThread?.thread.id
      if (!platform || !id) return false
      const sent = await act('send that', async () => {
        const view = await platform.mail.reply(id, text, kind, answers)
        const now = get().mailThread
        if (get().platform === platform && now?.thread.id === id) set({ mailThread: merged(now, view) })
        void get().loadMail()
      })
      if (!sent && answers !== undefined) {
        await refreshThread(get, set, id)
        void get().loadMail()
      }
      return sent
    },

    async closeMail(outcome, threadId) {
      const platform = get().platform
      const id = threadId ?? get().mailThread?.thread.id
      if (!platform || !id) return false
      // The host's own act on the person's mailbox: it needs no other machine to answer, so a thread whose other party is away closes as any (#2226)
      return act('close this mail', async () => {
        await platform.mail.close(id, outcome)
        await refreshThread(get, set, id)
        void get().loadMail()
      })
    },

    async heldMail(action, row) {
      const platform = get().platform
      if (!platform) return false
      return act(action === 'release' ? 'send that mail' : 'dismiss that mail', async () => {
        await platform.mail.held(action, row.recipient.address, [row.messageId])
        await get().loadMail()
      })
    },

    async resumeMail(target) {
      const platform = get().platform
      if (!platform) return false
      return act('resume that mail', async () => {
        await platform.mail.resume(target)
        await get().loadMail()
      })
    },

    async wakeMail(wake) {
      const platform = get().platform
      if (!platform) return false
      return act(wake ? 'wake those sessions' : 'leave those sessions', async () => {
        await platform.mail.wake(wake)
        await get().loadMail()
      })
    },

    loadWatches(sessionId) {
      return coalescedRead(`watches:${sessionId}`, get, (platform) => platform.mail.watches(sessionId), (rows) => {
        set((s) => ({ watches: { ...s.watches, [sessionId]: rows } }))
      })
    },

    async cancelWatch(sessionId, id) {
      const platform = get().platform
      if (!platform) return false
      return act('cancel that watch', async () => {
        await platform.mail.cancelWatch(id)
        await get().loadWatches(sessionId)
      })
    },
  }
}

/** The thread as it is now, with the messages of a later read after those it already holds (by `seq`), and the host's task fields */
function merged(now: MailThreadView, read: MailThreadView, earlier = false): MailThreadView {
  const seen = new Set(now.messages.map((m) => m.seq))
  // Whether there is more before what is held: a page from the end changes nothing about it, an earlier page says
  return { ...read, older: earlier ? read.older : now.older, messages: [...now.messages, ...read.messages.filter((m) => !seen.has(m.seq))].sort((a, b) => a.seq - b.seq) }
}

/**
 * Whether a thread waits on the person: it has mail unread for them, or a question to answer (#2233: a question read but not answered still waits). The one
 * predicate of the list's order (`arrangeInbox`: waiting, or under Earlier), of the badge's count (`mailAttention`) and of its edge (`mailAsksYou`)
 */
export const threadWaits = (t: Pick<MailThreadRow, 'unread' | 'ask'>): boolean => t.unread > 0 || t.ask !== null

/** How many things want the person: threads that wait on them (`threadWaits`) or hold mail for them to act on, and the crowd question (the inbox's count) */
export function mailAttention(mail: AppState['mail']): number {
  if (!mail) return 0
  // Mail held in a thread the person is not in is theirs to act on too, and so is the question about sleeping sessions (one)
  const threads = new Set(mail.threads.filter((t) => threadWaits(t) || t.held > 0).map((t) => t.id))
  for (const h of mail.held) threads.add(h.threadId)
  return threads.size + (mail.waiting > 0 ? 1 : 0)
}

/**
 * How many threads wait on the person's answer (#2227): a question, or a message that needs a reply, addressed to them and not answered. With the live approval cards this is
 * what the header badge's solid edge says (`InboxPill`). Read off the host's list on every render, never kept (docs/state-management.md §3)
 */
export function mailAsksYou(mail: AppState['mail']): number {
  return mail ? mail.threads.filter((t) => t.ask !== null).length : 0
}

/** How many watches a session's header counts: a selector over the host's rows, never kept (docs/state-management.md §3) */
export const watchCount = (rows: readonly WatchView[] | undefined): number => rows?.length ?? 0

/** The mailbox's news (`mail_changed`): the list is read again, and the thread open in the Inbox if it is the one named; `watches_changed`: that session's watches. True when it was one */
export function mailEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  if (e.type === 'watches_changed') {
    void get().loadWatches(e.sessionId)
    return true
  }
  if (e.type !== 'mail_changed') return false
  // A new message the person can read: one notification each, of any kind (#1630)
  const notice = e.arrived ? mailNotification(e.arrived, { appFocused: get().appFocused, policy: notifyPolicyOf(get().prefs) }) : null
  if (notice && e.arrived) alertPerson(notice, `mail:${e.arrived.messageId}`, set, get)
  void get().loadMail()
  if (get().mailThread?.thread.id === e.threadId) void refreshThread(get, set, e.threadId)
  return true
}
