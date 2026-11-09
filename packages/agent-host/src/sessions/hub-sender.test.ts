import { describe, expect, it } from 'vitest'
import { HUB_SENDER, isHubSender, isQualifiedHubSender } from './hub-sender.js'

// #2133 step 3 (docs/plans/assistant-rename.md): this build records `HUB_SENDER`; a later one records `_hub-assistant`
describe("the hub's sender under both names (#2133)", () => {
  it('takes either name, and nothing else', () => {
    expect(isHubSender(HUB_SENDER)).toBe(true)
    expect(isHubSender('_hub-assistant')).toBe(true)
    expect(isHubSender('_hub-coordinator')).toBe(false)
    expect(isHubSender(undefined)).toBe(false)
  })

  it('takes either name qualified with a machine, and that machine only when one is named', () => {
    expect(isQualifiedHubSender(`m1.${HUB_SENDER}`)).toBe(true)
    expect(isQualifiedHubSender('m1._hub-assistant')).toBe(true)
    expect(isQualifiedHubSender('m1._hub-assistant', 'm1')).toBe(true)
    expect(isQualifiedHubSender(`m1.${HUB_SENDER}`, 'm1')).toBe(true)
    expect(isQualifiedHubSender('m2._hub-assistant', 'm1')).toBe(false)
    expect(isQualifiedHubSender('_hub-assistant')).toBe(false)
    expect(isQualifiedHubSender('m1.w1')).toBe(false)
  })
})
