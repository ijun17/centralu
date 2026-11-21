import type { SessionHandle } from '../adapters/contract.js'

/** How long a tool may take to say it took a wake before it is taken as taken (it has not failed, and sending again could run the work twice) */
export const MAIL_ACCEPT_MS = 90_000

/**
 * Hands a wake to the tool and waits until the tool took it (docs/agent-host/lifecycle/turn-endings-and-mail.md "The mailbox's delivery in the host"): Codex when `turn/start` answers, Claude
 * when a turn runs for it, and a rejection or a process that closed with the wake still queued is a failure, so the mailbox keeps the
 * mail and tries again. A tool that cannot track its inputs (an older CLI) has taken it when the write returns.
 *
 * A tool silent for `MAIL_ACCEPT_MS` counts as having taken it: a wake given while a turn runs waits behind it, and the tool names it only
 * when a turn takes it, so waiting for that would hold the mailbox for the whole turn. A Claude Code at rest that does not say it read it fails
 * it well before (`TURN_START_MS`); one counted with no turn running has no turn coming for it, which its caller tells as a stop. If it fails
 * the input after that (a CLI slow to start that closes with the wake still queued, a Codex whose `turn/start` is rejected late) it never ran
 * it, so `late` is told and the mailbox puts the mail back; a failure after the tool took the input is not told, since sending it again could
 * run the work twice.
 */
/**
 * `id`: the name the tool is given the input by, which a turn's end names back (`SessionHandle.turnInputs`). `taken`: told once, in the same step
 * the tool took the input or it was counted, before the tool's next event is handled: a turn can begin and end in one read, and its end must
 * find the delivery recorded. `counted`: the wait ran out with the tool still silent, so whether a turn will run it is not known
 */
export async function takeInput(handle: SessionHandle, text: string, o: { late?: (e: Error) => void; id?: string; taken?: () => void } = {}): Promise<'taken' | 'counted'> {
  const origin = { kind: 'channel', server: 'centralu' } as const
  if (!handle.sendTracked) {
    handle.send(text, { origin, ...(o.id ? { id: o.id } : {}) })
    o.taken?.()
    return 'taken'
  }
  const tracked = handle.sendTracked.bind(handle)
  // 'counted': the wait ran out and the wake went on as taken, with the tool still silent
  let state: 'waiting' | 'counted' | 'taken' | 'failed' = 'waiting'
  return new Promise<'taken' | 'counted'>((resolve, reject) => {
    const took = (as: 'taken' | 'counted') => {
      clearTimeout(timer)
      // Taken after it was counted: a failure now is not told
      if (state === 'counted' && as === 'taken') state = 'taken'
      if (state !== 'waiting') return
      state = as
      o.taken?.()
      resolve(as)
    }
    const timer = setTimeout(() => {
      if (state !== 'waiting') return
      console.error(`[mail] ${handle.sessionId.slice(0, 8)}: the tool has not taken the wake in ${MAIL_ACCEPT_MS / 1000} s (it waits behind a running turn, or no turn runs it); counted as delivered`)
      took('counted')
    }, MAIL_ACCEPT_MS)
    timer.unref()
    const done = () => took('taken')
    const fail = (e: Error) => {
      clearTimeout(timer)
      const was = state
      if (was === 'waiting' || was === 'counted') state = 'failed'
      if (was === 'waiting') reject(e)
      else if (was === 'counted') o.late?.(e)
    }
    tracked(text, { accepted: done, complete: done, fail }, { origin, ...(o.id ? { id: o.id } : {}) }).then(done, fail)
  })
}
