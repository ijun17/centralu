/**
 * Import resolver for eslint-plugin-boundaries (`import/resolver` setting). The plugin judges an import by the path it
 * resolves to; its default resolver is Node's, which finds no `@cc/*` package (nothing links one into node_modules) and
 * no `./x.js` that is `x.ts` on disk. So `boundaries/element-types` judged none of the imports the packages actually
 * use (#1847).
 *
 * - `@cc/*` gives the file tsconfig.json `paths` names, the way the compiler reads it: that stays the one list of aliases.
 * - A relative path is resolved by name only (`.js` read as `.ts`), with no read of the disk: the rule needs which
 *   element the path is in, not the file, and a read per import over every package made `pnpm lint` twice as slow.
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
  if (!source.startsWith('.')) return { found: false }
  const target = path.resolve(path.dirname(file), source).replace(/\.m?js$/, (ext) => (ext === '.mjs' ? '.mts' : '.ts'))
  return { found: true, path: path.extname(target) ? target : `${target}.ts` }
}
