import { errorMessage } from '@cc/protocol/client'
import type { MailThreadView, NormalizedEvent } from '@cc/protocol/client'
import type { AppState, StoreGet, StoreSet } from './state.js'

/**
 * The person's mailbox (#1347, docs/plans/mailbox.md §10.1): its list, a thread, and the acts that are the person's. The host
 * owns every fact; this keeps a copy and asks again when `mail_changed` says something moved. Nothing is drawn ahead of the
 * host's answer: a reply shows when the host has it.
 */

type MailActions = Pick<
  AppState,
  'loadMail' | 'openMailThread' | 'loadOlderMail' | 'closeMailThread' | 'replyMail' | 'closeMail' | 'unblockMail' | 'reassignMail' | 'heldMail' | 'resumeMail' | 'wakeMail'
>

/** How many messages of a thread the Inbox reads at once (the host's page) */
const MAIL_PAGE = 100

/** The list is being read; another `mail_changed` meanwhile asks for one more read after it, not one each, and waits for that one */
let loading: Promise<void> | null = null
let again = false

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
    loadMail() {
      const platform = get().platform
      if (!platform) return Promise.resolve()
      if (loading) {
        again = true
        return loading
      }
      loading = (async () => {
        try {
          do {
            again = false
            try {
              const mail = await platform.mail.list()
              if (get().platform !== platform) return
              set({ mail })
            } catch {
              /* a host from before the mailbox, or one that is away: the last list stays */
            }
          } while (again)
        } finally {
          loading = null
        }
      })()
      return loading
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
        set({ toast: `Could not open that thread: ${errorMessage(e)}` })
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

    async replyMail(text, kind) {
      const platform = get().platform
      const open = get().mailThread
      if (!platform || !open) return false
      return act('send that', async () => {
        const view = await platform.mail.reply(open.thread.id, text, kind)
        const now = get().mailThread
        if (get().platform === platform && now?.thread.id === open.thread.id) set({ mailThread: merged(now, view) })
        void get().loadMail()
      })
    },

    async closeMail(outcome) {
      const platform = get().platform
      const open = get().mailThread
      if (!platform || !open) return false
      return act('close that thread', async () => {
        await platform.mail.close(open.thread.id, outcome)
        await refreshThread(get, set, open.thread.id)
        void get().loadMail()
      })
    },

    async unblockMail(n) {
      const platform = get().platform
      const open = get().mailThread
      if (!platform || !open) return false
      return act('unblock that thread', async () => {
        await platform.mail.unblock(open.thread.id, n)
        const fresh = await platform.mail.thread(open.thread.id, { after: open.messages.at(-1)?.seq ?? 0 })
        const now = get().mailThread
        if (get().platform === platform && now?.thread.id === open.thread.id) set({ mailThread: merged(now, fresh) })
        void get().loadMail()
      })
    },

    async reassignMail(sessionId, text) {
      const platform = get().platform
      const open = get().mailThread
      if (!platform || !open) return false
      return act('give that work to another session', async () => {
        const view = await platform.mail.reassign(open.thread.id, sessionId, text)
        const now = get().mailThread
        if (get().platform === platform && now?.thread.id === open.thread.id) set({ mailThread: merged(now, view) })
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
  }
}

/** The thread as it is now, with the messages of a later read after those it already holds (by `seq`), and the host's task fields */
function merged(now: MailThreadView, read: MailThreadView, earlier = false): MailThreadView {
  const seen = new Set(now.messages.map((m) => m.seq))
  // Whether there is more before what is held: a page from the end changes nothing about it, an earlier page says
  return { ...read, older: earlier ? read.older : now.older, messages: [...now.messages, ...read.messages.filter((m) => !seen.has(m.seq))].sort((a, b) => a.seq - b.seq) }
}

/** How many things want the person: threads with mail unread for them or mail held for them to act on, and the crowd question (the inbox's count) */
export function mailAttention(mail: AppState['mail']): number {
  if (!mail) return 0
  // Mail held in a thread the person is not in is theirs to act on too, and so is the question about sleeping sessions (one)
  const threads = new Set(mail.threads.filter((t) => t.unread > 0 || t.held > 0).map((t) => t.id))
  for (const h of mail.held) threads.add(h.threadId)
  return threads.size + (mail.waiting > 0 ? 1 : 0)
}

/** The mailbox's news (`mail_changed`): the list is read again, and the thread open in the Inbox if it is the one named. True when it was one */
export function mailEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  if (e.type !== 'mail_changed') return false
  void get().loadMail()
  if (get().mailThread?.thread.id === e.threadId) void refreshThread(get, set, e.threadId)
  return true
}
