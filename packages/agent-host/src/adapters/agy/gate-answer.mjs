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
 * The longest a file's content is sent whole (in UTF-16 code units, as JavaScript counts a string). Longer content of a
 * file being written or edited is cut to its head and a marker (`cutLongArguments`), so the call is still asked whatever
 * the file's size. Only what no decision reads is ever cut (`CUTTABLE`)
 */
export const ARGUMENT_BOUND = 64 * 1024

/**
 * What may be cut: the content arguments of the tools that write the text they are given. The gate decides on their
 * paths alone (the deny rules, the plugin root, an `edits` grant, a file's "always" rule, which is the path), so cutting
 * their content never makes a decision less strict. Nothing else is cut, whatever its size: a command, a path, a URL, a
 * `Cwd`, an MCP tool's arguments are read whole by the deny rules and the "always" rules, and a call whose arguments
 * alone are over the gate's cap is refused (413) and denied as too large to check. The host checks a marker is only
 * ever here (`transport/gate-door.ts`), so a hook of another version cannot get a cut command decided on its head
 */
export const CUTTABLE = /** @type {const} */ ({
  tools: ['write_to_file', 'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content'],
  args: ['Content', 'CodeContent', 'TargetContent', 'ReplacementContent', 'Target', 'Replacement', 'ReplacementChunks'],
})

/** The marker's start, as the host looks for it */
export const CUT_MARKER = '[Centralu cut '

/**
 * Whether a string carrying the cut marker sits anywhere but a cuttable argument of a cuttable tool: the host then denies
 * the call without deciding, since a decision would read the cut part. A marker in file content is left alone
 * @param {unknown} hookInput the hook's input as parsed JSON
 * @returns {boolean}
 */
export function cutOutsideContent(hookInput) {
  /** @param {unknown} v @param {boolean} content @returns {boolean} */
  const found = (v, content) => {
    if (typeof v === 'string') return !content && v.includes(CUT_MARKER)
    if (Array.isArray(v)) return v.some((x) => found(x, content))
    if (v !== null && typeof v === 'object') return Object.values(v).some((x) => found(x, content))
    return false
  }
  if (hookInput === null || typeof hookInput !== 'object' || Array.isArray(hookInput)) return found(hookInput, false)
  const { toolCall, ...rest } = /** @type {Record<string, unknown>} */ (hookInput)
  if (found(rest, false)) return true
  if (toolCall === null || typeof toolCall !== 'object' || Array.isArray(toolCall)) return found(toolCall, false)
  const { args, ...call } = /** @type {Record<string, unknown>} */ (toolCall)
  if (found(call, false)) return true
  const name = typeof call.name === 'string' ? call.name : ''
  if (!(/** @type {readonly string[]} */ (CUTTABLE.tools).includes(name)) || args === null || typeof args !== 'object' || Array.isArray(args)) return found(args, false)
  return Object.entries(args).some(([k, x]) => found(x, /** @type {readonly string[]} */ (CUTTABLE.args).includes(k)))
}

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
 * The hook's input with each string in a cuttable argument (`CUTTABLE`) longer than `ARGUMENT_BOUND` cut to its head and
 * a marker naming how many bytes were cut and the SHA-256 of the whole string, so two writes that share a head still
 * read differently. Any other argument is sent whole. Input with nothing to cut, or that is not JSON, is sent as it came.
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
  const call = value?.toolCall
  const args = call?.args
  const cuttable = /** @type {readonly unknown[]} */ (CUTTABLE.tools).includes(call?.name) && args !== null && typeof args === 'object' && !Array.isArray(args)
  if (!cuttable) return input
  // Own entries rebuilt with fromEntries, so a key named __proto__ stays a plain key
  const cutArgs = Object.fromEntries(
    await Promise.all(Object.entries(args).map(async ([k, x]) => [k, /** @type {readonly string[]} */ (CUTTABLE.args).includes(k) ? await walk(x) : x])),
  )
  return cut ? JSON.stringify({ ...value, toolCall: { ...call, args: cutArgs } }) : input
}
