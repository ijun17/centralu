import { describe, expect, it } from 'vitest'
import { browserHostOptions, isMockMode, MissingHostTokenError } from '../apps/web/src/bootstrap.js'

describe('browser host bootstrap', () => {
  it('recognizes mock mode before host token validation', () => {
    // Given: the E2E mock URL has no host token in the Vite environment.
    const search = '?mock=1'

    // When: the runtime route is selected.
    const mockMode = isMockMode(search)

    // Then: the caller can use the host-free mock platform path.
    expect(mockMode).toBe(true)
  })

  it('requires an explicit token for non-mock browser runtime', () => {
    // Given: the browser runtime is pointed at the real host without a token.
    const readOptions = () => browserHostOptions({})

    // When / Then: startup fails clearly before a dev-token fallback can be used.
    expect(readOptions).toThrow(MissingHostTokenError)
  })

  it('passes the explicit host token to the web platform', () => {
    // Given: Vite received the host token from the host launch.
    const env = { VITE_HOST_URL: 'ws://127.0.0.1:6000', VITE_HOST_TOKEN: 'random-launch-token' }

    // When: browser host options are read.
    const observed = browserHostOptions(env)

    // Then: the caller-supplied secret is the only token used.
    expect(observed).toEqual({ hostUrl: 'ws://127.0.0.1:6000', token: 'random-launch-token' })
  })
})
