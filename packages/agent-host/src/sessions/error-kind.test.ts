import { describe, expect, it } from 'vitest'
import { errorKind, planLimitResetAt } from './error-kind.js'

// The kind is all of an error's text another session's model reads (#1186 review); the rest is the tool's words
describe('the kind of an error', () => {
  it.each([
    ['API Error: 529 {"type":"overloaded_error"}', 'overloaded'],
    ['Service temporarily unavailable (503)', 'overloaded'],
    ["You've hit your usage limit · resets 3pm", 'usage limit'],
    ["Cursor's model refused the turn: Upgrade your plan to continue", 'usage limit'],
    ['429 rate_limit_error: too many requests', 'usage limit'],
    ['API Error: Connection refused (ECONNREFUSED)', 'network'],
    ['getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['the API refused the request', 'refused'],
    ['Permission denied', 'refused'],
    ['the process exited', 'other'],
    ['', 'other'],
  ])('%j is %s', (message, kind) => {
    expect(errorKind(message)).toBe(kind)
  })
})

describe('when a limit’s own words say it resets (#1415)', () => {
  // 2026-11-13 10:00 on this computer's clock
  const now = new Date(2026, 10, 13, 10, 0).getTime()
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime()

  it("reads Codex's 429 (measured on 0.160.0) and Claude Code's limit end, on this computer's clock", () => {
    expect(planLimitResetAt("You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 6:17 PM.", now)).toBe(at(2026, 10, 13, 18, 17))
    expect(planLimitResetAt("You've hit your session limit · resets 7:50pm", now)).toBe(at(2026, 10, 13, 19, 50))
    expect(planLimitResetAt("You've hit your session limit · resets 1am", now)).toBe(at(2026, 10, 14, 1))
    expect(planLimitResetAt('… try again at 12:05 AM.', now)).toBe(at(2026, 10, 14, 0, 5))
  })

  it('takes a later day when the words name it', () => {
    expect(planLimitResetAt("You've hit your usage limit. … or try again at Nov 17th, 2026 6:17 PM.", now)).toBe(at(2026, 10, 17, 18, 17))
  })

  it('says nothing when the words name no time, or one that is not a time', () => {
    expect(planLimitResetAt('Claude AI usage limit reached', now)).toBeUndefined()
    expect(planLimitResetAt('try again later', now)).toBeUndefined()
    expect(planLimitResetAt('resets 13:70pm', now)).toBeUndefined()
  })
})
