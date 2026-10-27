import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { ARGUMENT_BOUND, CUT_MARKER, CUTTABLE, cutLongArguments, cutOutsideContent, gateAnswer, runHook } from './gate-answer.mjs'

/**
 * The gate hook `agy` runs before every tool call (docs/plans/antigravity-adapter.md §5). Measured on agy 1.4.7: a hook
 * that prints nothing and exits 0 lets the call run, so the script must have a decision for every outcome, and `allow`
 * only for a clear allow from Centralu. The script's whole path from a call to its answer runs here against a fake
 * `fetch`; the recordings (`recordings/agy-1.4.*`) show the real script run by the real `agy`.
 */

const INPUT = JSON.stringify({ conversationId: 'conv-1', stepIdx: 2, toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } })
const ENV = { CC_GATE_URL: 'http://127.0.0.1:1/gate', CC_GATE_TOKEN: 'tok' }

type Call = { url: string; init: RequestInit }
const reply = (status: number, body: string) => () => Promise.resolve(new Response(body, { status }))
const refused = () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }))

function run(answer: (call: Call) => Promise<Response>, env: Record<string, string | undefined> = ENV) {
  const calls: Call[] = []
  let clock = 0
  const fetch: typeof globalThis.fetch = (url, init = {}) => {
    const call = { url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init }
    calls.push(call)
    return answer(call)
  }
  const sleep = (ms: number) => ((clock += ms), Promise.resolve())
  return { calls, result: gateAnswer({ env, input: INPUT, fetch, sleep, now: () => clock }) }
}

describe('the gate hook’s answer (gate-answer.mjs)', () => {
  it('passes the call as it came, with the session’s credential, and answers allow on a clear allow', async () => {
    const { calls, result } = run(reply(200, JSON.stringify({ decision: 'allow' })))
    expect(await result).toEqual({ decision: 'allow' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(ENV.CC_GATE_URL)
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: INPUT, headers: { authorization: 'Bearer tok' } })
  })

  it('reads an answer that came after the spaces the gate sends while the person decides', async () => {
    expect(await run(reply(200, `   \n  ${JSON.stringify({ decision: 'allow' })}`)).result).toEqual({ decision: 'allow' })
  })

  it('answers deny with Centralu’s reason when Centralu denies', async () => {
    expect(await run(reply(200, JSON.stringify({ decision: 'deny', reason: 'The person declined.' }))).result).toEqual({ decision: 'deny', reason: 'The person declined.' })
  })

  const unclear: [string, (call: Call) => Promise<Response>][] = [
    ['a decision other than allow (ask)', reply(200, JSON.stringify({ decision: 'ask' }))],
    ['an answer with no decision', reply(200, '{}')],
    ['an answer that is JSON but not an object', reply(200, 'null')],
    ['an answer that is not JSON', reply(200, 'not json')],
    ['an empty answer', reply(200, '')],
    ['a refused credential, even with allow in the body', reply(401, JSON.stringify({ decision: 'allow' }))],
    ['a server error', reply(500, '')],
    ['the connection dropped while the person decided', () => Promise.resolve(new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }), { status: 200 }))],
    ['an error that is not about reaching the gate', () => Promise.reject(new Error('something else'))],
    ['a connection reset after the request may have arrived', () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }))],
    ['a fetch that throws at once', () => {
      throw new Error('boom')
    }],
  ]
  for (const [what, answer] of unclear) {
    it(`answers deny with a reason on ${what}, asking once`, async () => {
      const { calls, result } = run(answer)
      const out = await result
      expect(out.decision).toBe('deny')
      expect(out).toHaveProperty('reason', expect.stringMatching(/\S/))
      // Only a request that never left is sent again: a second one could raise the card twice
      expect(calls).toHaveLength(1)
    })
  }

  it('tries an unreachable gate again for its retry window, then denies', async () => {
    const { calls, result } = run(refused, { ...ENV, CC_GATE_RETRY_MS: '1000' })
    expect(await result).toMatchObject({ decision: 'deny', reason: expect.stringContaining('ECONNREFUSED') })
    expect(calls.length).toBe(5)
  })

  it('reaches a gate that comes back within the retry window (a host swap)', async () => {
    let n = 0
    const { calls, result } = run(() => (++n < 3 ? refused() : reply(200, JSON.stringify({ decision: 'allow' }))()))
    expect(await result).toEqual({ decision: 'allow' })
    expect(calls).toHaveLength(3)
  })

  for (const [what, env] of [
    ['no address', { CC_GATE_TOKEN: 'tok' }],
    ['no credential', { CC_GATE_URL: ENV.CC_GATE_URL }],
  ] as const) {
    it(`answers deny, asking no one, when the session gave it ${what}`, async () => {
      const { calls, result } = run(reply(200, JSON.stringify({ decision: 'allow' })), env)
      expect((await result).decision).toBe('deny')
      expect(calls).toHaveLength(0)
    })
  }

  it('follows no redirect: the key goes nowhere but the session’s address, and an allow from elsewhere is not taken', async () => {
    // A gate address that redirects, with fetch's own rule: `redirect: 'error'` rejects, anything else follows
    const elsewhere: Call[] = []
    const { result } = run((call) => {
      if (call.init.redirect === 'error') return Promise.reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))
      elsewhere.push(call)
      return reply(200, JSON.stringify({ decision: 'allow' }))()
    })
    expect((await result).decision).toBe('deny')
    expect(elsewhere).toEqual([])
  })

  it('keeps the address and credential out of what the model is told', async () => {
    const leak = new TypeError(`bad header value Bearer tok for ${ENV.CC_GATE_URL}`)
    const out = await run(() => Promise.reject(leak)).result
    expect(JSON.stringify(out)).not.toMatch(/tok|127\.0\.0\.1/)
  })
})

describe('long arguments (cutLongArguments)', () => {
  const call = (args: Record<string, unknown>) => JSON.stringify({ conversationId: 'c', stepIdx: 1, toolCall: { name: 'write_file', args } })

  it('cuts a string past the bound to its head and a marker with the bytes cut and the whole one’s SHA-256', async () => {
    const content = `${'a'.repeat(ARGUMENT_BOUND)}${'b'.repeat(3 * 1024 * 1024)}`
    const out = JSON.parse(await cutLongArguments(call({ Path: '/w/f', Content: content }))) as { toolCall: { args: { Path: string; Content: string } } }
    const digest = createHash('sha256').update(content).digest('hex')
    expect(out.toolCall.args.Path).toBe('/w/f')
    expect(out.toolCall.args.Content).toBe(`${'a'.repeat(ARGUMENT_BOUND)}
[Centralu cut ${3 * 1024 * 1024} bytes of this argument before asking; SHA-256 of the whole: ${digest}]`)
  })

  it('sends what has nothing to cut, or is not JSON, exactly as it came', async () => {
    const small = `{ "toolCall": {"args": {"Content": "${'x'.repeat(ARGUMENT_BOUND)}"}} }`
    expect(await cutLongArguments(small)).toBe(small)
    expect(await cutLongArguments('not json')).toBe('not json')
  })

  it('keeps two long writes with the same head apart, so a cut one never reads as another', async () => {
    const head = 'x'.repeat(ARGUMENT_BOUND + 10)
    expect(await cutLongArguments(call({ Path: '/w/f', Content: `${head}1` }))).not.toBe(await cutLongArguments(call({ Path: '/w/f', Content: `${head}2` })))
  })

  it('never cuts what a decision reads: a command, a path, a URL, a Cwd, an MCP tool’s arguments, any argument of another tool', async () => {
    const padded = `${'#'.repeat(ARGUMENT_BOUND + 10)}
rm -rf ~`
    const inputs = [
      JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: padded, Cwd: padded } } }),
      JSON.stringify({ toolCall: { name: 'call_mcp_tool', args: { ServerName: 's', ToolName: 't', Arguments: { q: padded } } } }),
      JSON.stringify({ toolCall: { name: 'read_url_content', args: { Url: padded } } }),
      JSON.stringify({ toolCall: { name: 'run_command', args: { Content: padded } } }),
      call({ Path: padded, TargetFile: padded, Content: 'small' }),
      JSON.stringify({ toolCall: { name: 'write_file', args: { Path: '/w/f' } }, workspacePaths: [padded] }),
    ]
    for (const input of inputs) expect(await cutLongArguments(input)).toBe(input)
  })

  it('cuts inside an edit’s chunks, and only there among its arguments', async () => {
    const long = 'z'.repeat(ARGUMENT_BOUND + 10)
    const input = JSON.stringify({ toolCall: { name: 'multi_replace_file_content', args: { TargetFile: '/w/f', Instruction: long, ReplacementChunks: [{ TargetContent: long, ReplacementContent: 'b' }] } } })
    const out = JSON.parse(await cutLongArguments(input)) as { toolCall: { args: { Instruction: string; ReplacementChunks: { TargetContent: string }[] } } }
    expect(out.toolCall.args.Instruction).toBe(long)
    expect(out.toolCall.args.ReplacementChunks[0]?.TargetContent.includes(CUT_MARKER)).toBe(true)
    expect(cutOutsideContent(out)).toBe(false)
  })

  it('never splits a character in two at the cut, and keeps a key named __proto__ a plain key', async () => {
    const emoji = `${'a'.repeat(ARGUMENT_BOUND - 1)}😀${'b'.repeat(10)}`
    const out = JSON.parse(await cutLongArguments(`{"__proto__": {"x": 1}, "toolCall": {"name": "write_file", "args": {"__proto__": {"y": 2}, "Content": ${JSON.stringify(emoji)}}}}`)) as {
      toolCall: { args: Record<string, unknown> }
    }
    expect(Object.keys(out)).toEqual(['__proto__', 'toolCall'])
    expect(Object.keys(out.toolCall.args)).toEqual(['__proto__', 'Content'])
    expect(String(out.toolCall.args.Content).startsWith(`${'a'.repeat(ARGUMENT_BOUND - 1)}
[Centralu cut`)).toBe(true)
  })

  it('finds a cut outside a file’s content, which the host then denies undecided (cutOutsideContent)', async () => {
    const marked = `ls
${CUT_MARKER}9 bytes of this argument before asking; SHA-256 of the whole: 00]`
    expect(cutOutsideContent({ toolCall: { name: 'run_command', args: { CommandLine: marked } } })).toBe(true)
    expect(cutOutsideContent({ toolCall: { name: 'write_file', args: { Path: marked, Content: 'x' } } })).toBe(true)
    expect(cutOutsideContent({ toolCall: { name: 'run_command', args: { Content: marked } } })).toBe(true)
    expect(cutOutsideContent({ toolCall: { name: marked, args: {} } })).toBe(true)
    expect(cutOutsideContent({ toolCall: { name: 'write_file', args: { Path: '/w/f' } }, workspacePaths: [marked] })).toBe(true)
    expect(cutOutsideContent([marked])).toBe(true)
    expect(cutOutsideContent({ toolCall: { name: 'write_file', args: [marked] } })).toBe(true)
    expect(cutOutsideContent({ toolCall: { name: 'write_file', args: { Path: '/w/f', Content: marked } } })).toBe(false)
    expect(cutOutsideContent(JSON.parse(await cutLongArguments(call({ Path: '/w/f', Content: 'c'.repeat(ARGUMENT_BOUND + 1) }))))).toBe(false)
    // Every tool and argument that may be cut is one the gate decides on by its path alone
    expect(CUTTABLE.args).not.toContain('Path')
  })

  it('is what the hook sends', async () => {
    let sent = ''
    const fetch: typeof globalThis.fetch = (_u, init) => ((sent = typeof init?.body === 'string' ? init.body : ''), Promise.resolve(new Response('{"decision":"allow"}')))
    await gateAnswer({ env: ENV, input: call({ Path: '/w/f', Content: 'q'.repeat(2 * 1024 * 1024) }), fetch })
    expect(sent.length).toBeLessThan(ARGUMENT_BOUND + 1024)
  })

  it('says a call was too large to check when the gate answers 413', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.resolve(new Response('too large', { status: 413 }))
    expect(await gateAnswer({ env: ENV, input: '{}', fetch })).toEqual({ decision: 'deny', reason: 'Centralu could not check this call: it is too large to check (over 1 MiB), so it was not run.' })
  })
})

describe('the gate hook’s run (runHook)', () => {
  async function hook(stdin: AsyncIterable<Uint8Array | string>, fetch: typeof globalThis.fetch, env: Record<string, string | undefined> = ENV) {
    const lines: string[] = []
    await runHook({ stdin, env, fetch, write: (l) => lines.push(l), sleep: () => Promise.resolve() })
    return lines
  }
  const chunks = async function* (...parts: (string | Uint8Array)[]) {
    for (const p of parts) yield await Promise.resolve(p)
  }
  const allow: typeof globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ decision: 'allow' })))

  it('prints exactly one line, the answer, for the call read whole from stdin', async () => {
    let body: unknown
    const fetch: typeof globalThis.fetch = (_u, init) => ((body = init?.body), allow(''))
    const bytes = new TextEncoder().encode(INPUT)
    // A multi-byte character split across two chunks still reads whole
    const split = new TextEncoder().encode('é')
    expect(await hook(chunks(bytes.slice(0, 10), bytes.slice(10, -2), split.slice(0, 1), split.slice(1), bytes.slice(-2)), fetch)).toEqual(['{"decision":"allow"}\n'])
    expect(body).toBe(`${INPUT.slice(0, -2)}é${INPUT.slice(-2)}`)
  })

  it('prints deny when stdin fails, never nothing', async () => {
    const broken = (async function* () {
      yield await Promise.reject(new Error('EPIPE'))
    })()
    const lines = await hook(broken, allow)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ decision: 'deny' })
  })

  it('prints deny when the session gave it no gate', async () => {
    const lines = await hook(chunks(INPUT), allow, {})
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([expect.objectContaining({ decision: 'deny' })])
  })
})
