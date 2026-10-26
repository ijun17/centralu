/**
 * Resolving a name to what it was given, for the lint rules that read a test file's syntax: `const KEY = 'CC_DATA_DIR'`,
 * `const LIMIT = 30_000 * SLOW`, `const env = process.env`. Only a `const` with a single definition is followed (a
 * `let` can be anything by the time it is read), and only a few steps (a chain of aliases is not a mystery).
 */

/** The variable `identifier` refers to, looked up from where it is written; null when no scope knows it */
export function variableOf(sourceCode, identifier) {
  for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name)
    if (variable) return variable
  }
  return null
}

/**
 * What the `const` an identifier names was initialised with (the expression after `=`), or null for anything else: a
 * `let`, a parameter, an import, a global, a pattern. `{ env }` taken out of an object is `{ pattern: Property, init }`:
 * the caller decides what that says.
 */
export function constInit(sourceCode, identifier) {
  const variable = variableOf(sourceCode, identifier)
  if (variable?.defs.length !== 1) return null
  const [def] = variable.defs
  if (def.type !== 'Variable' || def.parent?.kind !== 'const' || !def.node.init) return null
  if (def.node.id.type === 'Identifier') return { init: def.node.init, pattern: null }
  if (def.node.id.type !== 'ObjectPattern') return null
  // `const { env } = process` or `const { env: e } = process`
  const pattern = def.node.id.properties.find((p) => p.type === 'Property' && !p.computed && p.value.type === 'Identifier' && p.value.name === identifier.name)
  return pattern ? { init: def.node.init, pattern } : null
}
