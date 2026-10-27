/**
 * What the gate hook (`agy-gate.mjs`) does, as functions the tests can drive: the hook is a plain file `agy` runs, so this
 * holds no state and imports nothing (docs/plans/antigravity-adapter.md §5).
 *
 * **No decision is made here.** The call goes to Centralu and Centralu's answer comes back. The preset, the person's
 * rules and the card are the host's (`gate.ts`); copying any of that here would let the two drift apart.
 *
 * **It always answers, and fails closed.** `agy` runs the tool when a hook prints nothing and exits 0 (measured, §5.4),
 * so every path ends in one printed decision: `allow` only on a clear allow from Centralu, `deny` on anything else (no
 * address, a refused credential, the gate unreachable past a short retry across a host swap, an answer that is not JSON,
 * a decision it does not know, an error of its own). Never `ask` or `force_ask`: print mode cannot ask anyone.
 *
 * It uses Node's global `fetch`, and touches no file, path or process (docs/plans/os-layer.md). `fetch` gives up on an
 * answer whose headers, or next piece of body, take over 300 s, and a person may take longer over a card: the gate's
 * end sends its headers at once and a space every so often until it decides (JSON reads leading spaces as nothing):
 * the front door's gate route, `transport/gate-door.ts`. The address and key come from the environment (`CC_GATE_URL`,
 * `CC_GATE_TOKEN`, the names `GATE_ENV` in `adapters/core/gate.ts` gives); a redirect is refused (`redirect: 'error'`),
 * so the key is never sent anywhere but the address the session gave.
 */

/**
 * The longest a string argument is sent whole (in UTF-16 code units, as JavaScript counts a string). A longer one, the
 * content of a large file being written, say, is cut to its head and a marker (`cutLongArguments`), so a call's request
 * stays far under the host's cap (1 MiB) whatever the file's size: the gate decides on paths, commands and kinds, never
 * on a whole file's content
 */
export const ARGUMENT_BOUND = 64 * 1024

/** Errors that mean the request never reached anyone (nothing listens there yet: a host swap), so it is safe to send again */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND'])

/**
 * The decision for one hook call. Never throws: every outcome is an answer.
 * @param {{ env: Record<string, string | undefined>, input: string, fetch: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number }} io
 * @returns {Promise<{ decision: 'allow' } | { decision: 'deny', reason: string }>}
 */
export async function gateAnswer(io) {
  try {
    return await decide(io)
  } catch (e) {
    return deny(`Centralu could not check this call (${errorCode(e)}), so it was not run.`)
  }
}

/**
 * The hook command's whole run: read the call, print one answer. Never throws, and prints exactly one line.
 * @param {{ stdin: AsyncIterable<Uint8Array | string>, write: (line: string) => void } & Omit<Parameters<typeof gateAnswer>[0], 'input'>} io
 */
export async function runHook({ stdin, write, ...io }) {
  let answer
  try {
    const decoder = new TextDecoder()
    let input = ''
    for await (const c of stdin) input += typeof c === 'string' ? c : decoder.decode(c, { stream: true })
    answer = await gateAnswer({ ...io, input: input + decoder.decode() })
  } catch {
    answer = deny('Centralu could not read this call, so it was not run.')
  }
  write(`${JSON.stringify(answer)}\n`)
}

/** @param {string} reason */
const deny = (reason) => /** @type {const} */ ({ decision: 'deny', reason })

/**
 * The error's code only: its message goes to the model and can carry the address or a header
 * @param {unknown} e
 */
function errorCode(e) {
  const err = /** @type {{ cause?: { code?: unknown }, code?: unknown } | null} */ (e)
  const code = err?.cause?.code ?? err?.code
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'an error'
}

/** @param {Parameters<typeof gateAnswer>[0]} io */
async function decide({ env, input, fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const url = env.CC_GATE_URL
  const token = env.CC_GATE_TOKEN
  if (!url || !token) return deny('Centralu could not check this call: its approval gate is not set up for this session.')
  const body = await cutLongArguments(input)
  const retryMs = Number(env.CC_GATE_RETRY_MS) || 3000
  const until = now() + retryMs
  let res
  for (;;) {
    try {
      res = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body })
      break
    } catch (e) {
      // Only a request that never left is sent again: one the gate may have read could raise its card twice
      if (!NOT_SENT.has(errorCode(e)) || now() >= until) throw e
      await sleep(250)
    }
  }
  if (res.status === 413) return deny('Centralu could not check this call: it is too large to check (over 1 MiB), so it was not run.')
  if (res.status !== 200) return deny(`Centralu refused to check this call (status ${res.status}), so it was not run.`)
  let answer
  try {
    answer = JSON.parse(await res.text())
  } catch {
    return deny('Centralu gave an answer this gate could not read, so the call was not run.')
  }
  if (answer?.decision === 'allow') return /** @type {const} */ ({ decision: 'allow' })
  return deny(typeof answer?.reason === 'string' && answer.reason ? answer.reason : 'Centralu did not allow this call.')
}

/**
 * The hook's input with every string longer than `ARGUMENT_BOUND` cut to its head and a marker naming how many bytes
 * were cut and the SHA-256 of the whole string. The digest keeps a cut argument's identity: two commands that share
 * their first `ARGUMENT_BOUND` characters still read differently, so a rule the person saved for one ("always allow"
 * matches the exact text) never matches the other. Input with nothing to cut, or that is not JSON, is sent as it came.
 * Uses the global Web Crypto, so this file still imports nothing.
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function cutLongArguments(input) {
  let value
  try {
    value = JSON.parse(input)
  } catch {
    return input
  }
  let cut = false
  const encoder = new TextEncoder()
  /** @param {unknown} v @returns {Promise<unknown>} */
  const walk = async (v) => {
    if (typeof v === 'string') {
      if (v.length <= ARGUMENT_BOUND) return v
      cut = true
      let head = v.slice(0, ARGUMENT_BOUND)
      // Never half a surrogate pair at the cut
      const last = head.charCodeAt(head.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
      const whole = encoder.encode(v)
      const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', whole))].map((b) => b.toString(16).padStart(2, '0')).join('')
      return `${head}
[Centralu cut ${whole.length - encoder.encode(head).length} bytes of this argument before asking; SHA-256 of the whole: ${digest}]`
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk))
    // Own entries rebuilt with fromEntries, so a key named __proto__ stays a plain key
    if (v !== null && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await walk(x)])))
    return v
  }
  const out = await walk(value)
  return cut ? JSON.stringify(out) : input
}
