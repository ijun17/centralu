/**
 * `guard/*`: repository guards that were unit tests reading every source file of a folder (#1606, #1602).
 *
 * Each was a regular expression over the text of a whole package, run as a test: another parse of the same files
 * ESLint already reads once per run, on every OS, near the 5 s limit under load. Here each is a rule over the syntax
 * tree, so a comment or a string that merely mentions the thing is no longer a finding, and a spelling the regular
 * expression did not name (`cp.spawn`, a template literal, a name reached through a `const`) is.
 *
 * Which files each rule reads is `guardConfigs` below, spread into eslint.config.js. What each lets through is
 * tooling/guard-exceptions.js, by rule and file, with a reason; `pnpm lint` refuses an eslint-disable of any `guard/`
 * rule (tooling/lint-allowlist.ts), so that list is the only way around one.
 *
 * Known gaps, shared: a name rebound through a `let`, a function that is handed what the rule looks for, and a
 * spelling that needs types (a `Reflect` call, an alias of an imported function).
 */
import { relative } from 'node:path'
import { EXCEPTIONS } from './guard-exceptions.js'

/** The rule names, so lint-allowlist.ts need not list them */
export const GUARD_PREFIX = 'guard/'

/** The repository-relative path of the file being linted */
const relativeFile = (context) => relative(context.cwd, context.filename).replaceAll('\\', '/')

/** The string an expression is when it is plain: a literal or a template without substitutions; null otherwise */
function plain(node) {
  if (node?.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
  return null
}

/** The name of `x.name`, `x['name']` or a bare `name`; null when it is not known */
function nameOf(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') return node.computed ? plain(node.property) : node.property.type === 'Identifier' ? node.property.name : null
  return null
}

/** The key of an object property, when it is written plainly */
function keyOf(property) {
  if (property.type !== 'Property' || property.computed) return null
  return property.key.type === 'Identifier' ? property.key.name : typeof property.key.value === 'string' ? property.key.value : null
}

/** Every string a screen could be drawn from: the strings, template pieces and JSX text of a node (not comments) */
const stringNodes = (visit) => ({
  Literal(node) {
    if (typeof node.value === 'string') visit(node, node.value)
    else if (node.regex) visit(node, node.regex.pattern)
  },
  TemplateElement(node) {
    visit(node, node.value.cooked ?? node.value.raw)
  },
  JSXText(node) {
    visit(node, node.value)
  },
})

/**
 * A rule whose findings are collected, then checked against the file's lines in tooling/guard-exceptions.js. `build`
 * gets the rule's context and `add(node, messageId, data, key)`; the `key` names a finding for `keys` in an exception.
 */
function guard(name, messages, build) {
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
          if (entry?.keys) {
            for (const key of entry.keys) if (!found.some((f) => f.key === key)) stale(`tooling/guard-exceptions.js lets ${key} through in this file, and it is no longer there: remove it from the line`)
            reportable = found.filter((f) => !entry.keys.includes(f.key))
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

/** `.split('/')` and `.join('/')`: a path taken apart on a hardcoded separator (#47) */
const noHandSplit = guard('no-hand-split', { hand: "`.{{method}}('/')` takes a path apart on a hardcoded separator: use wireSegments · wireBaseName · wireJoin from @cc/protocol (#47)" }, (_context, add) => ({
  CallExpression(node) {
    const method = nameOf(node.callee)
    if (node.callee.type !== 'MemberExpression' || (method !== 'split' && method !== 'join')) return
    if (node.arguments.length === 1 && plain(node.arguments[0]) === '/') add(node, 'hand', { method })
  },
}))

/** ui must not know which OS it is on (docs/platform-abstraction.md) */
const uiNoOs = guard('ui-no-os', { os: '{{what}} asks which OS this is: an OS difference belongs in the @cc/platform port or on the Rust side (docs/platform-abstraction.md)' }, (_context, add) => ({
  MemberExpression(node) {
    const property = nameOf(node)
    const owner = nameOf(node.object)
    if ((property === 'platform' && (owner === 'process' || owner === 'navigator')) || (property === 'userAgentData' && owner === 'navigator')) add(node, 'os', { what: `${owner}.${property}` })
  },
  Identifier(node) {
    if (node.name === 'isMac') add(node, 'os', { what: 'isMac' })
  },
}))

/** Keyboard key names (⌘, ⌥) are never written onto the screen (#32) */
const uiNoKeyGlyphs = guard('ui-no-key-glyphs', { glyph: 'a keyboard key name is written onto the screen: use <Kbd mod /> · <Kbd alt /> or useShortcut() (#32)' }, (_context, add) =>
  stringNodes((node, text) => {
    if (/[⌘⌥]/.test(text)) add(node, 'glyph')
  }),
)

const SIZE = /(?<![\w-])(?:text|leading)-\[[^\]\s]+\]/g
/** Type stays on the scale (#312 step 2): no arbitrary text size or line height, no number as a fontSize */
const uiTypeScale = guard('ui-type-scale', { size: '{{what}} is a size outside the type scale: use a token from styles/index.css, or add the exception with its reason to tooling/guard-exceptions.js' }, (_context, add) => ({
  ...stringNodes((node, text) => {
    for (const m of text.matchAll(SIZE)) {
      // text-[…] is also how a colour is written arbitrarily; only sizes are the scale's business
      if (m[0].startsWith('text-[') && !/^text-\[[\d.]+(px|rem|em)\]$/.test(m[0])) continue
      add(node, 'size', { what: m[0] }, m[0])
    }
  }),
  Property(node) {
    if (keyOf(node) !== 'fontSize') return
    const text = typeof node.value.value === 'number' ? String(node.value.value) : plain(node.value) ?? (node.value.type === 'TemplateLiteral' ? node.value.quasis[0].value.cooked : '')
    if (/^\d/.test(text)) add(node, 'size', { what: 'fontSize: ' + text }, 'fontSize')
  },
}))

const CORNER = /(?<![\w-])rounded(?:-[trblse]{1,2})?-\[[^\]\s]+\]/g
/** Corners come from the radius scale (docs/design-system.md, Shape; #312 step 2) */
const uiRadiusScale = guard('ui-radius-scale', { corner: '{{what}} writes a corner as a value: use a --radius-* token (rounded-sm, -md, -lg, -field, -bubble, -full)' }, (_context, add) => ({
  ...stringNodes((node, text) => {
    for (const m of text.matchAll(CORNER)) add(node, 'corner', { what: m[0] })
  }),
  Property(node) {
    if (keyOf(node) === 'borderRadius') add(node, 'corner', { what: 'borderRadius' })
  },
}))

const CHILD_PROCESS = /^(?:node:)?child_process$/
const STARTERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])

/** Every child the host starts is hidden (docs/runtime-lessons.md ST13, #983) */
const hiddenChildren = guard(
  'hidden-children',
  {
    start: '`{{name}}(…)` starts a process without `windowsHide: true` in its own options: a console program the host starts opens a window of its own on Windows (ST13, #983)',
    unnamed: "child_process is reached other than by importing its functions by name, so its calls cannot be checked: import { spawn } from 'node:child_process' (ST13, #983)",
  },
  (context, add) => {
    const source = context.sourceCode
    const starters = new Set() // variables that hold a function that starts a process
    return {
      ImportDeclaration(node) {
        if (!CHILD_PROCESS.test(node.source.value) || node.importKind === 'type') return
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') add(spec, 'unnamed')
          else if (spec.importKind !== 'type' && STARTERS.has(spec.imported.name ?? spec.imported.value)) starters.add(source.getDeclaredVariables(spec)[0])
        }
      },
      ImportExpression(node) {
        if (CHILD_PROCESS.test(plain(node.source) ?? '')) add(node, 'unnamed')
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && CHILD_PROCESS.test(plain(node.arguments[0]) ?? '')) add(node, 'unnamed')
      },
      'Program:exit'() {
        // `const run = promisify(execFile)` holds one too, however many steps it takes
        for (let grew = true; grew; ) {
          grew = false
          for (const variable of [...starters]) {
            for (const ref of variable.references) {
              const call = ref.identifier.parent
              if (call?.type !== 'CallExpression' || call.arguments[0] !== ref.identifier || nameOf(call.callee) !== 'promisify') continue
              const declarator = call.parent
              if (declarator?.type !== 'VariableDeclarator' || declarator.id.type !== 'Identifier') continue
              const made = source.getDeclaredVariables(declarator)[0]
              if (made && !starters.has(made)) {
                starters.add(made)
                grew = true
              }
            }
          }
        }
        for (const variable of starters) {
          for (const ref of variable.references) {
            const call = ref.identifier.parent
            if (call?.type !== 'CallExpression' || call.callee !== ref.identifier) continue
            const hidden = call.arguments.some(
              (a) => a.type === 'ObjectExpression' && a.properties.some((p) => keyOf(p) === 'windowsHide' && !(p.value.type === 'Literal' && p.value.value === false)),
            )
            if (!hidden) add(call, 'start', { name: variable.name })
          }
        }
      },
    }
  },
)

const GIT_STARTERS = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync'])
/** Every git the host starts goes through runGit (#407) */
const gitStart = guard('git-start', { git: 'git is started here by name: go through runGit in dev-services/git-exec.ts, which locks it before trust (#407)' }, (_context, add) => ({
  CallExpression(node) {
    const callee = nameOf(node.callee)
    const first = plain(node.arguments[0])
    if ((callee === 'programPath' && first === 'git') || (GIT_STARTERS.has(callee) && /^git(?:\.exe)?$/.test(first ?? ''))) add(node, 'git')
  },
}))

/** A coded error is built by one function (#850), not by `Object.assign(new Error(…), { code: 'x' })` */
const noHandCodedError = guard('no-hand-coded-error', { coded: 'a coded error is assembled by hand: build it with rpcError (host) or mockError (mock), which type the code (#850)' }, (_context, add) => ({
  CallExpression(node) {
    const callee = node.callee
    if (callee.type !== 'MemberExpression' || callee.computed || nameOf(callee.object) !== 'Object' || nameOf(callee) !== 'assign') return
    const [target, ...rest] = node.arguments
    if (target?.type !== 'NewExpression' || nameOf(target.callee) !== 'Error') return
    for (const source of rest) {
      if (source.type !== 'ObjectExpression') continue
      // `{ code: 'internal' }`: a protocol code is lower case (an errno such as 'ENOENT' is not one)
      if (source.properties.some((p) => keyOf(p) === 'code' && /^[a-z_]+$/.test(plain(p.value) ?? ''))) add(node, 'coded')
    }
  },
}))

/** A rule that lets only the listed files call certain methods: the callee's text is the finding's key */
const callersOf = (name, methods, what, rule) =>
  guard(name, { caller: `{{callee}} deletes ${what} for good: ${rule}; a caller is listed with its reason in tooling/guard-exceptions.js` }, (context, add) => ({
    CallExpression(node) {
      const callee = node.callee
      if (callee.type !== 'MemberExpression' || callee.computed) return
      const text = context.sourceCode.getText(callee).replace(/\s+/g, '')
      if (methods.some((m) => text.endsWith('.' + m))) add(node, 'caller', { callee: text }, text)
    },
  }))
const purgeCallers = callersOf('purge-callers', ['purgeSession', 'emptyTrash'], 'sessions', 'only the person deletes for good, and only through the RPC (#204)')
const subagentPurgeCallers = callersOf('subagent-purge-callers', ['purgeSubagentSteps', 'subagentSteps.purge'], 'subagent steps', 'only the RPC handler and deleting all archived sessions do (#204)')

/** A layer's imports: `forbidden` patterns, minus what `unless` lets back in. Static, re-exported, dynamic and required alike. */
const importBoundary = guard('import-boundary', { import: "'{{specifier}}' is imported across a boundary: {{why}} (docs/architecture.md §2; dependency-cruiser enforces the same list)" }, (context, add) => {
  const options = context.options[0] ?? {}
  const forbidden = (options.forbidden ?? []).map((p) => new RegExp(p))
  const unless = (options.unless ?? []).map((p) => new RegExp(p))
  const check = (node, specifier) => {
    if (specifier === null) return
    if (forbidden.some((re) => re.test(specifier)) && !unless.some((re) => re.test(specifier))) add(node, 'import', { specifier, why: options.why ?? 'this layer may not reach it' })
  }
  return {
    ImportDeclaration: (node) => check(node, plain(node.source)),
    ExportNamedDeclaration: (node) => node.source && check(node, plain(node.source)),
    ExportAllDeclaration: (node) => check(node, plain(node.source)),
    ImportExpression: (node) => check(node, plain(node.source)),
    TSImportEqualsDeclaration: (node) => node.moduleReference.type === 'TSExternalModuleReference' && check(node, plain(node.moduleReference.expression)),
    CallExpression: (node) => node.callee.type === 'Identifier' && node.callee.name === 'require' && check(node, plain(node.arguments[0])),
  }
})

/** The protocol does not know about vendors (#59): no tool name in its code */
const noToolNames = guard('no-tool-names', { tool: "the protocol names a tool ('{{text}}'): an adapter introduces itself, so a vendor is never written on the shelf both sides reach (#59)" }, (_context, add) => {
  const re = /\b(claude|codex)\b/i
  return {
    ...stringNodes((node, text) => {
      if (re.test(text)) add(node, 'tool', { text: text.length > 40 ? text.slice(0, 40) + '…' : text })
    }),
    Identifier(node) {
      if (re.test(node.name)) add(node, 'tool', { text: node.name })
    },
  }
})

const SLEEPS = new Set(['setTimeout', 'sleep', 'delay'])
/** The tests of the frame-replayed adapters wait for an event or a frame, never for time (#1498) */
const noSleeps = guard('no-sleeps', { sleep: '{{what}} waits for time: wait for an event or a frame instead (tests that wait on wall-clock time fail under load, #1498)' }, (_context, add) => ({
  CallExpression(node) {
    const name = nameOf(node.callee)
    if (name !== null && SLEEPS.has(name)) add(node, 'sleep', { what: name + '()' })
    if (name?.startsWith('advanceTimers') && nameOf(node.callee.object) === 'vi') add(node, 'sleep', { what: 'vi.' + name })
  },
  Identifier(node) {
    if (node.name === 'waitForTimeout') add(node, 'sleep', { what: 'waitForTimeout' })
  },
}))

/** The plugin eslint.config.js registers as `guard` */
export const guards = {
  rules: {
    'no-hand-split': noHandSplit,
    'ui-no-os': uiNoOs,
    'ui-no-key-glyphs': uiNoKeyGlyphs,
    'ui-type-scale': uiTypeScale,
    'ui-radius-scale': uiRadiusScale,
    'hidden-children': hiddenChildren,
    'git-start': gitStart,
    'no-hand-coded-error': noHandCodedError,
    'purge-callers': purgeCallers,
    'subagent-purge-callers': subagentPurgeCallers,
    'import-boundary': importBoundary,
    'no-tool-names': noToolNames,
    'no-sleeps': noSleeps,
  },
}

const TESTS = ['**/*.test.{ts,tsx,mts}', '**/*test-helpers.ts']
const UI = ['packages/ui/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}', 'apps/desktop/src/**/*.{ts,tsx}']
const HOST_SRC = 'packages/agent-host/src'

/**
 * The files each rule reads. A block per scope, one rule or two each: what the unit test each came from walked.
 * Spread into eslint.config.js.
 */
export const guardConfigs = [
  // Shipped sources of every package (tests pin POSIX paths, they do not assume them)
  { files: ['packages/*/src/**/*.{ts,tsx}'], ignores: ['**/*.test.{ts,tsx}'], rules: { 'guard/no-hand-split': 'error' } },
  // The UI: no OS, and key names from the port (tests pin the Mac notation); the scales apply to every screen the UI is drawn from
  { files: ['packages/ui/src/**/*.{ts,tsx}'], rules: { 'guard/ui-no-os': 'error' } },
  { files: ['packages/ui/src/**/*.{ts,tsx}'], ignores: ['**/*.test.{ts,tsx}'], rules: { 'guard/ui-no-key-glyphs': 'error' } },
  { files: UI, ignores: ['**/*.test.{ts,tsx}'], rules: { 'guard/ui-type-scale': 'error' } },
  // Shared components decide their own shape once for every screen that uses them; the stylesheet is CSS
  { files: UI, ignores: ['**/*.test.{ts,tsx}', 'packages/ui/src/components/**', 'packages/ui/src/styles/**'], rules: { 'guard/ui-radius-scale': 'error' } },
  // The host
  { files: [`${HOST_SRC}/**/*.{ts,mts,js,mjs}`], ignores: [...TESTS, '**/*.d.ts', '**/test-fixtures/**', '**/node_modules/**'], rules: { 'guard/hidden-children': 'error' } },
  { files: [`${HOST_SRC}/**/*.{ts,mts,js,mjs}`], ignores: ['**/*.test.ts', '**/*test-helpers.ts'], rules: { 'guard/git-start': 'error' } },
  { files: [`${HOST_SRC}/**/*.ts`], ignores: ['**/*.test.ts', '**/*test-helpers.ts'], rules: { 'guard/no-hand-coded-error': 'error', 'guard/purge-callers': 'error', 'guard/subagent-purge-callers': 'error' } },
  { files: [`${HOST_SRC}/**/*.tsx`], ignores: ['**/*.test.tsx', '**/*test-helpers.tsx'], rules: { 'guard/purge-callers': 'error', 'guard/subagent-purge-callers': 'error' } },
  { files: ['packages/platform/src/mock/*.ts'], ignores: ['**/*.test.ts'], rules: { 'guard/no-hand-coded-error': 'error' } },
  // The app runtime does not lean on what carries it; the external app runtime borrows only the named physics modules
  {
    files: [`${HOST_SRC}/apps/**/*.{ts,tsx}`],
    rules: { 'guard/import-boundary': ['error', { forbidden: ['(^|/)sessions(/|$)'], why: 'the orchestrator is one caller of the runtime, and the runtime must not lean on it the other way around (#97)' }] },
  },
  {
    files: [`${HOST_SRC}/apps/external/**/*.{ts,tsx}`],
    rules: {
      'guard/import-boundary': [
        'error',
        {
          forbidden: ['(^|/)(sessions|adapters)(/|$)', '(^|/)dev-services/'],
          unless: ['(^|/)dev-services/(watch|path-guard|kill-tree|grouped-child|data-folder)\\.js$'],
          why: 'the external app runtime borrows only watch, path-guard, kill-tree, grouped-child and data-folder from dev-services; the store is reached through ExternalAppsDeps',
        },
      ],
    },
  },
  { files: ['packages/protocol/src/**/*.ts'], ignores: ['**/*.test.ts'], rules: { 'guard/no-tool-names': 'error' } },
  { files: [`${HOST_SRC}/adapters/{acp,frames,cursor-agent}/*.test.ts`], rules: { 'guard/no-sleeps': 'error' } },
].map((config) => ({ ...config, plugins: { guard: guards } }))

export default guards
