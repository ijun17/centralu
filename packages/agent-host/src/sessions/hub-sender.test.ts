import { describe, expect, it } from 'vitest'
import { HUB_SENDER, isHubSender } from './hub-sender.js'

// #2133 step 3 (docs/plans/assistant-rename.md): this build records `HUB_SENDER`; a later one records `_hub-assistant`
describe("the hub's sender under both names (#2133)", () => {
  it('takes either name, and nothing else', () => {
    expect(isHubSender(HUB_SENDER)).toBe(true)
    expect(isHubSender('_hub-assistant')).toBe(true)
    expect(isHubSender('_hub-coordinator')).toBe(false)
    expect(isHubSender(undefined)).toBe(false)
  })
})
