/**
 * `test-env/data-dir`: a test file never writes `process.env.CC_DATA_DIR` by hand (#845, #1602).
 *
 * Each test file runs against a fresh data folder (`vitest.config.ts`, tooling/vitest-data-dir.test.ts). A
 * test that needs another one stubs it (`vi.stubEnv`), which vitest undoes before the next test
 * (`unstubEnvs`). Writing it by hand is what went wrong: a file deleted it after each test, leaving what ran
 * next on the real `~/.centralu`, and another restored a saved `undefined`, which Node stores as the string
 * "undefined", a folder in the current directory.
 *
 * Every spelling is reported, read from the syntax tree:
 *   - dot, bracket or template-literal access, any assignment operator, `++`/`--`, `delete`;
 *   - a key held in a `const` (`const KEY = 'CC_DATA_DIR'; process.env[KEY] = …`);
 *   - `process.env` through an alias (`const env = process.env`, `const { env } = process`, `import { env } from 'node:process'`) or `globalThis.process`;
 *   - `Object.assign(process.env, …)` naming the variable or copying in what cannot be seen (a spread, a saved
 *     object), `Reflect.set` / `Reflect.deleteProperty` / `Object.defineProperty(ies)` on it;
 *   - replacing `process.env` whole.
 * Parentheses, `as`, `!` and `?.` around any of these do not hide it.
 *
 * Gaps, known: destructuring and loop targets (`[process.env.CC_DATA_DIR] = [x]`, `for (process.env.CC_DATA_DIR of xs)`), a chain of more than five aliases, a key that is a parameter or a `let` (`process.env[name] = v` is not told from another variable),
 * a function that is handed `process.env` and writes to it, and a `let` or reassigned alias.
 *
 * There is no way around it in the file: the rule is in the guard pass (tooling/eslint-guard-pass.js), which reads no comment as
 * configuration, so neither an `eslint-disable` nor an inline configuration comment hides a finding. A real exception is a line of
 * `EXCEPTIONS` below with its reason; the list only shrinks (tooling/test-data-dir-checks.test.ts holds its ceiling).
 *
 * This was a unit test that parsed every test file (712) a second time (#1602); ESLint parses each file once per
 * run and caches the result.
 */
import { relative } from 'node:path'
import { constInit, variableOf } from './eslint-const-init.js'

const NAME = 'CC_DATA_DIR'

/** Files that may write the variable, by repository-relative path, each with the reason. Empty; it only shrinks. */
export const EXCEPTIONS = {}

/** The expression under TypeScript's wrappers: `(process.env as Env)`, `process.env!`, `process?.env` */
function unwrap(node) {
  let n = node
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'TSTypeAssertion' || n.type === 'TSSatisfiesExpression' || n.type === 'ChainExpression')) n = n.expression
  return n
}

/** What to do instead, by kind of file: Playwright has no `vi` */
const advice = (filename) =>
  /(^|[\\/])e2e[\\/]/.test(filename)
    ? 'pass it in the `env` of the process the scenario starts, not by writing process.env: the next scenario would inherit it'
    : "stub it with vi.stubEnv('CC_DATA_DIR', dir): vitest undoes the stub before the next test"

export const testDataDir = {
  meta: {
    type: 'problem',
    docs: { description: `keeps a test file from assigning or deleting process.env.${NAME} by hand` },
    messages: {
      write: `process.env.${NAME} is written by hand; {{advice}} (#845)`,
      replace: 'process.env is replaced, which drops the data folder every test file is handed; {{advice}} (#845)',
      assign: `this can write ${NAME} by hand (the key or the source cannot be seen); {{advice}} (#845)`,
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode
    const data = { advice: advice(context.filename) }
    const relativePath = relative(context.cwd, context.filename).replaceAll('\\', '/')
    if (Object.hasOwn(EXCEPTIONS, relativePath)) return {}
    const report = (node, messageId) => context.report({ node, messageId, data })

    /** The string an expression is, or null when it cannot be told: a literal, a plain template, a `const`, a sum of those */
    const text = (node, depth = 0) => {
      const n = unwrap(node)
      if (!n || depth > 5) return null
      if (n.type === 'Literal') return typeof n.value === 'string' ? n.value : null
      if (n.type === 'TemplateLiteral') {
        // `CC_DATA_DIR`, or `${PREFIX}DIR` with every substitution a string that can be told
        let out = n.quasis[0].value.cooked
        for (const [i, e] of n.expressions.entries()) {
          const part = text(e, depth + 1)
          if (part === null) return null
          out += part + n.quasis[i + 1].value.cooked
        }
        return out
      }
      if (n.type === 'BinaryExpression' && n.operator === '+') {
        const [a, b] = [text(n.left, depth + 1), text(n.right, depth + 1)]
        return a !== null && b !== null ? a + b : null
      }
      if (n.type === 'Identifier') {
        const found = constInit(source, n)
        return found && !found.pattern ? text(found.init, depth + 1) : null
      }
      return null
    }

    /** The name in `x.name`, `x['name']`, x[`name`], x[KEY]; null when it is not known */
    const memberKey = (node) => {
      if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null
      return text(node.property)
    }

    /** `process`, `globalThis.process`, or a `const` holding either */
    const isProcess = (node, depth = 0) => {
      const n = unwrap(node)
      if (!n || depth > 5) return false
      if (n.type === 'Identifier') {
        if (n.name === 'process') {
          // The global, or `import process from 'node:process'`; not a parameter or a local that happens to be called process
          const defs = variableOf(source, n)?.defs ?? []
          if (defs.length === 0 || defs[0].type === 'ImportBinding') return true
        }
        const found = constInit(source, n)
        return !!found && !found.pattern && isProcess(found.init, depth + 1)
      }
      if (n.type === 'MemberExpression' && memberKey(n) === 'process') {
        const object = unwrap(n.object)
        return object?.type === 'Identifier' && (object.name === 'globalThis' || object.name === 'global')
      }
      return false
    }

    /** `process.env`, or a `const` holding it (`const env = process.env`, `const { env } = process`) */
    const isEnv = (node, depth = 0) => {
      const n = unwrap(node)
      if (!n || depth > 5) return false
      if (n.type === 'MemberExpression') return memberKey(n) === 'env' && isProcess(n.object)
      if (n.type === 'Identifier') {
        const found = constInit(source, n)
        if (!found) {
          // `import { env } from 'node:process'`
          const def = variableOf(source, n)?.defs[0]
          return def?.type === 'ImportBinding' && def.node.type === 'ImportSpecifier' && def.node.imported.name === 'env' && /^(node:)?process$/.test(def.parent.source.value)
        }
        if (found.pattern) return !found.pattern.computed && found.pattern.key.type === 'Identifier' && found.pattern.key.name === 'env' && isProcess(found.init)
        return isEnv(found.init, depth + 1)
      }
      return false
    }

    /** `process.env.CC_DATA_DIR` in any spelling */
    const isDataDir = (node) => {
      const n = unwrap(node)
      return n?.type === 'MemberExpression' && isEnv(n.object) && memberKey(n) === NAME
    }

    /** `Object.assign`, `Reflect.set` …: the callee's object and method, when both are plain names */
    const calleeOf = (node) => {
      const n = unwrap(node)
      if (n?.type !== 'MemberExpression' || n.object.type !== 'Identifier') return null
      const method = n.computed ? text(n.property) : n.property.type === 'Identifier' ? n.property.name : null
      return method === null ? null : `${n.object.name}.${method}`
    }

    /** Does the source of an `Object.assign` or `defineProperties` name the variable, or hold what cannot be seen? */
    const mayHoldDataDir = (sourceArg) => {
      const s = unwrap(sourceArg)
      if (s.type !== 'ObjectExpression') return true
      return s.properties.some((p) => {
        if (p.type !== 'Property') return true // a spread
        const name = p.computed ? text(p.key) : p.key.type === 'Identifier' ? p.key.name : p.key.value
        return name === null || name === NAME
      })
    }

    return {
      AssignmentExpression(node) {
        if (isDataDir(node.left)) report(node, 'write')
        // `env = …` on a local alias is not process.env being replaced: only `process.env = …`
        else if (unwrap(node.left)?.type === 'MemberExpression' && isEnv(node.left)) report(node, 'replace')
      },
      UpdateExpression(node) {
        if (isDataDir(node.argument)) report(node, 'write')
      },
      UnaryExpression(node) {
        if (node.operator === 'delete' && isDataDir(node.argument)) report(node, 'write')
      },
      CallExpression(node) {
        const callee = calleeOf(node.callee)
        const [target, key] = node.arguments
        if (!callee || !target) return
        const keyNamed = () => {
          const name = key ? text(key) : null
          return name === null || name === NAME
        }
        if (callee === 'Object.assign') {
          if (isEnv(target) && node.arguments.slice(1).some(mayHoldDataDir)) report(node, 'assign')
        } else if (['Reflect.set', 'Reflect.deleteProperty', 'Reflect.defineProperty', 'Object.defineProperty'].includes(callee)) {
          if (isEnv(target) && keyNamed()) report(node, 'assign')
          else if (isProcess(target) && key && text(key) === 'env') report(node, 'replace')
        } else if (callee === 'Object.defineProperties') {
          if (isEnv(target) && node.arguments[1] && mayHoldDataDir(node.arguments[1])) report(node, 'assign')
        }
      },
    }
  },
}

export default { rules: { 'data-dir': testDataDir } }
