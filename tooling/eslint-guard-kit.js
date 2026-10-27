/**
 * What the `guard/*` lint rules share (tooling/eslint-guards.js, tooling/eslint-guards-ts.js; #1606, #1607): reading a
 * name or a plain string out of the syntax tree, and `guard()`, which checks a rule's findings against the file's lines
 * of tooling/guard-exceptions.js.
 */
import { relative } from 'node:path'
import { EXCEPTIONS } from './guard-exceptions.js'

/** The repository-relative path of the file being linted */
export const relativeFile = (context) => relative(context.cwd, context.filename).replaceAll('\\', '/')

/** The string an expression is when it is plain: a literal or a template without substitutions; null otherwise */
export function plain(node) {
  if (node?.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
  return null
}

/** The expression under TypeScript's wrappers: `'x' as string`, `{…} as const`, `{…} satisfies T`, `x!`, `<T>x` */
export function unwrap(node) {
  let n = node
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression' || n.type === 'TSTypeAssertion')) n = n.expression
  return n
}

/** The name of `x.name`, `x['name']` or a bare `name`; null when it is not known */
export function nameOf(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') return node.computed ? plain(node.property) : node.property.type === 'Identifier' ? node.property.name : null
  return null
}

/** The key of an object property, when it is written plainly */
export function keyOf(property) {
  if (property.type !== 'Property' || property.computed) return null
  return property.key.type === 'Identifier' ? property.key.name : typeof property.key.value === 'string' ? property.key.value : null
}

/** Every string a screen could be drawn from: the strings, template pieces and JSX text of a node (not comments) */
export const stringNodes = (visit) => ({
  Literal(node) {
    if (typeof node.value === 'string') visit(node, node.value)
    else if (node.regex) visit(node, node.regex.pattern)
  },
  // A template as one text, each substitution written `${}`: `rounded-[${r}px]` is a class written with a value
  TemplateLiteral(node) {
    visit(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('${}'))
  },
  JSXText(node) {
    visit(node, node.value)
  },
})

/**
 * A rule whose findings are collected, then checked against the file's lines in tooling/guard-exceptions.js. `build`
 * gets the rule's context and `add(node, messageId, data, key)`; the `key` names a kind of finding for `counts` in an exception.
 */
export function guard(name, messages, build) {
  return {
    meta: { type: 'problem', docs: { description: `guard/${name}` }, messages: { ...messages, stale: '{{what}}' }, schema: [{ type: 'object', additionalProperties: true }] },
    create(context) {
      const found = []
      const add = (node, messageId, data = {}, key = '') => found.push({ node, messageId, data, key })
      const visitors = build(context, add)
      const entry = EXCEPTIONS[name]?.[relativeFile(context)]
      const exit = visitors['Program:exit']
      return {
        ...visitors,
        'Program:exit'(program) {
          exit?.(program)
          const stale = (what) => context.report({ node: program, messageId: 'stale', data: { what } })
          let reportable = found
          if (entry?.counts) {
            // How many of each kind of finding (by key) the file may hold; a kind not listed is not let through, and one more than listed is reported in full
            reportable = found.filter((f) => !(f.key in entry.counts))
            for (const [key, n] of Object.entries(entry.counts)) {
              const mine = found.filter((f) => f.key === key)
              if (mine.length < n) stale(`tooling/guard-exceptions.js lists ${n} ${key} here, ${mine.length} found: lower the count or remove the line`)
              if (mine.length > n) reportable.push(...mine)
            }
          } else if (entry?.count !== undefined) {
            if (found.length < entry.count) stale(`tooling/guard-exceptions.js lists ${entry.count} here, ${found.length} found: lower the count or remove the line`)
            reportable = found.length <= entry.count ? [] : found
          } else if (entry) {
            reportable = []
          }
          for (const f of reportable) context.report({ node: f.node, messageId: f.messageId, data: f.data })
        },
      }
    },
  }
}
