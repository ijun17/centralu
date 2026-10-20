import { describe, expect, it } from 'vitest'
import { InputReceipts } from './input-receipts.js'

describe('what an input receipt says to its observer', () => {
  const observer = () => {
    const seen: string[] = []
    return { seen, o: { accepted: () => seen.push('accepted'), complete: () => seen.push('complete'), fail: (e: Error) => seen.push(`fail:${e.message}`) } }
  }

  it('accepted once, when the tool takes the input, and complete after it', () => {
    const receipts = new InputReceipts()
    const { seen, o } = observer()
    const r = receipts.create(o)
    receipts.accept(r.id)
    receipts.accept(r.id)
    expect(seen).toEqual(['accepted'])
    receipts.complete([r.id])
    expect(seen).toEqual(['accepted', 'complete'])
  })

  it('binding a Codex turn is the tool taking the input', () => {
    const receipts = new InputReceipts()
    const { seen, o } = observer()
    const r = receipts.create(o)
    receipts.bind(r, 'turn-1')
    expect(seen).toEqual(['accepted'])
    receipts.endTurn('turn-1')
    expect(seen).toEqual(['accepted', 'complete'])
  })

  it('an input that completes without having been seen to start was taken all the same', () => {
    const receipts = new InputReceipts()
    const { seen, o } = observer()
    const r = receipts.create(o)
    receipts.complete([r.id])
    expect(seen).toEqual(['accepted', 'complete'])
  })

  it('failed before it was taken: not accepted, and failed once', () => {
    const receipts = new InputReceipts()
    const { seen, o } = observer()
    const r = receipts.create(o)
    receipts.failAll(new Error('closed'))
    receipts.accept(r.id)
    expect(seen).toEqual(['fail:closed'])
  })
})
