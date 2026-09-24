import { describe, expect, it } from 'vitest'
import { browserHostOptions, isMockMode, MissingHostTokenError, startPlatform } from '../apps/web/src/bootstrap.js'

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

  /*
   * The previous version of this grepped main.tsx for `data-testid="startup-error"`, which
   * stayed green with the try/catch deleted — the exact blank page it was written to stop.
   * The fence now lives in startPlatform, so the assertion can be about what happens.
   */
  it('hands back the missing-token failure instead of throwing it', () => {
    // Given: the real host route with no token, and factories that would both succeed.
    const create = { mock: () => 'mock' as const, host: () => 'host' as const }

    // When: the runtime is started the way the browser entry starts it.
    const started = startPlatform('', {}, create)

    // Then: the entry gets a value it can render, not a module-level throw.
    expect(started.platform).toBeNull()
    expect(started.error).toBeInstanceOf(MissingHostTokenError)
  })

  it('keeps a failing platform construction renderable too', () => {
    // Given: credentials are fine but building the web platform blows up.
    const create = {
      mock: () => 'mock' as const,
      host: () => {
        throw new Error('WebSocket URL is not valid')
      },
    }

    // When: the runtime is started with a usable token.
    const started = startPlatform('', { VITE_HOST_TOKEN: 'random-launch-token' }, create)

    // Then: the fence covers platform construction, not only the token read.
    expect(started.platform).toBeNull()
    expect(started.error?.message).toBe('WebSocket URL is not valid')
  })

  it('routes mock mode to the host-free platform without reading credentials', () => {
    // Given: the mock URL, and a host factory that fails the test if it is reached.
    const create = {
      mock: () => 'mock' as const,
      host: () => {
        throw new Error('the host factory must not be reached in mock mode')
      },
    }

    // When: the runtime is started.
    const started = startPlatform('?mock=1', {}, create)

    // Then: E2E and demo keep working with no VITE_HOST_TOKEN anywhere.
    expect(started).toEqual({ platform: 'mock', error: null })
  })
})
