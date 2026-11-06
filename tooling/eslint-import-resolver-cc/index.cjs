/**
 * Import resolver for eslint-plugin-boundaries (`import/resolver: { cc: {} }`). The plugin judges an import by the path it
 * resolves to. Node's resolver, its default, finds no `@cc/*` package (each exposes an `exports` map of `.ts` files) and
 * no `./x.js` that is `x.ts` on disk, so `boundaries/element-types` judged none of the imports the packages actually
 * use (#1847).
 *
 * This is a package of the workspace (linked from the root package.json) and named `eslint-import-resolver-<name>` on
 * purpose: eslint-module-utils looks a resolver up on every import it has not cached (a not-found one is never cached),
 * trying the conventional package name first, and a resolver given by path made each lookup fail twice before it loaded:
 * the rule took ten times as long as before.
 *
 * - `@cc/*` gives the file tsconfig.json `paths` names, as the compiler reads it. A path below a listed entry's folder
 *   (`@cc/platform/mock/demo`) is that folder's. An `@cc/` specifier neither way is an error: left unresolved it would
 *   count as a package from node_modules and no layer rule would read it.
 * - A relative path is resolved by name (`.js` read as `.ts`). The one read of the disk is for a path with no extension:
 *   a folder is its `index.ts`, which is the file the element has to be found by.
 * - Anything else is a package from node_modules: not found, so the plugin takes it as external.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const PATHS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')).compilerOptions.paths
const HAS_EXTENSION = /\.(m?[jt]s|[jt]sx|cjs|cts|json|css|svg|png|woff2?)$/

exports.interfaceVersion = 2

const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

exports.resolve = (source, file) => {
  const alias = PATHS[source]?.[0]
  if (alias) return { found: true, path: path.resolve(ROOT, alias) }
  if (source.startsWith('@cc/')) {
    const parent = Object.keys(PATHS).find((key) => source.startsWith(`${key}/`))
    if (!parent) throw new Error(`${source} (imported in ${file}) is not an alias in tsconfig.json paths, so no layer rule can read it`)
    return { found: true, path: `${path.resolve(ROOT, path.dirname(PATHS[parent][0]), source.slice(parent.length + 1))}.ts` }
  }
  if (!source.startsWith('.')) return { found: false }
  const target = path.resolve(path.dirname(file), source).replace(/\.m?js$/, (ext) => (ext === '.mjs' ? '.mts' : '.ts'))
  if (HAS_EXTENSION.test(target)) return { found: true, path: target }
  return { found: true, path: isDirectory(target) ? path.join(target, 'index.ts') : `${target}.ts` }
}
