/**
 * Import resolver for eslint-plugin-boundaries (`import/resolver` setting). The plugin judges an import by the path it
 * resolves to. Node's resolver, its default, finds no `@cc/*` package (each exposes an `exports` map of `.ts` files) and
 * no `./x.js` that is `x.ts` on disk, so `boundaries/element-types` judged none of the imports the packages actually
 * use (#1847).
 *
 * - `@cc/*` gives the file tsconfig.json `paths` names, as the compiler reads it. A path below a listed entry's folder
 *   (`@cc/platform/mock/demo`) is that folder's. An `@cc/` specifier neither way is an error: left unresolved it would
 *   count as a package from node_modules and no layer rule would read it.
 * - A relative path is resolved by name only (`.js` read as `.ts`), with no read of the disk: the rule needs which
 *   element the path is in, not the file, and a read per import over every package made `pnpm lint` slower.
 * - Anything else is a package from node_modules: not found, so the plugin takes it as external.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PATHS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')).compilerOptions.paths

exports.interfaceVersion = 2

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
  return { found: true, path: path.extname(target) ? target : `${target}.ts` }
}
