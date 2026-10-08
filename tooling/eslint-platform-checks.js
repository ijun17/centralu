/**
 * `local/platform-checks`: which OS this is gets asked only in a platform module.
 *
 * The OS differences of the TypeScript side live behind a few modules that each own a subject
 * (`PLATFORM_MODULES` in eslint.config.js, docs/architecture.md §2). Anywhere else, a check on the
 * OS is reported: reading `process.platform` (or `os.platform()`, `os.type()`), and comparing
 * anything with an OS name (`=== 'win32'`, `case 'darwin':`). Code that needs a difference asks the
 * platform module a question named for what differs (`hasProcessGroups()`, `locksRunningPrograms()`),
 * so each OS's answer is written once.
 *
 * Tests are not checked: skipping a case on an OS is what they are for.
 */

/** Node's `process.platform` values */
const OS_NAMES = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32'])

const isOsName = (node) => node?.type === 'Literal' && typeof node.value === 'string' && OS_NAMES.has(node.value)

const propertyName = (node) =>
  node.computed ? (node.property.type === 'Literal' ? node.property.value : null) : node.property.name

/** `os` / `node:os` default or namespace import names, per file */
const OS_MODULES = new Set(['os', 'node:os'])

export const platformChecks = {
  meta: {
    type: 'problem',
    docs: { description: 'asks which OS this is only in a platform module' },
    messages: {
      read: '{{what}} is read only in a platform module; ask it a question named for what differs (docs/architecture.md §2)',
      compare: "a comparison with '{{name}}' belongs in a platform module; ask it a question named for what differs (docs/architecture.md §2)",
    },
    schema: [],
  },
  create(context) {
    const osNames = new Set()
    const report = (node, messageId, data) => context.report({ node, messageId, data })
    return {
      ImportDeclaration(node) {
        if (!OS_MODULES.has(node.source.value)) return
        for (const s of node.specifiers) {
          if (s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier') osNames.add(s.local.name)
          else if (s.type === 'ImportSpecifier' && ['platform', 'type'].includes(s.imported.name)) {
            report(s, 'read', { what: `os.${s.imported.name}()` })
          }
        }
      },
      MemberExpression(node) {
        const name = propertyName(node)
        if (node.object.type !== 'Identifier') return
        if (node.object.name === 'process' && name === 'platform') report(node, 'read', { what: 'process.platform' })
        else if (osNames.has(node.object.name) && (name === 'platform' || name === 'type')) report(node, 'read', { what: `os.${name}()` })
      },
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return
        const lit = isOsName(node.left) ? node.left : isOsName(node.right) ? node.right : null
        if (lit) report(node, 'compare', { name: lit.value })
      },
      SwitchCase(node) {
        if (isOsName(node.test)) report(node, 'compare', { name: node.test.value })
      },
    }
  },
}

export default { rules: { 'platform-checks': platformChecks } }
