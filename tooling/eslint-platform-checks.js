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
import { OS_NAMED_EXPORTS, OS_PROCESS_USES, REPO_ROOT, mayTouchOs, osModule, readOsAllowlist } from './os-layer.js'

/** Node's `process.platform` values */
const OS_NAMES = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32'])

const isOsName = (node) => node?.type === 'Literal' && typeof node.value === 'string' && OS_NAMES.has(node.value)

const propertyName = (node) => (node.computed ? constantString(node.property) : node.property.name)

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

/** A string a node spells out whole: a string literal, or a template literal with nothing interpolated */
function constantString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null
  return null
}

/**
 * The module specifier a node loads, as written, or null: a static import, `export … from`, `import()`, `require()`,
 * `process.getBuiltinModule()` and `import x = require()`, each with a constant string. The selection
 * (tooling/os-tests.ts) follows imports with this same function, so the two cannot disagree on what is loaded. A
 * computed specifier, or a `require` made by `createRequire` under another name, is not seen.
 */
export function loadedSpecifier(node) {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
      return constantString(node.source)
    case 'ExportNamedDeclaration':
      return node.source ? constantString(node.source) : null
    case 'ImportExpression':
      return constantString(node.source)
    case 'TSExternalModuleReference':
      return constantString(node.expression)
    case 'CallExpression': {
      const c = node.callee
      const loads =
        (c.type === 'Identifier' && c.name === 'require') ||
        (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'process' && c.property.name === 'getBuiltinModule')
      return loads ? constantString(node.arguments[0]) : null
    }
    default:
      return null
  }
}

/**
 * The OS module a node loads, or null: a type-only import runs nothing, and `import { posix, win32 } from 'node:path'`
 * reads paths the same way on every OS.
 */
function touchedBy(node) {
  const module = osModule(loadedSpecifier(node))
  if (!module) return null
  if (node.type === 'ImportDeclaration') {
    if (node.importKind === 'type') return null
    const specs = node.specifiers
    if (specs.length > 0 && specs.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type')) return null
    if (module === 'path' && specs.length > 0 && specs.every((s) => s.type === 'ImportSpecifier' && SAME_ON_EVERY_OS.has(importedName(s)))) return null
  }
  if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.exportKind === 'type') return null
  return module
}

/** The module a specifier names without `node:`, if `OS_NAMED_EXPORTS` names some of its exports */
const namedExportsModule = (specifier) => {
  const name = typeof specifier === 'string' && specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  return typeof name === 'string' && Object.hasOwn(OS_NAMED_EXPORTS, name) ? name : null
}

/** `process` and `node:process`, the module Node's `process` object also is */
const PROCESS_MODULES = new Set(['process', 'node:process'])

/** A key of an object pattern (`const { cwd } = process`), when spelled out */
const patternKey = (p) => (p.type !== 'Property' ? null : p.computed ? constantString(p.key) : p.key.type === 'Identifier' ? p.key.name : constantString(p.key))

/** A path relative to the repository, with `/` */
const repoPath = (filename) => relative(REPO_ROOT, filename).split(sep).join('/')

let allowlist = null
const osAllowlist = () => (allowlist ??= new Set(readOsAllowlist()))

/**
 * `local/os-imports`: the OS is touched only in the OS layer (tooling/os-layer.js, docs/plans/os-layer.md, #1599).
 *
 * In the checked code (the packages, the apps, the npm launcher, and their tests), importing an OS module (`OS_MODULES`
 * bare or `node:`, and `INSTALLED_OS_MODULES`; static, dynamic, `require` or `process.getBuiltinModule`), importing
 * `fileURLToPath` or `pathToFileURL` (`OS_NAMED_EXPORTS`), and using `process.kill`, `process.cwd()`,
 * `process.chdir()`, `process.execPath` or `process.env.PATH` (`OS_PROCESS_USES`) is reported outside the layer and its
 * tests, and outside the files on tooling/os-allowlist.txt, a list that may only
 * shrink (tooling/os-layer.test.ts). Code that needs a file, a path, a process or the OS asks the layer.
 *
 * `{ everywhere: true }` reports every such import wherever it is: how tooling/os-tests.ts asks the same question
 * of any file, to pick the tests that run on every OS.
 *
 * `process` is Node's own unless the file declares a `process` of its own (then it is that), and also reached as
 * `globalThis.process` and through `node:process`; a use is seen as a member (`process.cwd()`, `env['Path']`) or in an
 * object pattern (`const { cwd } = process`, `const { PATH } = process.env`). Not seen: a computed key
 * (`process[name]`), `process.env` or a `node:url` namespace kept in a variable and read later, `require('node:url')`
 * read in place, a computed `import()`, and a `require` made by `createRequire` under another name.
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
    const report = (node, module) => context.report({ node, messageId: 'touch', data: { module } })
    const check = (node) => {
      const module = touchedBy(node)
      if (module) report(node, module)
    }
    // Local names bound by imports: of `node:process` (the object, or its `env`), and the object of a module
    // `OS_NAMED_EXPORTS` names (`import * as url from 'node:url'`)
    const processNames = new Set()
    const envNames = new Set()
    const namespaces = new Map()
    const sourceCode = context.sourceCode
    /** Is `id` Node's `process`: the global one, unless the file declares its own, or one imported from node:process */
    const isNodeProcess = (id) => {
      for (let scope = sourceCode.getScope(id); scope; scope = scope.upper) {
        const v = scope.set.get(id.name)
        if (v && v.defs.length > 0) return v.defs.every((d) => d.type === 'ImportBinding') && processNames.has(id.name)
      }
      return id.name === 'process'
    }
    const isProcess = (node) =>
      (node.type === 'Identifier' && isNodeProcess(node)) ||
      (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'globalThis' && propertyName(node) === 'process')
    const isEnv = (node) =>
      (node.type === 'MemberExpression' && isProcess(node.object) && propertyName(node) === 'env') || (node.type === 'Identifier' && envNames.has(node.name))
    const isPath = (name) => typeof name === 'string' && name.toUpperCase() === 'PATH'
    /** What `key` of `object` reaches of the OS, if anything: `process.cwd`, `process.env.PATH`, `url.fileURLToPath` */
    const reached = (object, key) => {
      if (isProcess(object) && OS_PROCESS_USES.includes(key)) return `process.${key}`
      if (isEnv(object) && isPath(key)) return 'process.env.PATH'
      if (object.type === 'Identifier' && namespaces.has(object.name) && OS_NAMED_EXPORTS[namespaces.get(object.name)].includes(key)) {
        return `${namespaces.get(object.name)}.${key}`
      }
      return null
    }
    const checkPattern = (pattern, object) => {
      for (const p of pattern.properties) {
        const key = patternKey(p)
        const what = key === null ? null : reached(object, key)
        if (what) report(p, what)
        // `const { env: { PATH } } = process`
        else if (key === 'env' && isProcess(object) && p.value.type === 'ObjectPattern') {
          for (const q of p.value.properties) if (isPath(patternKey(q))) report(q, 'process.env.PATH')
        }
      }
    }
    return {
      ImportDeclaration(node) {
        check(node)
        const spec = loadedSpecifier(node)
        if (node.importKind === 'type') return
        if (PROCESS_MODULES.has(spec)) {
          for (const s of node.specifiers) {
            if (s.type !== 'ImportSpecifier' || importedName(s) === 'default') processNames.add(s.local.name)
            else if (s.importKind === 'type') continue
            else if (OS_PROCESS_USES.includes(importedName(s))) report(s, `process.${importedName(s)}`)
            else if (importedName(s) === 'env') envNames.add(s.local.name)
          }
          return
        }
        const module = namedExportsModule(spec)
        if (!module) return
        for (const s of node.specifiers) {
          if (s.type !== 'ImportSpecifier' || importedName(s) === 'default') namespaces.set(s.local.name, module)
          else if (s.importKind !== 'type' && OS_NAMED_EXPORTS[module].includes(importedName(s))) report(s, `${module}.${importedName(s)}`)
        }
      },
      ExportNamedDeclaration(node) {
        check(node)
        // `export { fileURLToPath } from 'node:url'`
        const module = node.exportKind === 'type' ? null : namedExportsModule(loadedSpecifier(node))
        if (!module) return
        for (const s of node.specifiers) {
          const name = s.local.type === 'Identifier' ? s.local.name : s.local.value
          if (s.exportKind !== 'type' && OS_NAMED_EXPORTS[module].includes(name)) report(s, `${module}.${name}`)
        }
      },
      MemberExpression(node) {
        const what = reached(node.object, propertyName(node))
        if (what) report(node, what)
      },
      VariableDeclarator(node) {
        if (node.id.type === 'ObjectPattern' && node.init) checkPattern(node.id, node.init)
      },
      AssignmentExpression(node) {
        if (node.left.type === 'ObjectPattern') checkPattern(node.left, node.right)
      },
      ExportAllDeclaration: check,
      ImportExpression: check,
      CallExpression: check,
      TSExternalModuleReference: check,
    }
  },
}

export default { rules: { 'platform-checks': platformChecks, 'os-imports': osImports } }
