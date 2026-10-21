import { frameField } from '@cc/protocol'

/** How a script's name is made safe to put in a header Centralu writes, a stored row and a screen label (docs/plans/mailbox.md §8.1, slice 3.8b) */

const LABEL_MAX = 40
/** What a label may hold: letters, digits and a few marks. No quote, bracket, angle bracket or line break, so a label cannot end the sentence it stands in */
const NOT_IN_A_LABEL = /[^\p{L}\p{N} ._:@/+-]/gu

/**
 * What the connection called itself in its hello (`RpcContext.label`, cut and never checked by the transport), made safe to put in a
 * header Centralu writes, a stored row and a screen label. Taken from the connection, never from the call. A program that said
 * nothing is `unnamed`
 */
export function scriptLabel(raw: string | null | undefined): string {
  const plain = frameField(raw ?? '').replace(NOT_IN_A_LABEL, '').replace(/ +/g, ' ').trim().slice(0, LABEL_MAX).trim()
  return plain || 'unnamed'
}
