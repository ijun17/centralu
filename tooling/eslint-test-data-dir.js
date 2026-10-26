/**
 * `test-env/data-dir`: a test file never writes `process.env.CC_DATA_DIR` by hand (#845, #1602).
 *
 * Each test file runs against a fresh data folder (`vitest.config.ts`, tooling/vitest-data-dir.test.ts). A
 * test that needs another one stubs it (`vi.stubEnv`), which vitest undoes before the next test
 * (`unstubEnvs`). Writing it by hand is what went wrong: a file deleted it after each test, leaving what ran
 * next on the real `~/.centralu`, and another restored a saved `undefined`, which Node stores as the string
 * "undefined", a folder in the current directory.
 *
 * Every spelling is reported, read from the syntax tree: dot or bracket access, any assignment operator,
 * `delete`, `Object.assign(process.env, …)` naming the variable or copying in what cannot be seen (a saved
 * environment, a spread), and replacing `process.env` whole. Parentheses, `as`, `!` and `?.` around
 * `process.env` do not hide it. This was a unit test that parsed every test file (712) a second time (#1602);
 * ESLint parses each file once per run and caches the result.
 */

const NAME = 'CC_DATA_DIR'

/** The expression under TypeScript's wrappers: `(process.env as Env)`, `process.env!`, `process?.env` */
function unwrap(node) {
  let n = node
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'TSTypeAssertion' || n.type === 'TSSatisfiesExpression' || n.type === 'ChainExpression')) n = n.expression
  return n
}

/** The key of `x.key` or `x['key']`; null when it is not known */
function memberKey(node) {
  if (node.computed) return node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null
  return node.property.type === 'Identifier' ? node.property.name : null
}

/** `process.env` */
function isEnv(node) {
  const n = unwrap(node)
  if (n?.type !== 'MemberExpression' || memberKey(n) !== 'env') return false
  const object = unwrap(n.object)
  return object?.type === 'Identifier' && object.name === 'process'
}

/** `process.env.CC_DATA_DIR` or `process.env['CC_DATA_DIR']` */
function isDataDir(node) {
  const n = unwrap(node)
  return n?.type === 'MemberExpression' && isEnv(n.object) && memberKey(n) === NAME
}

/** `Object.assign` */
function isObjectAssign(node) {
  const n = unwrap(node)
  if (n?.type !== 'MemberExpression') return false
  const object = unwrap(n.object)
  return object?.type === 'Identifier' && object.name === 'Object' && memberKey(n) === 'assign'
}

/** A source of `Object.assign(process.env, …)` that names the variable or cannot be seen into */
function mayHoldDataDir(source) {
  const s = unwrap(source)
  if (s.type !== 'ObjectExpression') return true
  return s.properties.some((p) => {
    if (p.type !== 'Property') return true // a spread
    if (!p.computed) return (p.key.type === 'Identifier' ? p.key.name : p.key.value) === NAME
    // `[NAME]: …`, `['CC_DATA_DIR']: …`: a key that is not a plain string cannot be read, so it counts as naming it
    const known = p.key.type === 'Literal' ? p.key.value : p.key.type === 'TemplateLiteral' && p.key.expressions.length === 0 ? p.key.quasis[0].value.cooked : null
    return known === null || known === NAME
  })
}

export const testDataDir = {
  meta: {
    type: 'problem',
    docs: { description: `keeps a test file from assigning or deleting process.env.${NAME} by hand` },
    messages: {
      write: `process.env.${NAME} is set in a test with vi.stubEnv('${NAME}', dir): vitest undoes it before the next test. Writing it by hand leaves the next test on a folder it did not choose (#845)`,
      replace: `replacing process.env drops the data folder every test file is handed; set one variable with vi.stubEnv (#845)`,
      assign: `Object.assign(process.env, …) can write ${NAME} by hand; stub what the test needs with vi.stubEnv (#845)`,
    },
    schema: [],
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        if (isDataDir(node.left)) context.report({ node, messageId: 'write' })
        else if (isEnv(node.left)) context.report({ node, messageId: 'replace' })
      },
      UnaryExpression(node) {
        if (node.operator === 'delete' && isDataDir(node.argument)) context.report({ node, messageId: 'write' })
      },
      CallExpression(node) {
        if (!isObjectAssign(node.callee) || !node.arguments[0] || !isEnv(node.arguments[0])) return
        if (node.arguments.slice(1).some(mayHoldDataDir)) context.report({ node, messageId: 'assign' })
      },
    }
  },
}

export default { rules: { 'data-dir': testDataDir } }
