import { describe, expect, it } from 'vitest'
import { HUB_SENDER, isHubSender } from './hub-sender.js'

// #2532 (docs/plans/assistant-rename.md §3.4): this build records `_hub-assistant`; rows and machines of earlier builds keep the old one
describe("the hub's sender under both names (#2133)", () => {
  it('is recorded under the new name, and either name is read', () => {
    expect(HUB_SENDER).toBe('_hub-assistant')
    expect(isHubSender('_hub-orchestrator')).toBe(true)
    expect(isHubSender('_hub-coordinator')).toBe(false)
    expect(isHubSender(undefined)).toBe(false)
  })
})
