import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as client from './client.js'
import * as whole from './index.js'

/*
 * The UI's bundle takes the protocol through client.ts (#1648). Every schema in a module it reaches is in the bundle, whether the
 * UI parses it or not, so the modules that only the host reads must stay out of what client.ts imports, directly or through
 * another module. This follows the imports the way a bundler does: a type-only import costs nothing and is left out.
 */
const SOURCES = import.meta.glob<string>('./**/*.ts', { query: '?raw', import: 'default', eager: true })
const sources = new Map(Object.entries(SOURCES).map(([path, text]) => [path.replace(/^\.\//, ''), text]))

/** Modules the host alone reads, or that join everything: the client entry reaches none of them at run time */
const HOST_ONLY = ['index.ts', 'commands.ts', 'machines-hub.ts', 'client-frames.ts', 'commands/session-params.ts', 'commands/methods/methods-of.ts']

const METHODS = 'commands/methods/'
const methodFiles = (suffix: string): string[] => [...sources.keys()].filter((f) => f.startsWith(METHODS) && f.endsWith(suffix))

/** `spec` as imported from the module `from`, as a path under src/ */
function resolveImport(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1)
  for (const part of spec.replace(/\.js$/, '.ts').split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  }
  return parts.join('/')
}

/** The modules `entry` reaches by imports and re-exports that exist at run time, as paths under src/ */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const text = sources.get(file)
    if (text === undefined) throw new Error(`${file} is imported and is not a protocol source`)
    for (const st of ts.createSourceFile(file, text, ts.ScriptTarget.Latest).statements) {
      const isImport = ts.isImportDeclaration(st)
      if (!isImport && !ts.isExportDeclaration(st)) continue
      if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue
      if (isImport ? st.importClause?.isTypeOnly : st.isTypeOnly) continue
      // `import { type A, type B } from` and `export { type A } from` are gone from the output too
      const named = isImport ? st.importClause?.namedBindings : st.exportClause
      const onlyTypes =
        named !== undefined && (ts.isNamedImports(named) || ts.isNamedExports(named)) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly) && !(isImport && st.importClause?.name)
      if (!onlyTypes) visit(resolveImport(file, st.moduleSpecifier.text))
    }
  }
  visit(entry)
  return seen
}

describe('the protocol entry the UI bundles (client.ts)', () => {
  const hostOnly = [...HOST_ONLY, ...methodFiles('.params.ts')]

  it('names host-only modules that exist', () => {
    for (const f of hostOnly) expect(sources.has(f), f).toBe(true)
  })

  it('reaches none of the modules only the host reads', () => {
    expect([...reachable('client.ts')].filter((f) => hostOnly.includes(f))).toEqual([])
  })

  it('does see a host-only module that is imported at run time (the walk is not blind)', () => {
    expect(reachable('commands.ts').has('commands/methods/sessions.params.ts')).toBe(true)
    expect(reachable('index.ts').has('machines-hub.ts')).toBe(true)
  })

  it('reaches every result schema, so the UI reads every answer', () => {
    const reached = reachable('client.ts')
    for (const f of methodFiles('.results.ts')) expect(reached.has(f), f).toBe(true)
  })

  it('is part of the whole protocol: one definition per schema, nothing taken from the public surface', () => {
    const everything: Record<string, unknown> = { ...whole }
    for (const [name, value] of Object.entries(client)) expect(everything[name], name).toBe(value)
  })
})
