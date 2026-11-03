import { describe, expect, it } from 'vitest'
import { openCodeRefusal } from './refusal.js'

/** Lines of OpenCode 1.19.4's stderr (`--print-logs --log-level ERROR`), recorded against a local provider that answers 429 */
const line = (agent: string, error: string) =>
  `timestamp=2026-11-03T05:47:05.067Z level=ERROR run=63c04314 message="stream error" providerID=openai modelID=gpt-5 session.id=ses_e600df488ffeGAYTEpMWl3DhiT small=${agent === 'title'} agent=${agent} mode=primary error.error="${error}"`

describe('OpenCode’s log line for a refused request', () => {
  it('gives the provider’s words for the turn’s own request', () => {
    expect(openCodeRefusal(line('build', 'AI_APICallError: You exceeded your current quota, please check your plan and billing details.'))).toBe(
      'You exceeded your current quota, please check your plan and billing details.',
    )
    expect(openCodeRefusal(line('build', 'AI_APICallError: Free usage limit reached. Subscribe to continue.'))).toBe('Free usage limit reached. Subscribe to continue.')
  })

  it('ignores the title request, an error that is not a limit, and any other line', () => {
    expect(openCodeRefusal(line('title', 'AI_RetryError: Failed after 3 attempts. Last error: You exceeded your current quota'))).toBeNull()
    expect(openCodeRefusal(line('build', 'AI_APICallError: Cannot connect to API: socket hang up'))).toBeNull()
    expect(openCodeRefusal('timestamp=2026-11-03T05:47:05.067Z level=INFO message=stream small=false')).toBeNull()
  })
})
