import { describe, expect, it } from 'vitest'
import { MailMessage } from './entities/mail.js'
import { RpcMethods } from './commands.js'

describe("a hub's look into a linked machine's chain (#2268)", () => {
  it('reads nothing for anyone only when asked: a call without `lookIn`, from a window or an older hub, reads for the person as before', () => {
    const params = RpcMethods['mail.thread'].params
    expect(params.parse({ threadId: 't', tail: 100 })).toEqual({ threadId: 't', tail: 100, lookIn: false })
    expect(params.parse({ threadId: 't', lookIn: true })).toEqual({ threadId: 't', lookIn: true })
  })

  it("an offer's answer names the machine's id in mail with no more room than any other id", () => {
    const answer = RpcMethods['host.hubOffer'].result
    expect(answer.parse({ ok: true, mail: true, host: 'hub-bbbb2222' })).toMatchObject({ host: 'hub-bbbb2222' })
    expect(answer.safeParse({ ok: true, host: 'x'.repeat(201) }).success).toBe(false)
    // An older machine says none
    expect(answer.parse({ ok: true, mail: true })).not.toHaveProperty('host')
  })
})

const party = { address: 'session:h/s1', kind: 'session' }
const message = (over: Record<string, unknown>) => ({ id: 'm1', seq: 1, sender: party, kind: 'question', body: 'Which?', createdAt: 1, ...over })

describe('a mail message’s choices (#1630)', () => {
  it('reads 2 to 6 strings as they are, and shows the question without them when a shape this build cannot read comes (a later host with 7, one, a wrong type), keeping the rest', () => {
    expect(MailMessage.parse(message({ choices: ['main', 'dev'] })).choices).toEqual(['main', 'dev'])
    for (const choices of [['1', '2', '3', '4', '5', '6', '7'], ['only'], 'main', [1, 2], { a: 1 }]) {
      const read = MailMessage.parse(message({ choices }))
      expect(read.choices).toBeUndefined()
      expect(read).toMatchObject({ id: 'm1', body: 'Which?', kind: 'question' })
    }
  })
})
