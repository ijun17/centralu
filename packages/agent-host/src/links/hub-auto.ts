import { errorMessage } from '@cc/protocol'
import { asObj } from '../json-value.js'

/**
 * What a machine says of its "Allow auto from a linked computer" (#1273): the one reading of `host.hubAuto` (and of
 * `host.setHubAuto`, which answers the same) that the window (`LinkedMachine.hubAuto`) and the Assistant
 * (`LinkedSessions.hubAuto`) share. `older`: that machine's Centralu predates the switch. Any other failure (a timeout, a
 * refusal there) is thrown as it came
 */
export type HubAuto = 'on' | 'off' | 'older'

export async function askHubAuto(call: (method: string, params: unknown) => Promise<unknown>, allowed?: boolean): Promise<HubAuto> {
  try {
    const r = asObj(await (allowed === undefined ? call('host.hubAuto', {}) : call('host.setHubAuto', { allowed })))
    return r.allowed === true ? 'on' : 'off'
  } catch (err) {
    if (/^Unknown method/.test(errorMessage(err))) return 'older'
    throw err
  }
}
