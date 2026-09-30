/** Assembling the CSP for an app view (M4 B-3) — only what is declared; the spec's restrictive default when nothing is declared */
import { describe, expect, it } from 'vitest'
import { allowAttribute, approvedPermissions, buildProxyCsp, buildViewCsp, sanitizeDomains } from './csp.js'

/** Policy string → list of values per directive */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe('buildViewCsp', () => {
  it('with nothing declared, network, outside resources and nested frames are all blocked', () => {
    const d = directives(buildViewCsp(undefined).policy)
    expect(d['default-src']).toEqual(["'none'"])
    expect(d['connect-src']).toEqual(["'none'"])
    expect(d['frame-src']).toEqual(["'none'"])
    expect(d['form-action']).toEqual(["'none'"])
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['script-src']).toEqual(["'unsafe-inline'"])
    expect(d['style-src']).toEqual(["'unsafe-inline'"])
    expect(d['img-src']).toEqual(['data:', 'blob:'])
    expect(d['base-uri']).toEqual(["'self'"])
    // Things absent even from the spec's default: 'self' (= the host port) and eval
    const all = Object.values(d).flat()
    expect(all).not.toContain("'unsafe-eval'")
    expect(Object.entries(d).filter(([k, v]) => k !== 'base-uri' && v.includes("'self'"))).toEqual([])
    // An empty declaration counts the same as no declaration
    expect(buildViewCsp({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }).policy).toBe(
      buildViewCsp(undefined).policy,
    )
  })

  it('a declared domain goes into only that directive', () => {
    const { policy, approved, dropped } = buildViewCsp({
      connectDomains: ['https://api.example.com', 'wss://live.example.com'],
      resourceDomains: ['https://cdn.example.com', 'https://*.fonts.example'],
      frameDomains: ['https://www.youtube.com'],
      baseUriDomains: ['https://base.example.com'],
    })
    const d = directives(policy)
    expect(d['connect-src']).toEqual(['https://api.example.com', 'wss://live.example.com'])
    for (const k of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'worker-src']) {
      expect(d[k]).toEqual(expect.arrayContaining(['https://cdn.example.com', 'https://*.fonts.example']))
      expect(d[k]).not.toContain('https://api.example.com')
    }
    expect(d['frame-src']).toEqual(['https://www.youtube.com'])
    expect(d['base-uri']).toEqual(['https://base.example.com'])
    expect(d['connect-src']).not.toContain('https://cdn.example.com')
    expect(dropped).toEqual([])
    expect(approved.connectDomains).toEqual(['https://api.example.com', 'wss://live.example.com'])
  })

  /**
   * A domain declaration only widens domains. Shapes that would change the policy (keywords, an
   * entire scheme, `*`, smuggling in a directive) and the loopback where the host itself lives are
   * not admitted even if declared.
   */
  it.each([
    ['*', 'everything'],
    ['https:', 'a whole scheme'],
    ['data:', 'a whole scheme'],
    ["'unsafe-eval'", 'a keyword'],
    ["'self'", 'a keyword'],
    ['https://a.example; script-src *', 'a directive smuggled in'],
    ['https://a.example https://b.example', 'two sources in one entry'],
    ['https://a.example,https://b.example', 'a list in one entry'],
    ['javascript:alert(1)', 'a scheme that runs code'],
    ['http://*', 'a bare wildcard host'],
    ['http://127.0.0.1:*', 'the host loopback'],
    ['http://127.0.0.1:5175', 'the host loopback'],
    ['http://localhost:3000', 'the loopback name'],
    ['http://app.localhost', 'a loopback subdomain'],
    ['http://[::1]:8080', 'IPv6 loopback'],
    ['http://0.0.0.0:80', 'the any address'],
    ['ftp://files.example.com', 'a scheme views have no use for'],
    ['api.example.com', 'no scheme'],
  ])('%j (%s) is not admitted even if declared', (entry) => {
    for (const key of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const) {
      const { policy, dropped, approved } = buildViewCsp({ [key]: [entry] })
      expect(dropped).toEqual([entry])
      expect(approved[key]).toEqual([])
      expect(policy).toBe(buildViewCsp(undefined).policy)
    }
  })

  it('drops a non-string declaration and a non-array list', () => {
    expect(sanitizeDomains(['https://a.example', 42, null, { x: 1 }])).toEqual({
      kept: ['https://a.example'],
      dropped: ['42', 'null', '{"x":1}'],
    })
    expect(sanitizeDomains('https://a.example')).toEqual({ kept: [], dropped: [] })
    expect(sanitizeDomains(['https://a.example', 'https://a.example']).kept).toEqual(['https://a.example'])
  })
})

describe('buildProxyCsp', () => {
  it("a proxy for a per-app origin opens only its own script hash and that app's origin", () => {
    const d = directives(buildProxyCsp('sha256-abc', 'http://127.0.0.1:23456'))
    expect(d['default-src']).toEqual(["'none'"])
    expect(d['script-src']).toEqual(["'sha256-abc'"])
    expect(d['frame-src']).toEqual(['http://127.0.0.1:23456'])
  })
})

describe('allowAttribute', () => {
  it('passes through only the declared features, under the same names as ext-apps', () => {
    expect(allowAttribute(undefined)).toBe('')
    expect(allowAttribute({})).toBe('')
    expect(allowAttribute({ camera: {}, clipboardWrite: {} })).toBe('camera; clipboard-write')
    expect(allowAttribute({ microphone: {}, geolocation: {} } as never)).toBe('microphone; geolocation')
    // Does not pass through an unknown feature
    expect(allowAttribute({ usb: {}, 'display-capture': {} } as never)).toBe('')
    expect(approvedPermissions({ camera: {}, usb: {} } as never)).toEqual({ camera: {} })
  })
})
