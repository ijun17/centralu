import { errorMessage, notifyPolicyOf, ProtocolErrorCode } from '@cc/protocol/client'
import type { MailThreadRow, MailThreadView, NormalizedEvent, WatchView } from '@cc/protocol/client'
import { mailNotification } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { alertPerson } from './events/notices.js'
import { coalescedRead } from './single-flight.js'

// The person's mailbox (#1347, docs/plans/mailbox.md §12): the host owns every fact, and nothing is drawn ahead of its answer.

const NO_TASKS = { tasks: [], capped: null, unreached: [] }

// An error with the protocol's code, not a link that dropped, timed out or never sent the call
const hostAnswered = (e: unknown): boolean => e instanceof Error && 'code' in e && ProtocolErrorCode.safeParse(e.code).success

type MailActions = Pick<
  AppState,
  'loadMail' | 'loadTasks' | 'openMailThread' | 'readDeliveredMail' | 'loadOlderMail' | 'closeMailThread' | 'replyMail' | 'closeMail' | 'heldMail' | 'resumeMail' | 'wakeMail' | 'loadWatches' | 'cancelWatch'
>

const MAIL_PAGE = 100

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
    // `mail_changed` during a read asks for one more read after it, not one each
    loadMail() {
      return coalescedRead('mail', get, (platform) => platform.mail.list(), (mail) => void set({ mail }))
    },

    loadTasks() {
      /*
       * A first read the host refuses (an older host: "Unknown method") lists none; one the link failed stays unread, with
       * no count, for the read after the reconnect; a later failure keeps the list it had.
       */
      const read = async (platform: Platform) => {
        try {
          return await platform.mail.tasks()
        } catch (e) {
          if (get().mailTasks === null && hostAnswered(e)) return NO_TASKS
          throw e instanceof Error ? e : new Error(errorMessage(e))
        }
      }
      return coalescedRead('mailTasks', get, read, (mailTasks) => void set({ mailTasks }))
    },

    async openMailThread(threadId) {
      const platform = get().platform
      if (!platform) return
      try {
        // Its end, where a question waiting for the person stands; `loadOlderMail` goes back
        const view = await platform.mail.thread(threadId, { tail: MAIL_PAGE })
        if (get().platform !== platform) return
        set({ mailThread: view })
        void get().loadMail()
      } catch (e) {
        set({ toast: `Could not open this mail: ${errorMessage(e)}` })
      }
    },

    async readDeliveredMail(delivered) {
      const platform = get().platform
      if (!platform) throw new Error('Centralu is not connected')
      const threads = [...new Set(delivered.map((d) => d.threadId))]
      const read = await Promise.allSettled(threads.map((t) => platform.mail.thread(t, { all: true, lookIn: true })))
      // The host's refusal (a chain swept by retention) leaves its messages gone; a link that failed is the reader's to say
      const lost = read.find((r): r is PromiseRejectedResult => r.status === 'rejected' && !hostAnswered(r.reason))
      if (lost) throw lost.reason instanceof Error ? lost.reason : new Error(errorMessage(lost.reason))
      const kept = new Map(
        read.flatMap((r) => (r.status === 'fulfilled' ? r.value.messages.map((m) => [m.id, { message: m, subject: r.value.thread.subject, threadId: r.value.thread.id }] as const) : [])),
      )
      const messages = delivered.flatMap((d) => kept.get(d.messageId) ?? [])
      return { messages, gone: delivered.length - messages.length }
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
      // The host's own act: a thread whose other party is away closes as any (#2226)
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

    // Only a listed session's: an answer after it was deleted keeps nothing (`forgetSessions` took its rows)
    loadWatches(sessionId) {
      if (!get().sessions[sessionId]) return Promise.resolve()
      return coalescedRead(`watches:${sessionId}`, get, (platform) => platform.mail.watches(sessionId), (rows) => {
        set((s) => (s.sessions[sessionId] ? { watches: { ...s.watches, [sessionId]: rows } } : {}))
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

function merged(now: MailThreadView, read: MailThreadView, earlier = false): MailThreadView {
  const seen = new Set(now.messages.map((m) => m.seq))
  // Only an earlier page says whether there is more before what is held
  return { ...read, older: earlier ? read.older : now.older, messages: [...now.messages, ...read.messages.filter((m) => !seen.has(m.seq))].sort((a, b) => a.seq - b.seq) }
}

// docs/state-management.md §3: the one predicate of the inbox's order, count and badge; a read question still waits (#2233)
export const threadWaits = (t: Pick<MailThreadRow, 'unread' | 'ask'>): boolean => t.unread > 0 || t.ask !== null

// The inbox's count
export function mailAttention(mail: AppState['mail']): number {
  if (!mail) return 0
  // Held mail in a thread the person is not in is theirs to act on, and the question about sleeping sessions counts one
  const threads = new Set(mail.threads.filter((t) => threadWaits(t) || t.held > 0).map((t) => t.id))
  for (const h of mail.held) threads.add(h.threadId)
  return threads.size + (mail.waiting > 0 ? 1 : 0)
}

// docs/state-management.md §3: with the approval cards, the header badge's solid edge (#2227)
export function mailAsksYou(mail: AppState['mail']): number {
  return mail ? mail.threads.filter((t) => t.ask !== null).length : 0
}

// A selector, never kept (docs/state-management.md §3)
export const watchCount = (rows: readonly WatchView[] | undefined): number => rows?.length ?? 0

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
  // Tasks, the whole host's work, are read only while someone can see them
  if (get().inboxOpen) void get().loadTasks()
  if (get().mailThread?.thread.id === e.threadId) void refreshThread(get, set, e.threadId)
  return true
}
