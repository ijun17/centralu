import { describe, expect, it } from 'vitest'
import { MailMessage } from './entities/mail.js'

const party = { address: 'session:h/s1', kind: 'session' }
const message = (over: Record<string, unknown>) => ({ id: 'm1', seq: 1, sender: party, kind: 'question', body: 'Which?', createdAt: 1, ...over })

describe('a mail message’s choices (#1630)', () => {
  it('reads 2 to 6 strings as they are', () => {
    expect(MailMessage.parse(message({ choices: ['main', 'dev'] })).choices).toEqual(['main', 'dev'])
  })

  it('shows the question without choices when a shape this build cannot read comes (a later host with 7, one, a wrong type), and keeps the rest', () => {
    for (const choices of [['1', '2', '3', '4', '5', '6', '7'], ['only'], 'main', [1, 2], { a: 1 }]) {
      const read = MailMessage.parse(message({ choices }))
      expect(read.choices).toBeUndefined()
      expect(read).toMatchObject({ id: 'm1', body: 'Which?', kind: 'question' })
    }
  })
})
