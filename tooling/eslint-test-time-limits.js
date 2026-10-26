/**
 * `test-limits/scaled-by-slow`: every time limit a test sets for itself is scaled for Windows (#845, #1602).
 *
 * vitest.config.ts multiplies its default limits by `SLOW` (three on Windows, #368). A limit given to one
 * test or hook replaces that default, so it used to keep its macOS value on Windows CI: `lazy-resume`,
 * `start-agent`, `versions`, `git-pr` and others set 10–30 s and ran out there while the rest of the suite
 * had three times the room. This reports every limit passed to `it`/`test`/`describe` or a hook
 * (`it(name, fn, 30_000)`, `{ timeout: 10_000 }`), set for a whole file (`vi.setConfig({ testTimeout: 30_000 })`),
 * or given to a wait (`vi.waitFor(fn, { timeout: 3_000 })`, `vi.waitUntil(fn, 3_000)`,
 * `expect.poll(fn, { timeout })`), that does not multiply by `SLOW`. A wait's limit is not scaled by anything
 * else: vitest's own default for one is a fixed second. A name holding the limit is followed to what it was given
 * (`const LIMIT = 30_000 * SLOW` is scaled; `const LIMIT = 30_000` is reported where it is used).
 *
 * Gaps, known: options spread into the call (`it(name, fn, { ...opts })`), runners made by `test.extend`, a tagged
 * `it.each` table, and a limit set by `vi.setConfig(opts)` from a variable.
 *
 * There is no way around it in the file: `pnpm lint` refuses an eslint-disable of this rule
 * (tooling/lint-allowlist.ts, `NO_DISABLE_RULES`). A real exception is a line of `EXCEPTIONS` below with its
 * reason; the list only shrinks (tooling/test-time-limits-checks.test.ts holds its ceiling).
 *
 * This was a unit test that parsed every test file (687) with the TypeScript API (#1602); ESLint parses each
 * once per run and caches it.
 */

import { constInit } from './eslint-const-init.js'

/** Files that may set an unscaled limit, by repository-relative path, each with the reason. Empty; it only shrinks. */
export const EXCEPTIONS = {}

const RUNNERS = new Set(['it', 'test', 'describe', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach'])
/** What `vi.setConfig` takes that is a time limit */
const CONFIG_LIMITS = new Set(['testTimeout', 'hookTimeout'])
/** The calls that wait for something and take a limit as their second argument */
const WAITS = new Set(['vi.waitFor', 'vi.waitUntil', 'vitest.waitFor', 'vitest.waitUntil', 'expect.poll'])

/** The name of a property key: `timeout`, `'timeout'`; null for a computed one */
function keyName(p) {
  if (p.computed) return null
  return p.key.type === 'Identifier' ? p.key.name : typeof p.key.value === 'string' ? p.key.value : null
}

/** `obj.name` where obj is a plain identifier, as text; null otherwise */
function dotted(callee) {
  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier') return null
  return `${callee.object.name}.${callee.property.name}`
}

/** The runner a call goes back to: `it`, `it.skip`, `it.each([...])`, `test.skipIf(x)` */
function runnerOf(callee) {
  let e = callee
  for (;;) {
    if (e.type === 'Identifier') return e.name
    if (e.type === 'MemberExpression') e = e.object
    else if (e.type === 'CallExpression') e = e.callee
    else return null
  }
}

/** The values of the properties of an object literal that are named in `names` */
function limitsOf(object, names) {
  return object.properties.filter((p) => p.type === 'Property' && names.has(keyName(p))).map((p) => p.value)
}

export const scaledBySlow = {
  meta: {
    type: 'problem',
    docs: { description: 'a time limit a test sets for itself is multiplied by SLOW (tooling/test-timing.ts)' },
    messages: {
      unscaled: "a time limit a test sets for itself is multiplied by SLOW, as vitest's defaults are (`{{text}}` → `{{text}} * SLOW`; tooling/test-timing.ts, #845)",
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode
    const relative = context.filename.slice(context.cwd.length + 1).replaceAll('\\', '/')
    if (Object.hasOwn(EXCEPTIONS, relative)) return {}
    /** Does the limit multiply by SLOW, itself or through the `const` that holds it? */
    const scaled = (node, depth = 0) => {
      if (/\bSLOW\b/.test(source.getText(node))) return true
      if (node.type !== 'Identifier' || depth > 5) return false
      const found = constInit(source, node)
      return !!found && !found.pattern && scaled(found.init, depth + 1)
    }
    const check = (limit) => {
      if (!scaled(limit)) context.report({ node: limit, messageId: 'unscaled', data: { text: source.getText(limit) } })
    }
    return {
      CallExpression(node) {
        const name = dotted(node.callee)
        if (name === 'vi.setConfig' || name === 'vitest.setConfig') {
          for (const a of node.arguments) if (a.type === 'ObjectExpression') limitsOf(a, CONFIG_LIMITS).forEach(check)
        }
        if (name && WAITS.has(name)) {
          const limit = node.arguments[1]
          if (limit?.type === 'ObjectExpression') limitsOf(limit, new Set(['timeout'])).forEach(check)
          else if (limit) check(limit)
        }
        if (RUNNERS.has(runnerOf(node.callee) ?? '')) {
          const args = node.arguments
          const fn = args.findIndex((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression')
          if (fn < 0) return
          args.forEach((a, i) => {
            if (i > fn && a.type !== 'ObjectExpression') check(a)
            if (i !== fn && a.type === 'ObjectExpression') limitsOf(a, new Set(['timeout'])).forEach(check)
          })
        }
      },
    }
  },
}

export default { rules: { 'scaled-by-slow': scaledBySlow } }
