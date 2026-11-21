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
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { guard, keyOf, nameOf, plain, relativeFile, stringNodes, unwrap } from './eslint-guard-kit.js'
import { COMMENT_SHARE_HELD, COMMENTS_LEFT } from './guard-exceptions.js'
import { variableOf } from './eslint-const-init.js'
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

/** Every child the host starts is hidden (docs/runtime-lessons/who-starts-what.md ST13, #983) */
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

/** What may be asked `--version` or `--help` by `child_process` directly: each answers from its own binary, with no network, sign-in or first-run work to wait on */
const PROBE_FREE = /^(?:git|node|gpgv)(?:\.exe)?$/

/** What host code may run through `runSync` / `execTextSync` (#2370): each starts no program of its own, so a limit that ends the pid ends all of it */
const STARTS_NOTHING = /^(?:ps|reg|plutil)(?:\.exe)?$/

/**
 * A program that is given a time limit ends with the whole tree it started (`os.processes.run`, `OsProcesses.stop`), never by
 * `execFile`'s `timeout:`: that signals the pid only, and what a `.cmd` shim's `cmd.exe` started goes on running. A call to a
 * `child_process` starter (or to what `promisify` made of one) with `timeout` in its options is reported, and so is an exec-family one whose
 * options spread another object (`{ ...DEFAULTS }`): a `timeout` in what is spread cannot be seen here (`timed`; off with `{ timed: false }`).
 *
 * A program asked its version or help (`--version`, `--version=…`, `--help`; `-v` or `version` as its first argument) through a `child_process` starter, or
 * through `runSync` / `execTextSync` (whose limit ends the pid only), is reported too (`probe`, #2346): in a literal argument list,
 * or in a literal command line (`exec('x --version')`). A tool's CLI can wait on a sign-in, the network or its first run, and with
 * no limit nothing ends it; `execText` (os/exec.ts) bounds it and ends its tree. `PROBE_FREE` and `process.execPath` are let
 * through. Arguments held in a variable, a command line built by interpolation and a starter imported under another name are
 * not seen.
 *
 * In host code, `runSync` and `execTextSync` run only a program named in `STARTS_NOTHING`, written as a literal (a path's last
 * part counts) or as `systemTool([…, name])` (`sync`; off with `{ sync: false }`): a synchronous run cannot end a tree without
 * blocking the host for a process-table read, so it is kept to programs that leave none. `execTextSync` in os/exec.ts,
 * which hands its own parameter on, is not read; its callers are. Not seen: a runner imported under another name or kept
 * in a variable (`const run = os.processes.runSync`).
 */
const timedStart = guard('timed-start', {
  timed: "'timeout' (or options spread from elsewhere, which may carry one) on a started program ends its pid only, and what it started runs on: use os.processes.run with timeoutMs (os/exec.js execText for a short question)",
  probe: 'a program asked its version or help through child_process or runSync can wait forever (a sign-in, the network, a first run) and nothing ends it: use execText (os/exec.js), which bounds it and ends its tree',
  sync: "runSync and execTextSync end the pid only, so they run only a program that starts nothing (STARTS_NOTHING in tooling/eslint-guards.js, by name): use os.processes.run or execText (os/exec.js), which end the tree",
}, (context, add) => {
  const timed = (context.options[0] ?? {}).timed !== false
  const sync = (context.options[0] ?? {}).sync !== false
  // The layer's synchronous runners: their limit ends the pid only (os/exec.ts `execTextSync`)
  const pidOnly = new Set(['runSync', 'execTextSync'])
  const startsNothing = (node) => {
    const command = unwrap(node)
    const named = command?.type === 'CallExpression' && nameOf(command.callee) === 'systemTool' && unwrap(command.arguments[0])?.type === 'ArrayExpression'
      ? plain(unwrap(unwrap(command.arguments[0]).elements.at(-1)))
      : plain(command)
    return STARTS_NOTHING.test((named ?? '').split(/[\\/]/).at(-1) ?? '')
  }
  /** `command` is a parameter of `execTextSync` in os/exec.ts, which hands it on to `runSync` */
  const handedOn = (node, command) => {
    if (command?.type !== 'Identifier' || !/[\\/]os[\\/]exec\.ts$/.test(context.filename)) return false
    let fn = node.parent
    while (fn && !/Function/.test(fn.type)) fn = fn.parent
    return !!fn && pidOnly.has(fn.id?.name) && fn.params.some((p) => p.type === 'Identifier' && p.name === command.name)
  }
  const made = new Set() // `const exec = promisify(execFile)`
  const probeFree = (node) => {
    const command = unwrap(node)
    if (command?.type === 'MemberExpression' && nameOf(command.object) === 'process' && nameOf(command) === 'execPath') return true
    return PROBE_FREE.test((plain(command) ?? '').trim().split(/\s+/)[0] ?? '')
  }
  const PROBE_FLAG = /^(?:--version(?:=.*)?|--help)$/
  // Only as the first argument, where they are the question (`npm -v`, `go version`); later, `version` is a field (`npm view x version`)
  const PROBE_FIRST = /^(?:-v|version)$/
  const probing = (word, at) => PROBE_FLAG.test(word) || (at === 0 && PROBE_FIRST.test(word))
  return {
    VariableDeclarator(node) {
      const init = node.init && unwrap(node.init)
      if (init?.type === 'CallExpression' && nameOf(init.callee) === 'promisify' && node.id.type === 'Identifier' && GIT_STARTERS.has(nameOf(unwrap(init.arguments[0]) ?? init))) made.add(node.id.name)
    },
    CallExpression(node) {
      const callee = nameOf(node.callee)
      const starter = GIT_STARTERS.has(callee) || made.has(callee)
      if (!starter && !pidOnly.has(callee)) return
      const line = plain(unwrap(node.arguments[0])) ?? ''
      const asked =
        node.arguments.some((a) => a.type === 'ArrayExpression' && a.elements.some((e, at) => e && probing(plain(unwrap(e)) ?? '', at))) ||
        line.trim().split(/\s+/).slice(1).some((word, at) => probing(word, at))
      if (asked && !probeFree(node.arguments[0])) add(node, 'probe')
      else if (sync && pidOnly.has(callee) && !startsNothing(node.arguments[0]) && !handedOn(node, unwrap(node.arguments[0]))) add(node, 'sync')
      if (!timed || !starter) return
      for (const a of node.arguments) {
        if (a.type === 'ObjectExpression' && a.properties.some((p) => (p.type === 'SpreadElement' && callee !== 'spawn') || (p.type === 'Property' && keyOf(p) === 'timeout'))) add(node, 'timed')
      }
    },
  }
})

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

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises'])
const HELD_CALLS = new Set(['rm', 'rmSync', 'rename', 'renameSync'])
/**
 * A rename or an `rm` goes through the `Os` (`os.files`, `realOs().files`), whose real one tries again what Windows holds
 * for a moment (os/held.ts, #2161): Node's own, imported by name or called on the module, refuses at the first hold. The
 * module's `promises` (`fs.promises.rm`) is a spelling not seen.
 */
const heldFiles = guard('held-files', { held: "'{{name}}' from node:fs refuses a file Windows holds for a moment: rename and remove through the Os (os.files, realOs().files), which tries again (os/held.ts, #2161)" }, (_context, add) => {
  const namespaces = new Set()
  const named = (n) => (n.type === 'Identifier' ? n.name : plain(n))
  return {
    ImportDeclaration(node) {
      if (!FS_MODULES.has(plain(node.source)) || node.importKind === 'type') return
      for (const s of node.specifiers) {
        if (s.type !== 'ImportSpecifier') namespaces.add(s.local.name)
        else if (s.importKind !== 'type' && HELD_CALLS.has(named(s.imported))) add(s, 'held', { name: named(s.imported) })
      }
    },
    MemberExpression(node) {
      const name = node.computed ? plain(node.property) : named(node.property)
      if (node.object.type === 'Identifier' && namespaces.has(node.object.name) && HELD_CALLS.has(name)) add(node, 'held', { name })
    },
  }
})

const PATH_RULES = new Set(['pathKey', 'samePath', 'expandHome'])
const TILDE = new Set(['~/', '~' + String.fromCharCode(92)])
/**
 * How two paths compare and what a leading `~` is are each written once, in os/rules.ts (#847, #2160): a second `pathKey`,
 * `samePath` or `expandHome` exported elsewhere, a `startsWith('~/')` and a `/^~…/` pattern are copies that drift.
 */
const onePathRule = guard('one-path-rule', { copy: "{{what}} is a copy of a path rule: use pathKey, samePath, isInside or expandHome from os/rules.ts (#2160)" }, (_context, add) => {
  const exported = (node, name) => PATH_RULES.has(name) && add(node, 'copy', { what: `an exported '${name}'` })
  return {
    ExportNamedDeclaration(node) {
      const d = node.declaration
      if (d?.type === 'FunctionDeclaration' && d.id) exported(d.id, d.id.name)
      if (d?.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier') exported(v.id, v.id.name)
      for (const s of node.specifiers ?? []) if (s.exported.type === 'Identifier') exported(s, s.exported.name)
    },
    CallExpression(node) {
      if (node.callee.type === 'MemberExpression' && nameOf(node.callee.property) === 'startsWith' && TILDE.has(plain(node.arguments[0]))) add(node, 'copy', { what: "startsWith('~/')" })
    },
    Literal(node) {
      if (node.regex?.pattern.startsWith('^~')) add(node, 'copy', { what: `/${node.regex.pattern}/` })
    },
  }
})

/**
 * Comments say what the code cannot: a platform rule, a race, a measured number, why a check exists (#2355, the owner's
 * decision of 2026-11-21; CONTRIBUTING.md "What is expected of code"). In a folder whose comments are swept this reports
 * history ("used to", not the passive "is used to"; a sentence opening with "Previously"; a "#N review" tag), a file header over 3
 * lines of text, a comment block over COMMENT_BLOCK_LINES lines of text, a source file over COMMENT_SHARE comment lines,
 * and a paragraph that runs two list items into its text (#2406). Adjacent line comments are one block.
 */
const ADVERB = String.raw`(?:\w+ly|only|also|not|just|still|never|often|then|always|now|all|both|again|even|too)`
const HISTORY = [
  new RegExp(String.raw`(?<!\b(?:is|are|was|were|be|been|being|get|gets|got|'s)[\s*]+(?:${ADVERB}[\s*]+)?)\bused[\s*]+to\b`, 'gi'),
  /(?:^[\s*]*|[.!?;:][\s*]+|\n[\s*]*-[\s*]+)(Previously)\b/g,
  /#\d+[\s*]+review\b/gi,
]
/**
 * An item marker after other text on its line: a `- `, or a `-` ending the line (a list re-wrapped as a paragraph puts its
 * markers anywhere), and `N. ` (`3-5` and the sum `n - 30` are none). Two spaced dashes of punctuation in one paragraph read
 * as a list too.
 */
const INLINE_DASH = /(?<=\S\s+)-(?:\s+(?=[^\s\d])|$)/g
const INLINE_NUMBER = /(?<=\S\s+)\d+\.\s+(?=[^\s\d])/g
/** A line that is an item itself (`- `, `N. `, `@param`): its `- name - what` counts within the line alone */
const ITEM_LINE = /^(?:-|\d+\.|@\w+)\s/

/**
 * The paragraphs of a comment's text that run two list items into their text: the line (from 0) of the first, and how many.
 * `N. ` counts only when one line holds two, as a sentence may end in a number.
 */
function listsRunIn(text) {
  const found = []
  let first = -1
  let n = 0
  for (const [i, line] of [...text.split('\n'), ''].entries()) {
    const body = line.replace(/^[\s*/]+/, '').trimEnd()
    const numbers = body.match(INLINE_NUMBER)?.length ?? 0
    const items = (body.match(INLINE_DASH)?.length ?? 0) + (numbers >= 2 ? numbers : 0)
    if (ITEM_LINE.test(body)) {
      if (items >= 2) found.push({ line: i, n: items })
    } else if (items > 0) {
      if (first < 0) first = i
      n += items
    }
    if (body) continue
    if (n >= 2) found.push({ line: first, n })
    first = -1
    n = 0
  }
  return found
}
const HEADER_LINES = 3
const COMMENT_BLOCK_LINES = 10
const COMMENT_SHARE = 0.35
/** Below this many lines a file's share says little: two comments in a six-line file are a third of it */
const SHARE_FROM_LINES = 30
/** A file's lines that hold only a comment, and its lines that hold code or a comment: the share `guard/comments` holds */
export function commentShare(source) {
  const code = new Set()
  for (const t of source.ast.tokens) for (let l = t.loc.start.line; l <= t.loc.end.line; l++) code.add(l)
  const comment = new Set()
  for (const c of source.getAllComments()) for (let l = c.loc.start.line; l <= c.loc.end.line; l++) if (!code.has(l) && source.lines[l - 1].trim()) comment.add(l)
  return { comment: comment.size, lines: code.size + comment.size }
}

/** `commentShare` of a TypeScript or JavaScript text, outside a lint run; `file` names its kind (`.tsx` parses JSX) */
export function commentShareOf(text, file = 'x.ts') {
  let share = { comment: 0, lines: 0 }
  const rule = { create: (context) => ({ Program: () => void (share = commentShare(context.sourceCode)) }) }
  new Linter().verify(text, [{ files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'], languageOptions: { parser: tseslint.parser }, plugins: { share: { rules: { of: rule } } }, rules: { 'share/of': 'error' } }], file)
  return share
}
const isTestFile = (file) => /\.test\.|test-helpers\./.test(file)
const at = (line) => ({ loc: { start: { line, column: 0 }, end: { line, column: 0 } } })
const comments = guard(
  'comments',
  {
    history: '"{{text}}" tells history: say what the code does and why, now; git and the issues keep the history (#2355)',
    list: 'this paragraph runs {{n}} list items into its text: put one item per line (#2406)',
    header: 'the file header is {{n}} lines: at most 3 say what the file is; the rest goes to a document or away (#2355)',
    block: 'a {{n}}-line comment: keep what the code cannot carry in at most {{max}} lines, and point to the document or runtime-lessons rule for the rest (#2355)',
    share: '{{pct}}% of this file is comment lines (at most {{max}}%): delete what restates the code, point to documents for the rest (#2355)',
  },
  (context, add) => ({
    Program(program) {
      const source = context.sourceCode
      const groups = []
      // A comment after code on its line stands alone: trailing notes on consecutive lines are not one block
      const ownLine = (c) => (source.getTokenBefore(c)?.loc.end.line ?? 0) < c.loc.start.line
      for (const c of source.getAllComments()) {
        const last = groups.at(-1)
        if (c.type === 'Line' && last?.type === 'Line' && last.ownLine && ownLine(c) && last.end === c.loc.start.line - 1) {
          last.text += '\n' + c.value
          last.end = c.loc.end.line
        } else groups.push({ type: c.type, ownLine: ownLine(c), text: c.value, start: c.loc.start.line, end: c.loc.end.line })
      }
      for (const g of groups) {
        for (const re of HISTORY) {
          for (const m of g.text.matchAll(re)) {
            const from = m.index + m[0].length - (m[1] ?? m[0]).length
            add(at(g.start + (g.text.slice(0, from).match(/\n/g)?.length ?? 0)), 'history', { text: (m[1] ?? m[0]).replace(/[\s*]+/g, ' ').trim() }, 'history')
          }
        }
        for (const { line, n } of listsRunIn(g.text)) add(at(g.start + line), 'list', { n }, 'list')
      }
      const firstCode = program.tokens[0]?.loc.start.line ?? Infinity
      for (const [i, g] of groups.entries()) {
        // Lines of text: a `/**` or ` */` line alone carries none
        const n = g.text.split('\n').filter((l) => /[^\s*/]/.test(l)).length
        // A header stands apart from the code; a doc right on the first declaration is that declaration's
        if (i === 0 && g.end < firstCode - 1 && !source.lines[g.end].trim()) {
          if (n > HEADER_LINES) add(at(g.start), 'header', { n }, 'header')
        } else if (n > COMMENT_BLOCK_LINES) add(at(g.start), 'block', { n, max: COMMENT_BLOCK_LINES }, 'block')
      }
      if (isTestFile(context.filename)) return
      const { comment, lines } = commentShare(source)
      if (lines < SHARE_FROM_LINES) return
      const pct = Math.round((100 * comment) / lines)
      const held = COMMENT_SHARE_HELD.files[relativeFile(context)]
      const max = held ?? Math.round(100 * COMMENT_SHARE)
      if (pct > max) add(at(1), 'share', { pct, max }, 'share')
    },
  }),
)

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

/**
 * The Assistant's kind as this build sends it, and the constant naming it (#2133). Not `'assistant'`: a chat row's and a
 * message's `kind` say that too, and without types the rule cannot tell them apart; nothing compares a session's kind to
 * the new value but `isAssistantKind`, which this rule sends every reader to
 */
const ASSISTANT_KIND_VALUES = new Set(['orchestrator'])
/** Whether `id` names what was taken out of an object's `kind`: `({ kind }) => …`, `const { kind: k } = s` */
const isDestructuredKind = (sourceCode, id) => {
  const variable = variableOf(sourceCode, id)
  if (variable?.defs.length !== 1) return false
  const property = variable.defs[0].name.parent
  return property?.type === 'Property' && property.parent?.type === 'ObjectPattern' && !property.computed && keyOf(property) === 'kind'
}
/** A read of a session's kind: `x.kind`, `x?.kind`, or a name destructured from an object's `kind` */
const isKindRead = (sourceCode, node) => {
  const u = unwrap(node)
  // `s?.kind` is a chain around the member
  const n = u?.type === 'ChainExpression' ? u.expression : u
  if (n?.type === 'Identifier') return isDestructuredKind(sourceCode, n)
  return n?.type === 'MemberExpression' && nameOf(n) === 'kind'
}
const isAssistantKindValue = (node) => {
  const n = unwrap(node)
  return ASSISTANT_KIND_VALUES.has(plain(n)) || (n?.type === 'Identifier' && n.name === 'ASSISTANT_KIND')
}
/** The Assistant value among a list written in place (`['orchestrator', …]`), or undefined */
const assistantValueIn = (node) => {
  const n = unwrap(node)
  return n?.type === 'ArrayExpression' ? n.elements.find((e) => e && isAssistantKindValue(e)) : undefined
}
const valueName = (node) => plain(unwrap(node)) ?? 'ASSISTANT_KIND'

/**
 * A session's kind is compared to one Assistant value by hand (#2133): `x.kind === 'orchestrator'` misses the
 * `'assistant'` a later release sends, so every reader asks `isAssistantKind` (@cc/protocol). Read as a comparison, a
 * `case`, `[…].includes(kind)`, `new Set([…]).has(kind)` and `{ orchestrator: … }[kind]`, where the list, set or object
 * is written in place. Known gaps: a list, set or object held in a name (`KINDS.includes(s.kind)`), and a kind passed
 * on under another name than `kind` before it is compared
 */
const assistantKind = guard('assistant-kind', { hand: "a session's kind is compared to {{value}} by hand: ask isAssistantKind(…) from @cc/protocol, which knows both of the Assistant's kind values (#2133)" }, (context, add) => {
  const kindRead = (node) => isKindRead(context.sourceCode, node)
  return {
    BinaryExpression(node) {
      if (!['===', '!==', '==', '!='].includes(node.operator)) return
      const [kind, value] = kindRead(node.left) ? [node.left, node.right] : [node.right, node.left]
      if (kindRead(kind) && isAssistantKindValue(value)) add(node, 'hand', { value: valueName(value) })
    },
    SwitchStatement(node) {
      if (!kindRead(node.discriminant)) return
      for (const c of node.cases) if (c.test && isAssistantKindValue(c.test)) add(c, 'hand', { value: valueName(c.test) })
    },
    // `['orchestrator', 'coordinator'].includes(s.kind)`, `new Set(['orchestrator']).has(s.kind)`
    CallExpression(node) {
      const callee = unwrap(node.callee)
      if (callee?.type !== 'MemberExpression' || node.arguments.length !== 1 || !kindRead(node.arguments[0])) return
      const method = nameOf(callee)
      const list = unwrap(callee.object)
      const found =
        method === 'includes' ? assistantValueIn(list)
        : method === 'has' && list?.type === 'NewExpression' && nameOf(list.callee) === 'Set' ? assistantValueIn(list.arguments[0])
        : undefined
      if (found) add(node, 'hand', { value: valueName(found) })
    },
    // `({ orchestrator: … })[s.kind]`
    MemberExpression(node) {
      if (!node.computed || !kindRead(node.property)) return
      const object = unwrap(node.object)
      if (object?.type !== 'ObjectExpression') return
      const key = object.properties.find((p) => p.type === 'Property' && !p.computed && ASSISTANT_KIND_VALUES.has(keyOf(p)))
      if (key) add(node, 'hand', { value: keyOf(key) })
    },
  }
})

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
    'timed-start': timedStart,
    'no-hand-coded-error': noHandCodedError,
    'purge-callers': purgeCallers,
    'subagent-purge-callers': subagentPurgeCallers,
    'import-boundary': importBoundary,
    'no-tool-names': noToolNames,
    'no-sleeps': noSleeps,
    'assistant-kind': assistantKind,
    'held-files': heldFiles,
    'one-path-rule': onePathRule,
    comments,
    ...tsRules,
  },
}

// A test and its helpers (`x.test-helpers.ts`), as the tests these guards were read them; a `test-helpers.ts` is a source
const TESTS = ['**/*.test.ts', '**/*.test-helpers.ts']
const UI = ['packages/ui/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}', 'apps/desktop/src/**/*.{ts,tsx}']
const HOST_SRC = 'packages/agent-host/src'
/**
 * The folders of the host's source that guard/comments reads, and those it does not yet (#2355): a folder moves from the second
 * list to the first when its comments have been swept. The unit test requires every folder on disk to be in one of them.
 */
export const COMMENTS_SWEPT_HOST_FOLDERS = ['keeper', 'lifecycle', 'links', 'mail', 'os', 'sessions', 'transport', 'views']
export const COMMENTS_UNSWEPT_HOST_FOLDERS = ['adapters', 'apps', 'dev-services']
/** Where guard/comments reads: a folder joins when its comments have been swept (#2355) */
const COMMENTS_SWEPT = [
  'packages/{protocol,core,common,platform,ui}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}',
  'apps/web/**/*.{ts,tsx,mts,cts,js,mjs,cjs}',
  `${HOST_SRC}/*.ts`,
  `${HOST_SRC}/{${COMMENTS_SWEPT_HOST_FOLDERS.join(',')}}/**/*.ts`,
]

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
  /*
   * Not read: the files the OS layer is made of, which cannot ask it. `os/real.ts` is the layer (its `runSync` is spawnSync with
   * the caller's limit); `kill-tree.ts` is what its tree stop is made of (`ps`, PowerShell's process table, `taskkill`: each starts
   * nothing, and the layer stops through this file); `env-path.ts` (the login shell, in a session of its own whose whole group a
   * timeout ends) and `tool-launch.ts` are imported by the layer. `remote-install.mjs` runs on another machine and imports nothing.
   */
  {
    files: [`${HOST_SRC}/**/*.{ts,mts,js,mjs}`],
    ignores: [...TESTS, `${HOST_SRC}/os/real.ts`, `${HOST_SRC}/os/kill-tree.ts`, `${HOST_SRC}/env-path.ts`, `${HOST_SRC}/tool-launch.ts`, `${HOST_SRC}/links/remote-install.mjs`],
    rules: { 'guard/timed-start': 'error' },
  },
  // The scripts, tests and their helpers ask tools too (the drift checks, the measurements): a probe is read in them all (#2346)
  {
    files: ['scripts/**/*.{ts,mts,js,mjs}', 'packages/*/scripts/**/*.{ts,mts,js,mjs}', '**/*.test.ts', '**/*.test-helpers.ts', 'tooling/**/*.{ts,mts,js,mjs}', 'e2e/**/*.ts'],
    rules: { 'guard/timed-start': ['error', { timed: false, sync: false }] },
  },
  // The path rules are written in os/rules.ts alone
  { files: [`${HOST_SRC}/**/*.{ts,mts}`], ignores: [...TESTS, `${HOST_SRC}/os/rules.ts`], rules: { 'guard/one-path-rule': 'error' } },
  // The real Os is where Node's `rename` and `rm` are made to wait out a hold (os/held.ts); `rmdir` and `unlink` are not
  { files: [`${HOST_SRC}/**/*.{ts,mts}`], ignores: [...TESTS, `${HOST_SRC}/os/real.ts`], rules: { 'guard/held-files': 'error' } },
  { files: [`${HOST_SRC}/**/*.ts`], ignores: TESTS, rules: { 'guard/no-hand-coded-error': 'error', 'guard/purge-callers': 'error', 'guard/subagent-purge-callers': 'error' } },
  { files: [`${HOST_SRC}/**/*.tsx`], ignores: ['**/*.test.tsx', '**/*.test-helpers.tsx'], rules: { 'guard/purge-callers': 'error', 'guard/subagent-purge-callers': 'error' } },
  { files: ['packages/platform/src/mock/*.ts'], ignores: ['**/*.test.ts'], rules: { 'guard/no-hand-coded-error': 'error' } },
  // The app runtime does not lean on what carries it; the external app runtime borrows only the named physics modules
  {
    files: [`${HOST_SRC}/apps/**/*.{ts,tsx}`],
    rules: { 'guard/import-boundary': ['error', { forbidden: ['(^|/)sessions(/|$)'], why: 'the Assistant is one caller of the runtime, and the runtime must not lean on it the other way around (#97)' }] },
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
          forbidden: ['^@cc/protocol$', '(^|/)protocol/src/(?!client(\\.|$))'],
          why: "the UI's bundle takes the protocol through '@cc/protocol/client', which leaves out the schemas only the host reads; the whole of '@cc/protocol' puts them back (#1648)",
        },
      ],
    },
  },
  { files: [`${HOST_SRC}/adapters/{acp,frames,cursor-agent}/*.test.ts`], rules: { 'guard/no-sleeps': 'error' } },
  // Every shipped reader of a session's kind, on both sides of the wire (#2133)
  { files: ['packages/*/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'], ignores: ['**/*.test.{ts,tsx}', '**/*.test-helpers.{ts,tsx}'], rules: { 'guard/assistant-kind': 'error' } },
  // The folders whose comments have been swept (#2355); each sweep adds its own
  { files: COMMENTS_SWEPT, ignores: COMMENTS_LEFT, rules: { 'guard/comments': 'error' } },
  ...tsConfigs,
].map((config) => ({ ...config, plugins: { guard: guards } }))

export default guards
