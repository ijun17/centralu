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

  it('recognizes demo mode as host-free mock mode', () => {
    // Given: the user opens the seeded demo without a host token.
    const search = '?demo=grid'

    // When: the runtime route is selected.
    const mockMode = isMockMode(search)

    // Then: demo mode keeps working without touching browser host credentials.
    expect(mockMode).toBe(true)
  })

  it('rejects whitespace-only tokens instead of falling back or authenticating empty', () => {
    // Given: a shell snippet produced an empty-looking token.
    const readOptions = () => browserHostOptions({ VITE_HOST_TOKEN: '   ' })

    // When / Then: the token fails closed.
    expect(readOptions).toThrow(MissingHostTokenError)
  })

  it('main entry keeps the token failure renderable and contains no dev-token fallback', async () => {
    // Given / When: the browser entry source is inspected as the real startup surface.
    const source = await import('node:fs/promises').then((fs) => fs.readFile('apps/web/src/main.tsx', 'utf8'))

    // Then: missing credentials are rendered into the DOM instead of left as a top-level module throw.
    expect(source).toContain('data-testid="startup-error"')
    expect(source).not.toContain('dev-token')
  })

})
