import { describe, expect, it } from 'vitest'
import { openCodeRefusal } from './refusal.js'

const SES = 'ses_e600df488ffeGAYTEpMWl3DhiT'

/** Lines of OpenCode 1.19.4's stderr (`--print-logs --log-level ERROR`), recorded against a local provider that answers 429 */
const line = (error: string, { agent = 'build', session = SES } = {}) =>
  `timestamp=2026-11-03T05:47:05.067Z level=ERROR run=63c04314 message="stream error" providerID=openai modelID=gpt-5 session.id=${session} small=${agent === 'title'} agent=${agent} mode=primary error.error="${error}"`

describe('OpenCode’s log line for a refused request', () => {
  it('gives the provider’s words for the turn’s own request', () => {
    expect(openCodeRefusal(line('AI_APICallError: You exceeded your current quota, please check your plan and billing details.'), SES)).toBe(
      'You exceeded your current quota, please check your plan and billing details.',
    )
    expect(openCodeRefusal(line('AI_APICallError: Free usage limit reached. Subscribe to continue.'), SES)).toBe('Free usage limit reached. Subscribe to continue.')
  })

  it('reads the log’s JSON escapes', () => {
    expect(openCodeRefusal(line('AI_APICallError: You\u2019ve hit your \\"usage limit\\"'), SES)).toBe('You’ve hit your "usage limit"')
  })

  it('ignores the title request, another session’s request, a rate limit, an error that is not a limit, and any other line', () => {
    const quota = 'AI_RetryError: Failed after 3 attempts. Last error: You exceeded your current quota'
    expect(openCodeRefusal(line(quota, { agent: 'title' }), SES)).toBeNull()
    expect(openCodeRefusal(line('AI_APICallError: You exceeded your current quota'), 'ses_other')).toBeNull()
    expect(openCodeRefusal(line('AI_APICallError: Rate limit reached for gpt-5 on tokens per min. Please try again in 6.0s'), SES)).toBeNull()
    const gemini = 'AI_APICallError: You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 10. Please retry in 41s.'
    expect(openCodeRefusal(line(gemini), SES)).toBeNull()
    expect(openCodeRefusal(line('AI_APICallError: Cannot connect to API: socket hang up'), SES)).toBeNull()
    expect(openCodeRefusal('timestamp=2026-11-03T05:47:05.067Z level=INFO message=stream small=false', SES)).toBeNull()
  })
})
