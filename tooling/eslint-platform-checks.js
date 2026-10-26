/**
 * `local/platform-checks`: which OS this is gets asked only in a platform module.
 *
 * The OS differences of the TypeScript side live behind a few modules that each own a subject
 * (`PLATFORM_MODULES` in tooling/os-layer.js, docs/architecture.md §2). Anywhere else, a check on the
 * OS is reported: reading `process.platform` (or `os.platform()`, `os.type()`), and comparing
 * anything with an OS name (`=== 'win32'`, `case 'darwin':`). Code that needs a difference asks the
 * platform module a question named for what differs (`hasProcessGroups()`, `locksRunningPrograms()`),
 * so each OS's answer is written once.
 *
 * Tests are not checked: skipping a case on an OS is what they are for.
 */
import { relative, sep } from 'node:path'
import { REPO_ROOT, mayTouchOs, osModule, readOsAllowlist } from './os-layer.js'

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

/** `path`'s halves that are the same on every OS */
const SAME_ON_EVERY_OS = new Set(['posix', 'win32'])

const importedName = (s) => (s.imported.type === 'Identifier' ? s.imported.name : s.imported.value)

/**
 * The OS module an import names, or null: a type-only import runs nothing, and `import { posix, win32 } from 'node:path'`
 * reads paths the same way on every OS.
 */
function touchedBy(node) {
  switch (node.type) {
    case 'ImportDeclaration': {
      const module = osModule(node.source.value)
      if (!module || node.importKind === 'type') return null
      const specs = node.specifiers
      if (specs.length > 0 && specs.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type')) return null
      if (module === 'path' && specs.length > 0 && specs.every((s) => s.type === 'ImportSpecifier' && SAME_ON_EVERY_OS.has(importedName(s)))) return null
      return module
    }
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration':
      return node.source && node.exportKind !== 'type' ? osModule(node.source.value) : null
    case 'ImportExpression':
      return node.source.type === 'Literal' ? osModule(node.source.value) : null
    case 'CallExpression':
      return node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal' ? osModule(node.arguments[0].value) : null
    case 'TSExternalModuleReference':
      return node.expression.type === 'Literal' ? osModule(node.expression.value) : null
    default:
      return null
  }
}

/** A path relative to the repository, with `/` */
const repoPath = (filename) => relative(REPO_ROOT, filename).split(sep).join('/')

let allowlist = null
const osAllowlist = () => (allowlist ??= new Set(readOsAllowlist()))

/**
 * `local/os-imports`: the OS is touched only in the OS layer (tooling/os-layer.js, docs/plans/os-layer.md, #1599).
 *
 * In the checked code (the packages, the apps, the npm launcher, and their tests), importing an OS module (`node:fs`,
 * `fs/promises`, `node:child_process`, `node:os`, `node:path`, bare or `node:`, static, dynamic or `require`) is
 * reported outside the layer and its tests, and outside the files on tooling/os-allowlist.txt, a list that may only
 * shrink (tooling/os-layer.test.ts). Code that needs a file, a path, a process or the OS asks the layer.
 *
 * `{ everywhere: true }` reports every such import wherever it is: how tooling/os-tests.ts asks the same question
 * of any file, to pick the tests that run on every OS.
 */
export const osImports = {
  meta: {
    type: 'problem',
    docs: { description: 'touches the OS only in the OS layer' },
    messages: {
      touch: "'{{module}}' is used only in the OS layer (tooling/os-layer.js); ask the layer for what this needs (docs/plans/os-layer.md)",
    },
    schema: [{ type: 'object', properties: { everywhere: { type: 'boolean' } }, additionalProperties: false }],
  },
  create(context) {
    const everywhere = context.options[0]?.everywhere === true
    if (!everywhere && mayTouchOs(repoPath(context.filename), osAllowlist())) return {}
    const check = (node) => {
      const module = touchedBy(node)
      if (module) context.report({ node, messageId: 'touch', data: { module } })
    }
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
      ImportExpression: check,
      CallExpression: check,
      TSExternalModuleReference: check,
    }
  },
}

export default { rules: { 'platform-checks': platformChecks, 'os-imports': osImports } }
