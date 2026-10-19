import { describe, expect, it } from 'vitest'
import { errorKind } from './error-kind.js'

// The kind is all of an error's text another session's model reads (#1186 review); the rest is the tool's words
describe('the kind of an error', () => {
  it.each([
    ['API Error: 529 {"type":"overloaded_error"}', 'overloaded'],
    ['Service temporarily unavailable (503)', 'overloaded'],
    ["You've hit your usage limit · resets 3pm", 'usage limit'],
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
