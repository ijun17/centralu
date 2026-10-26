/**
 * `guard/*`, the second set (#1607): guards that were unit tests parsing every source file of a folder with the
 * TypeScript API. ESLint already parses each of those files once per run; these are rules over the same tree, so the
 * test's second parse, on every OS, is gone. The first set and the shared parts are tooling/eslint-guards.js and
 * tooling/eslint-guard-kit.js; what each lets through is tooling/guard-exceptions.js.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { ARCHIVE_ALLOWED } from './guard-exceptions.js'
import { guard, relativeFile } from './eslint-guard-kit.js'
import { constInit } from './eslint-const-init.js'
import { noDisable } from './no-disable-rules.js'

/** The children of a node, by the keys the parser says it has */
const childrenOf = (sourceCode, node) =>
  (sourceCode.visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = node[key]
    return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []
  })

/**
 * The session archive is never called "trash" in words a person or an agent reads (#1404): in a string, a template or JSX
 * text. Not a comment, an identifier, an import or a test id. ARCHIVE_ALLOWED (tooling/guard-exceptions.js) lists the
 * parts of a text that may say it, the operating system's bin and the names the protocol and the store keep.
 */
/**
 * The visitors both archive rules share: `word(node, text)` for a text that still says trash once the allowed parts are taken
 * out, and `use(index, node)`, once per file, for each ARCHIVE_ALLOWED entry a text of the file used.
 */
function archiveVisitors(context, word, use) {
  const source = context.sourceCode
  const file = relativeFile(context)
  const allowed = ARCHIVE_ALLOWED.map((a, index) => ({ ...a, index, fileRe: new RegExp(a.file), textRe: new RegExp(a.text, 'g') })).filter((a) => a.fileRe.test(file))
  const used = new Set()
  /** Whether a text still says trash once the allowed parts are taken out */
  const flagged = (text, node) => {
    let rest = text
    for (const a of allowed) {
      const left = rest.replace(a.textRe, '')
      if (left !== rest && !used.has(a.index)) {
        used.add(a.index)
        use(a.index, node)
      }
      rest = left
    }
    return /trash/i.test(rest)
  }
  const check = (node, text) => {
    if (text === null || text === undefined || !flagged(text, node)) return
    const ancestors = source.getAncestors(node)
    if (ancestors.some((a) => a.type === 'JSXAttribute' && /test-?id/i.test(source.getText(a.name)))) return
    word(node, text.replace(/\s+/g, ' ').trim().slice(0, 100))
  }
  return {
    Literal(node) {
      const parent = node.parent
      if (typeof node.value !== 'string' || ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'TSLiteralType', 'TSImportType'].includes(parent.type)) return
      check(node, node.value)
    },
    TemplateElement: (node) => check(node, node.value.cooked),
    JSXText: (node) => check(node, node.value),
  }
}

const archiveWording = guard('archive-wording', { word: "says \"trash\": what Centralu keeps is the session archive, not rubbish (docs/domain-model.md, #1404): word it as the archive, or list the text in ARCHIVE_ALLOWED if it is about the operating system's bin: «{{text}}»" }, (context, add) =>
  archiveVisitors(context, (node, text) => add(node, 'word', { text }), () => {}),
)

/**
 * Says which ARCHIVE_ALLOWED entries the files use, so that `pnpm lint` can tell an entry no file uses any more (its file was
 * renamed or deleted, or stopped saying it) over the whole run: one warning per entry and file, whose message is the entry's
 * index. Like `type-assertions` it is counted by tooling/lint.ts (`archiveUses`) and is not shown. A many-file entry that some
 * file still uses is only held by the ceiling in tooling/guards-checks.test.ts.
 */
const archiveAllowedUsed = guard('archive-allowed-used', { used: '{{index}}' }, (context, add) => archiveVisitors(context, () => {}, (index, node) => add(node, 'used', { index })))

/** A class that applies only in a state or a breakpoint (`hover:border`) */
const behindVariant = (token) => token.includes(':')
/** Inputs that are not a text field: a swatch, a box to tick, a slider. TextInput is not their look */
const NOT_TEXT = new Set(['checkbox', 'radio', 'color', 'range', 'file', 'hidden'])
/** Where each look lives now, for the message */
const USE = {
  button: 'Button (components/Button.tsx), or Segmented for one-of-several',
  input: 'TextInput or TextField (components/TextField.tsx)',
  badge: 'Badge (components/Badge.tsx)',
  capsule: 'Pill (components/Pill.tsx)',
}

/**
 * Shared looks stay shared (owner, 2026-10-18): a component outside packages/ui/src/components/ may not draw a button, a
 * text field, a small caps label or a capsule by hand. A look is read from the classes an element is given: every string
 * and template literal inside the `className` expression counts, and so does a `const` the expression names. Only whole
 * tokens match, and only the resting look: a class behind a variant (`hover:border`) is left out.
 *
 * - `button`: a `<button>` whose classes hold `border` and a `rounded…` radius. A framed text button is `Button`.
 * - `input`: an `<input>` with `border` of its own, unless its literal `type` is not text. A framed text field is `TextInput` or `TextField`.
 * - `badge`: any element with both `uppercase` and `text-2xs`, the small caps label that is `Badge`.
 * - `capsule`: any element with both `rounded-full` and `border`, the capsule that is `Pill`.
 */
const handMadeLooks = guard('hand-made-looks', { look: '{{tag}} draws the {{look}} look by hand: use {{use}}' }, (context, add) => {
  const source = context.sourceCode
  /** Every literal text inside an expression, following identifiers to the file's own consts */
  const literals = (node, seen = new Set()) => {
    const out = []
    const visit = (n) => {
      if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value)
      else if (n.type === 'TemplateLiteral') {
        n.quasis.forEach((q, i) => {
          out.push(q.value.cooked ?? '')
          if (n.expressions[i]) visit(n.expressions[i])
        })
        return
      } else if (n.type === 'Identifier' && !seen.has(n.name)) {
        const found = constInit(source, n, { anyKind: true })
        if (found && !found.pattern) {
          seen.add(n.name)
          out.push(...literals(found.init, seen))
        }
      }
      for (const child of childrenOf(source, n)) visit(child)
    }
    visit(node)
    return out
  }
  return {
    JSXOpeningElement(node) {
      const tag = source.getText(node.name)
      const typeAttr = node.attributes.find((a) => a.type === 'JSXAttribute' && source.getText(a.name) === 'type')
      // A literal `type="color"`; a type chosen at run time counts as a text field
      const inputType = typeAttr?.value?.type === 'Literal' && typeof typeAttr.value.value === 'string' ? typeAttr.value.value : null
      for (const attr of node.attributes) {
        if (attr.type !== 'JSXAttribute' || source.getText(attr.name) !== 'className' || !attr.value) continue
        const tokens = new Set(
          literals(attr.value)
            .join(' ')
            .split(/\s+/)
            .filter(Boolean)
            .filter((t) => !behindVariant(t)),
        )
        const rounded = [...tokens].some((t) => t === 'rounded' || t.startsWith('rounded-'))
        const looks = []
        if (tag === 'button' && tokens.has('border') && rounded) looks.push('button')
        if (tag === 'input' && tokens.has('border') && !(inputType && NOT_TEXT.has(inputType))) looks.push('input')
        if (tokens.has('uppercase') && tokens.has('text-2xs')) looks.push('badge')
        if (tokens.has('rounded-full') && tokens.has('border')) looks.push('capsule')
        for (const look of looks) add(node, 'look', { tag: `<${tag}>`, look, use: USE[look] }, look)
      }
    },
  }
})

/**
 * Counts the type assertions (`x as T`, `<T>x`; not `as const`) of shipped code, one finding each, so that
 * tooling/lint.ts can hold a ceiling per package (ASSERTIONS in tooling/lint-allowlist.ts). A warning of the guard pass, which no
 * comment configures, so none can hide one; tooling/lint.ts takes its messages out of what it shows.
 */
const typeAssertions = guard('type-assertions', { asserted: 'a type assertion (counted per package by `pnpm lint`; ASSERTIONS in tooling/lint-allowlist.ts)' }, (_context, add) => ({
  TSAsExpression(node) {
    const t = node.typeAnnotation
    if (!(t.type === 'TSTypeReference' && t.typeName.type === 'Identifier' && t.typeName.name === 'const')) add(node, 'asserted')
  },
  TSTypeAssertion: (node) => add(node, 'asserted'),
}))

const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?=\s|$)([\s\S]*)$/
const CONFIG = /^\s*eslint\s+([\s\S]*)$/
/**
 * No comment switches off a type-aware rule (`noDisable`, tooling/no-disable-rules.js): an `eslint-disable` naming one, an
 * `eslint-disable` naming no rule (it switches every rule off), or an inline configuration comment naming one. The rules of the guard
 * pass are not named here: that pass reads no comment, so none can turn one off. Every comment is read (`getAllComments`), in a
 * JSX child or before a closing brace as anywhere else. An eslint-disable is also refused by `pnpm lint` when it hides a finding (`disabledFindings`); this
 * finds the one that hides nothing yet, and the configuration comment, which hides nothing ESLint reports as suppressed.
 */
const noRuleSwitchComments = guard('no-rule-switch-comments', { switched: '{{what}}: check the value (a zod schema, a guard) instead of switching the rule off' }, (context, add) => ({
  Program() {
    for (const comment of context.sourceCode.getAllComments()) {
      const directive = DIRECTIVE.exec(comment.value)
      if (directive) {
        const rules = (directive[1] ?? '').split('--')[0]?.split(/[\s,]+/).filter(Boolean) ?? []
        if (rules.length === 0) add(comment, 'switched', { what: 'an eslint-disable naming no rule switches the type-aware rules off too' })
        for (const rule of rules) if (noDisable(rule)) add(comment, 'switched', { what: `an eslint-disable of ${rule}` })
        continue
      }
      const config = CONFIG.exec(comment.value)
      if (config && comment.type === 'Block') {
        for (const [, , rule = ''] of (config[1] ?? '').matchAll(/(["']?)([@\w/-]+)\1\s*:/g)) if (noDisable(rule)) add(comment, 'switched', { what: `a configuration comment for ${rule}` })
      }
    }
  },
}))

/** The names the protocol exports, read from its sources once: `export type|const|interface Name` */
let protocolNames = null
function protocolExports() {
  if (protocolNames) return protocolNames
  const dir = new URL('../packages/protocol/src/', import.meta.url)
  const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  protocolNames = new Set(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/test-helpers\.ts$/.test(f) && !f.includes('node_modules'))
      .flatMap((f) => [...strip(readFileSync(new URL(f, dir), 'utf8')).matchAll(/^export (?:type|const|interface) (\w+)/gm)].map((m) => m[1])),
  )
  return protocolNames
}

/** A shape the protocol declares is declared once (#428, docs/protocol.md §4): the host and the platform import it */
const protocolTypeCopies = guard('protocol-type-copies', { copy: "`{{name}}` is declared here under a name the protocol exports: import it (`import type`) and re-export it if callers use the local name, or give a type that only looks alike a name of its own (#428)" }, (_context, add) => {
  const check = (node) => {
    if (protocolExports().has(node.id.name)) add(node, 'copy', { name: node.id.name })
  }
  return { TSTypeAliasDeclaration: check, TSInterfaceDeclaration: check }
})

export const tsRules = { 'archive-wording': archiveWording, 'archive-allowed-used': archiveAllowedUsed, 'hand-made-looks': handMadeLooks, 'type-assertions': typeAssertions, 'no-rule-switch-comments': noRuleSwitchComments, 'protocol-type-copies': protocolTypeCopies }

const TESTS = ['**/*.test.{ts,tsx,mts}', '**/*test-helpers.ts']

/** The files each rule reads, as in tooling/eslint-guards.js; the two warnings are only counted, by tooling/lint.ts. */
export const tsConfigs = [
  // Where a person or an agent reads what the code says: not a comment, a test or a helper
  { files: ['packages/{ui,platform,protocol,agent-host}/src/**/*.{ts,tsx}'], ignores: ['**/*.test.{ts,tsx}', '**/*test-helpers.{ts,tsx}'], rules: { 'guard/archive-wording': 'error', 'guard/archive-allowed-used': 'warn' } },
  { files: ['packages/ui/src/**/*.tsx'], ignores: ['**/*.test.tsx', 'packages/ui/src/components/**'], rules: { 'guard/hand-made-looks': 'error' } },
  // Where the type-aware rules run (eslint.config.js TYPED_FILES)
  { files: ['packages/*/src/**/*.{ts,tsx,mts}', 'packages/*/scripts/**/*.mts', 'apps/*/src/**/*.{ts,tsx}', 'e2e/**/*.{ts,tsx,mts}', 'tooling/**/*.ts'], rules: { 'guard/no-rule-switch-comments': 'error' } },
  { files: ['packages/{agent-host,platform}/src/**/*.{ts,tsx}'], ignores: TESTS, rules: { 'guard/protocol-type-copies': 'error' } },
  // Counted, not shown (tooling/lint.ts): the type assertions of shipped code, and which ARCHIVE_ALLOWED entries the files use
  { files: ['packages/*/src/**/*.{ts,tsx,mts}', 'apps/*/src/**/*.{ts,tsx,mts}'], ignores: [...TESTS, '**/*.d.ts'], rules: { 'guard/type-assertions': 'warn' } },
]
