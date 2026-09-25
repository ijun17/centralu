/** 앱 화면의 CSP 조립 (M4 B-3) — 선언한 곳만, 선언이 없으면 규격의 제한 기본값 */
import { describe, expect, it } from 'vitest'
import { allowAttribute, approvedPermissions, buildProxyCsp, buildViewCsp, sanitizeDomains } from './csp.js'

/** 정책 문자열 → 지시문별 값 목록 */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe('buildViewCsp', () => {
  it('선언이 없으면 네트워크·바깥 리소스·중첩 프레임이 모두 막힌다', () => {
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
    // 규격 기본값에도 없는 것들: 'self'(= host 포트)와 eval
    const all = Object.values(d).flat()
    expect(all).not.toContain("'unsafe-eval'")
    expect(Object.entries(d).filter(([k, v]) => k !== 'base-uri' && v.includes("'self'"))).toEqual([])
    // 빈 선언도 선언이 없는 것과 같다
    expect(buildViewCsp({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }).policy).toBe(
      buildViewCsp(undefined).policy,
    )
  })

  it('선언한 도메인은 그 지시문에만 들어간다', () => {
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
   * 도메인 선언은 도메인만 넓힌다. 정책을 바꾸는 모양(키워드, 체계 전체, `*`, 지시문 끼워 넣기)과
   * host가 사는 루프백은 선언해도 들어가지 않는다.
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
  ])('%j (%s)는 선언해도 들어가지 않는다', (entry) => {
    for (const key of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const) {
      const { policy, dropped, approved } = buildViewCsp({ [key]: [entry] })
      expect(dropped).toEqual([entry])
      expect(approved[key]).toEqual([])
      expect(policy).toBe(buildViewCsp(undefined).policy)
    }
  })

  it('문자열이 아닌 선언과 배열이 아닌 목록은 버린다', () => {
    expect(sanitizeDomains(['https://a.example', 42, null, { x: 1 }])).toEqual({
      kept: ['https://a.example'],
      dropped: ['42', 'null', '{"x":1}'],
    })
    expect(sanitizeDomains('https://a.example')).toEqual({ kept: [], dropped: [] })
    expect(sanitizeDomains(['https://a.example', 'https://a.example']).kept).toEqual(['https://a.example'])
  })
})

describe('buildProxyCsp', () => {
  it('앱별 출처의 프록시는 자기 스크립트 해시와 그 앱의 출처만 연다', () => {
    const d = directives(buildProxyCsp('sha256-abc', 'http://127.0.0.1:23456'))
    expect(d['default-src']).toEqual(["'none'"])
    expect(d['script-src']).toEqual(["'sha256-abc'"])
    expect(d['frame-src']).toEqual(['http://127.0.0.1:23456'])
  })
})

describe('allowAttribute', () => {
  it('선언한 기능만 ext-apps와 같은 이름으로 넘긴다', () => {
    expect(allowAttribute(undefined)).toBe('')
    expect(allowAttribute({})).toBe('')
    expect(allowAttribute({ camera: {}, clipboardWrite: {} })).toBe('camera; clipboard-write')
    expect(allowAttribute({ microphone: {}, geolocation: {} } as never)).toBe('microphone; geolocation')
    // 모르는 기능은 넘기지 않는다
    expect(allowAttribute({ usb: {}, 'display-capture': {} } as never)).toBe('')
    expect(approvedPermissions({ camera: {}, usb: {} } as never)).toEqual({ camera: {} })
  })
})
