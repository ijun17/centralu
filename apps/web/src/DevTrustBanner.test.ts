import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askToTrust, untrustedLimited } from './DevTrustBanner.js'
import { devTabKey } from './dev-tab-key.js'

/** The dev browser tab's banner (docs/security-boundaries/dev-browser-tabs.md): the steps that ask for the trust and keep its key */
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
})
afterEach(() => vi.unstubAllGlobals())

const tab = (answers: Record<string, unknown>, state: { rights?: 'full' | 'limited'; trustedDev?: boolean } = {}) => {
  const calls: { method: string; params: unknown }[] = []
  return {
    calls,
    rpc: {
      connectionState: 'connected' as const,
      rights: state.rights ?? ('limited' as const),
      trustedDev: state.trustedDev ?? false,
      call: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return answers[method]
      },
    } as unknown as Parameters<typeof askToTrust>[0],
  }
}

describe("the dev tab's trust", () => {
  it('shows the host’s code, asks with that code, and keeps the key an Allow answers', async () => {
    const t = tab({ 'host.devTabCode': { code: 'K7M-4P2' }, 'host.trustDevTab': { ok: true, key: 'k'.repeat(43), expiresAt: 1 } })
    const shown: string[] = []
    await askToTrust(t.rpc, (c) => shown.push(c))
    expect(shown).toEqual(['K7M-4P2'])
    expect(t.calls).toEqual([{ method: 'host.devTabCode', params: {} }, { method: 'host.trustDevTab', params: { code: 'K7M-4P2' } }])
    expect(devTabKey.read()).toBe('k'.repeat(43))
  })

  it('keeps no key for an answer to an earlier connection', async () => {
    const t = tab({ 'host.devTabCode': { code: 'K7M-4P2' }, 'host.trustDevTab': { ok: true, key: 'k'.repeat(43), expiresAt: 1 } })
    let live = true
    await askToTrust(t.rpc, () => (live = false), () => live)
    expect(devTabKey.read()).toBeNull()
  })

  it('forgets a kept key only on a limited connection the host does not trust', () => {
    expect(untrustedLimited(tab({}).rpc)).toBe(true)
    expect(untrustedLimited(tab({}, { trustedDev: true }).rpc)).toBe(false)
    expect(untrustedLimited(tab({}, { rights: 'full' }).rpc)).toBe(false)
  })
})
