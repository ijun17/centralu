import type { SessionHandle } from '../adapters/contract.js'

/** How long a tool may take to say it took a wake before it is taken as taken (it has not failed, and sending again could run the work twice) */
export const MAIL_ACCEPT_MS = 90_000

/**
 * Hands a wake to the tool and waits until the tool took it (docs/agent-host/lifecycle/turn-endings-and-mail.md "The mailbox's delivery in the host"): Codex when `turn/start` answers, Claude
 * when a turn runs for it, and a rejection or a process that closed with the wake still queued is a failure, so the mailbox keeps the
 * mail and tries again. A tool that cannot track its inputs (an older CLI) has taken it when the write returns, as before.
 *
 * A tool silent for `MAIL_ACCEPT_MS` counts as having taken it. If it fails the input after that (a CLI slow to start that closes with the
 * wake still queued, a Codex whose `turn/start` is rejected late) it never ran it, so `late` is told and the mailbox puts the mail
 * back; a failure after the tool took the input is not told, since sending it again could run the work twice.
 */
/** `id`: the name the tool is given the input by, which a turn's end names back (`SessionHandle.turnInputs`) */
export async function takeInput(handle: SessionHandle, text: string, late?: (e: Error) => void, id?: string): Promise<void> {
  const origin = { kind: 'channel', server: 'centralu' } as const
  if (!handle.sendTracked) {
    handle.send(text, { origin, ...(id ? { id } : {}) })
    return
  }
  const tracked = handle.sendTracked.bind(handle)
  // 'counted': the wait ran out and the wake went on as taken, with the tool still silent
  let state: 'waiting' | 'counted' | 'taken' | 'failed' = 'waiting'
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (state !== 'waiting') return
      state = 'counted'
      console.error(`[mail] ${handle.sessionId.slice(0, 8)}: the tool has not said it took the wake in ${MAIL_ACCEPT_MS / 1000} s; counted as taken`)
      resolve()
    }, MAIL_ACCEPT_MS)
    timer.unref()
    const done = () => {
      clearTimeout(timer)
      state = 'taken'
      resolve()
    }
    const fail = (e: Error) => {
      clearTimeout(timer)
      const was = state
      if (was === 'waiting' || was === 'counted') state = 'failed'
      if (was === 'waiting') reject(e)
      else if (was === 'counted') late?.(e)
    }
    tracked(text, { accepted: done, complete: done, fail }, { origin, ...(id ? { id } : {}) }).then(done, fail)
  })
}
