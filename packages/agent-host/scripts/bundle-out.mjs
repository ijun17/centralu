import { isAbsolute, relative, resolve } from 'node:path'

/**
 * `CC_BUNDLE_OUT` for `bundle.mjs` (#1036): the folder is removed and written whole, so only an absolute path outside
 * the checkout `root` (neither the checkout, a folder in it, nor a folder above it). A dev build for a linked machine
 * names the version folder it makes under the data folder there.
 */
export function bundleOutFolder(dir, root) {
  if (!dir || !isAbsolute(dir)) throw new Error(`CC_BUNDLE_OUT must be an absolute path: ${dir}`)
  const out = resolve(dir)
  const outside = (from, to) => {
    const rel = relative(from, to)
    return rel.startsWith('..') || isAbsolute(rel)
  }
  // Out in the checkout (or the checkout itself), or the checkout in out (a folder above it)
  if (!outside(root, out) || !outside(out, root)) throw new Error(`CC_BUNDLE_OUT must be outside the checkout ${root}: ${out}`)
  return out
}
