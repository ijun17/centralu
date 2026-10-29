/** A session's credential (#1405): what an agent's processes call the host with */
import { describe, expect, it } from 'vitest'
import { sessionOfToken, sessionToken } from './session-token.js'
import { bridgeToken } from './bridge-token.js'
import { limitedToken } from './limited-token.js'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe("a session's credential", () => {
  it('names its own session, made from this token only', () => {
    const c = sessionToken('tok', SID)
    expect(c.startsWith(`ccs1:${SID}:`)).toBe(true)
    expect(sessionOfToken('tok', c)).toBe(SID)
    expect(sessionOfToken('other', c)).toBeNull()
    // Another session's id under this one's mac is no credential
    expect(sessionOfToken('tok', c.replace(SID, '1f8fad5b-d9cb-469f-a165-70867728950e'))).toBeNull()
  })

  it('is neither the bridge credential nor the limited one, and none of them is it', () => {
    expect(sessionOfToken('tok', bridgeToken('tok', SID))).toBeNull()
    expect(sessionOfToken('tok', limitedToken('tok'))).toBeNull()
    expect(sessionOfToken('tok', 'tok')).toBeNull()
    expect(sessionOfToken('tok', `ccs1:not-a-session:${'x'.repeat(43)}`)).toBeNull()
  })
})
