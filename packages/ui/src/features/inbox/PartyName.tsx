import type { MailParty } from '@cc/protocol/client'
import { listedState, partyLive, partyName } from '@cc/core'
import { StateDot } from '../../components/primitives.jsx'
import { useStore } from '../../store/store.js'

/**
 * A mailbox party by name, after its live state's dot when that says something (#2258: working, an error, an approval
 * waiting; idle draws nothing). The window's copy of the session wins over the host's listed state, only as fresh as the
 * list. The name does not truncate: what stands beside it on a row gives up its width first
 */
export function PartyName({ party, className = '' }: { party: MailParty; className?: string }) {
  const live = useStore((s) => {
    const own = party.sessionId === null ? undefined : s.sessions[party.sessionId]
    return own ? listedState(own) : null
  })
  const state = partyLive(party, live)
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`}>
      {state && <StateDot state={state} />}
      {partyName(party)}
    </span>
  )
}
