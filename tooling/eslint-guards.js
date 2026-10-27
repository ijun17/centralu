/**
 * `guard/*`: repository guards that were unit tests reading every source file of a folder (#1606, #1602).
 *
 * Each was a regular expression over the text of a whole package, run as a test: another parse of the same files
 * ESLint already reads once per run, on every OS, near the 5 s limit under load. Here each is a rule over the syntax
 * tree, so a comment or a string that merely mentions the thing is no longer a finding, and a spelling the regular
 * expression did not name (`cp.spawn`, a template literal, a name reached through a `const`) is.
 *
 * Which files each rule reads is `guardConfigs` below, which tooling/eslint-guard-pass.js runs: a pass of its own, over every
 * file kind the old tests read, in which no comment configures anything (`noInlineConfig`). What each lets through is
 * tooling/guard-exceptions.js, by rule and file, with a reason, so that list is the only way around one.
 *
 * Known gaps, shared: a name rebound through a `let`, a function that is handed what the rule looks for, and a
 * spelling that needs types (a `Reflect` call, an alias of an imported function).
 */
import { guard, keyOf, nameOf, plain, stringNodes, unwrap } from './eslint-guard-kit.js'
import { tsConfigs, tsRules } from './eslint-guards-ts.js'

/** `.split('/')` and `.join('/')`: a path taken apart on a hardcoded separator (#47) */
const noHandSplit = guard('no-hand-split', { hand: "`.{{method}}('/')` takes a path apart on a hardcoded separator: use wireSegments · wireBaseName · wireJoin from @cc/protocol (#47)" }, (_context, add) => ({
  CallExpression(node) {
    const method = nameOf(node.callee)
    if (node.callee.type !== 'MemberExpression' || (method !== 'split' && method !== 'join')) return
    if (node.arguments.length === 1 && plain(unwrap(node.arguments[0])) === '/') add(node, 'hand', { method })
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
  // `<Kbd isMac />`, `{ 'isMac': true }`, `x['isMac']`
  JSXIdentifier(node) {
    if (node.name === 'isMac') add(node, 'os', { what: 'isMac' })
  },
  Literal(node) {
    if (node.value === 'isMac' && (node.parent?.key === node || (node.parent?.type === 'MemberExpression' && node.parent.property === node))) add(node, 'os', { what: 'isMac' })
  },
}))

/** Keyboard key names (⌘, ⌥) are never written onto the screen (#32) */
const uiNoKeyGlyphs = guard('ui-no-key-glyphs', { glyph: 'a keyboard key name is written onto the screen: use <Kbd mod /> · <Kbd alt /> or useShortcut() (#32)' }, (_context, add) =>
  stringNodes((node, text) => {
    if (/[⌘⌥]/.test(text)) add(node, 'glyph')
  }),
)

/** What an expression starts with, as text: `13`, `'13px'`, `13 as const`, `1.5 + 'rem'` start with a digit; '' when it is not known */
function startOf(node) {
  const n = unwrap(node)
  if (n?.type === 'BinaryExpression') return startOf(n.left)
  if (n?.type === 'Literal') return typeof n.value === 'number' ? String(n.value) : typeof n.value === 'string' ? n.value : ''
  if (n?.type === 'TemplateLiteral') return n.quasis[0].value.cooked ?? ''
  return ''
}

const SIZE = /(?<![\w-])(?:text|leading)-\[[^\]\s]+\]/g
/** Type stays on the scale (#312 step 2): no arbitrary text size or line height, no number as a fontSize */
const uiTypeScale = guard('ui-type-scale', { size: '{{what}} is a size outside the type scale: use a token from styles/index.css, or add the exception with its reason to tooling/guard-exceptions.js' }, (_context, add) => ({
  ...stringNodes((node, text) => {
    for (const m of text.matchAll(SIZE)) {
      // text-[…] is also how a colour is written arbitrarily; only sizes are the scale's business
      if (m[0].startsWith('text-[') && !/^text-\[(?:[\d.]+|\$\{\})(px|rem|em)\]$/.test(m[0])) continue
      add(node, 'size', { what: m[0] }, m[0])
    }
  }),
  Property(node) {
    if (keyOf(node) !== 'fontSize') return
    if (/^\d/.test(startOf(node.value))) add(node, 'size', { what: 'fontSize: ' + startOf(node.value) }, 'fontSize')
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
      // `import cp = require('node:child_process')`
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference' && CHILD_PROCESS.test(plain(node.moduleReference.expression) ?? '')) add(node, 'unnamed')
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
              (a) => a.type === 'ObjectExpression' && a.properties.some((p) => keyOf(p) === 'windowsHide' && !(unwrap(p.value).type === 'Literal' && unwrap(p.value).value === false)),
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
    const first = plain(unwrap(node.arguments[0]))
    if ((callee === 'programPath' && first === 'git') || (GIT_STARTERS.has(callee) && /^git(?:\.exe)?$/.test(first ?? ''))) add(node, 'git')
  },
}))

/** A coded error is built by one function (#850), not by `Object.assign(new Error(…), { code: 'x' })` */
const noHandCodedError = guard('no-hand-coded-error', { coded: 'a coded error is assembled by hand: build it with rpcError (host) or mockError (mock), which type the code (#850)' }, (_context, add) => ({
  CallExpression(node) {
    const callee = node.callee
    if (callee.type !== 'MemberExpression' || callee.computed || nameOf(callee.object) !== 'Object' || nameOf(callee) !== 'assign') return
    const [first, ...rest] = node.arguments
    const target = unwrap(first)
    if (target?.type !== 'NewExpression' || nameOf(target.callee) !== 'Error') return
    for (const arg of rest) {
      const source = unwrap(arg)
      if (source?.type !== 'ObjectExpression') continue
      // `{ code: 'internal' }`, also `as const` or `satisfies`: a protocol code is lower case (an errno such as 'ENOENT' is not one)
      if (source.properties.some((p) => keyOf(p) === 'code' && /^[a-z_]+$/.test(plain(unwrap(p.value)) ?? ''))) add(node, 'coded')
    }
  },
}))

/** The name a property is written with, plainly (`name`, `'name'`, `['name']`); null when it is not known */
const propertyName = (property) => {
  const key = property.key
  if (property.computed) return plain(key)
  return key.type === 'Identifier' ? key.name : plain(key)
}

/**
 * A rule that lets only the listed files reach certain methods. It follows the *property*, not a call shape: `x.name`,
 * `x['name']`, `x?.name`, `x.name.bind(x)(…)`, `.call`, `.apply`, `const { name } = x`, and the name written as a string
 * anywhere (`Reflect.get(x, 'name')`, `const k = 'name'; x[k]`) are all references. A method written `a.b` (a store's
 * `subagentSteps.purge`) is the property `b` of something named `a`. What a file may reach is a count per kind (the receiver's
 * text, `{name}` for a destructuring, `'name'` for a string), in tooling/guard-exceptions.js.
 */
const callersOf = (name, methods, what, rule) => {
  const paths = methods.map((m) => m.split('.'))
  const bare = new Set(paths.filter((p) => p.length === 1).map((p) => p[0]))
  const nested = paths.filter((p) => p.length === 2)
  /** Is `last`, taken from something named `holder`, one of the methods? */
  const listed = (last, holder) => bare.has(last) || nested.some(([h, l]) => l === last && h === holder)
  return guard(name, { caller: `{{callee}} reaches the call that deletes ${what} for good: ${rule}; a reference is listed with its reason in tooling/guard-exceptions.js` }, (context, add) => {
    const text = (n) => context.sourceCode.getText(n).replace(/\s+/g, '').replace(/\?\./g, '.')
    /** What a destructuring pattern takes its properties from: the name of the initializer, or of the property it is nested in */
    const sourceOf = (pattern) => {
      const parent = pattern.parent
      if (parent.type === 'VariableDeclarator') return nameOf(unwrap(parent.init))
      if (parent.type === 'AssignmentExpression') return nameOf(unwrap(parent.right))
      if (parent.type === 'Property' && parent.parent.type === 'ObjectPattern') return propertyName(parent)
      return null
    }
    return {
      MemberExpression(node) {
        const prop = nameOf(node)
        if (prop !== null && listed(prop, nameOf(node.object))) add(node, 'caller', { callee: `${text(node.object)}.${prop}` }, `${text(node.object)}.${prop}`)
      },
      'ObjectPattern > Property'(node) {
        const prop = propertyName(node)
        if (prop !== null && listed(prop, sourceOf(node.parent))) add(node, 'caller', { callee: `{${prop}}` }, `{${prop}}`)
      },
      // The name as a string that is not a property key or a type: `Reflect.get(mgr, 'purgeSession')`, `const k = 'purgeSession'`
      'Literal, TemplateLiteral'(node) {
        const value = plain(node)
        if (value === null || !bare.has(value)) return
        const parent = node.parent
        if (parent.type === 'MemberExpression' && parent.property === node) return // counted as the member
        if (parent.key === node || parent.type === 'TSLiteralType') return // a definition, a destructuring (counted above) or a type
        add(node, 'caller', { callee: `'${value}'` }, `'${value}'`)
      },
    }
  })
}
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
    // `import('x').Name` and `typeof import('x')` in a type
    TSImportType: (node) => {
      const arg = node.source ?? node.argument // `argument` is the older name
      check(node, plain(arg?.type === 'TSLiteralType' ? arg.literal : arg))
    },
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
    // `#claude`, `<Claude />`
    PrivateIdentifier(node) {
      if (re.test(node.name)) add(node, 'tool', { text: '#' + node.name })
    },
    JSXIdentifier(node) {
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
  // `page['waitForTimeout'](5)`
  MemberExpression(node) {
    if (node.computed && plain(node.property) === 'waitForTimeout') add(node, 'sleep', { what: 'waitForTimeout' })
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
    ...tsRules,
  },
}

// A test and its helpers (`x.test-helpers.ts`), as the tests these guards were read them; a `test-helpers.ts` is a source
const TESTS = ['**/*.test.ts', '**/*.test-helpers.ts']
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
  { files: [`${HOST_SRC}/**/*.{ts,mts,js,mjs,cjs}`], ignores: [...TESTS, '**/*.d.ts', '**/test-fixtures/**', '**/node_modules/**'], rules: { 'guard/hidden-children': 'error' } },
  { files: [`${HOST_SRC}/**/*.{ts,mts,js,mjs}`], ignores: TESTS, rules: { 'guard/git-start': 'error' } },
  { files: [`${HOST_SRC}/**/*.ts`], ignores: TESTS, rules: { 'guard/no-hand-coded-error': 'error', 'guard/purge-callers': 'error', 'guard/subagent-purge-callers': 'error' } },
  { files: [`${HOST_SRC}/**/*.tsx`], ignores: ['**/*.test.tsx', '**/*.test-helpers.tsx'], rules: { 'guard/purge-callers': 'error', 'guard/subagent-purge-callers': 'error' } },
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
  // What the screen bundles reaches the protocol through its client entry, which leaves the host-only schemas out (#1648)
  {
    files: [...UI, 'packages/platform/src/**/*.{ts,tsx}', 'packages/core/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.test-helpers.{ts,tsx}'],
    rules: {
      'guard/import-boundary': [
        'error',
        {
          forbidden: ['^@cc/protocol$'],
          why: "the UI's bundle takes the protocol through '@cc/protocol/client', which leaves out the schemas only the host reads; the whole of '@cc/protocol' puts them back (#1648)",
        },
      ],
    },
  },
  { files: [`${HOST_SRC}/adapters/{acp,frames,cursor-agent}/*.test.ts`], rules: { 'guard/no-sleeps': 'error' } },
  ...tsConfigs,
].map((config) => ({ ...config, plugins: { guard: guards } }))

export default guards
