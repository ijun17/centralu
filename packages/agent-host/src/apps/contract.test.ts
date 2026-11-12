import { describe, expect, it } from 'vitest'
import { appIdProblemText } from '@cc/protocol'
import { proposedMcpServerNameError } from './contract.js'

describe('the name of a proposed MCP server (#2173)', () => {
  it('is refused in the one wording of an app id that cannot be used, since an approved server becomes the app of that name', () => {
    expect(proposedMcpServerNameError('app-notes')).toBe(appIdProblemText('app-notes', 'server-prefix'))
    expect(proposedMcpServerNameError('control')).toBe(appIdProblemText('control', 'builtin'))
    expect(proposedMcpServerNameError('control')).toBe('"control" is reserved. Pick another app id.')
    expect(proposedMcpServerNameError('app-notes')).toBe('"app-notes" cannot be an app id: ids starting with "app-" are how apps attach to sessions. Pick another.')
  })
})
