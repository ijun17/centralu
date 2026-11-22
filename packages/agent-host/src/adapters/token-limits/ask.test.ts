import { describe, expect, it } from 'vitest'
import { askFixed } from './ask.js'
import { failureOf } from './failure.test-helpers.js'

const TOKEN = 'header.payload-that-is-secret.signature'
const URL_ = 'https://limits.example/usage'

function answering(status: number, body: string, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {} })
    return new Response(body, { status })
  }
}

const ask = (fetchFn: typeof fetch) => askFixed('usage', URL_, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } }, fetchFn)

describe("one request with a person's token to a fixed address (#2459, #2462)", () => {
  it('sends the headers to that address only, refusing redirects, and answers the JSON', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    await expect(ask(answering(200, '{"a":1}', calls))).resolves.toEqual({ a: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(URL_)
    expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reads each status as its kind: 2xx answered, 401 signed out, other 4xx and 3xx refused, 5xx unreachable', async () => {
    await expect(ask(answering(299, '{}'))).resolves.toEqual({})
    const kinds: [number, string][] = [
      [401, 'signed-out'],
      [300, 'refused'],
      [400, 'refused'],
      [403, 'refused'],
      [404, 'refused'],
      [499, 'refused'],
      [500, 'unreachable'],
      [503, 'unreachable'],
    ]
    for (const [status, kind] of kinds) {
      const f = await failureOf(ask(answering(status, '{"code":"x"}')))
      expect([status, f.kind]).toEqual([status, kind])
      expect(f.detail).toBe(`usage: HTTP ${status}`)
    }
  })

  it('says unreachable when the request fails or times out, unreadable when a 200 is not JSON', async () => {
    const timeout: typeof fetch = async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    expect(await failureOf(ask(timeout))).toMatchObject({ kind: 'unreachable', detail: 'usage: TimeoutError' })
    const offline: typeof fetch = async () => Promise.reject(new TypeError('fetch failed'))
    expect(await failureOf(ask(offline))).toMatchObject({ kind: 'unreachable', detail: 'usage: TypeError' })
    expect(await failureOf(ask(answering(200, '<html>')))).toMatchObject({ kind: 'unreadable', detail: 'usage: not JSON' })
  })

  it('never puts the token in a failure', async () => {
    const leaky: typeof fetch = async () => Promise.reject(new Error(`bad header ${TOKEN}`))
    for (const f of [await failureOf(ask(leaky)), await failureOf(ask(answering(403, TOKEN)))]) {
      expect(`${f.message} ${f.detail}`).not.toContain('secret')
    }
  })
})
