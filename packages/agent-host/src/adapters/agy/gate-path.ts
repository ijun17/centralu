import { fileBeside } from '../../os.js'

/**
 * Where the gate hook command is. `./agy-gate.mjs` is beside this file in the source tree and beside the bundled `main.mjs`
 * in the packaged layout (`scripts/agy-gate-files.mjs` copies both gate files there), the same relative name in both. `agy`
 * starts it with `node <path>`, so it has to be a plain file on disk.
 */
export function gatePath(base: string = import.meta.url): string {
  return fileBeside(base, 'agy-gate.mjs')
}

/** The hook's two files, both beside `main.mjs` when packaged (`plugin-root.ts` copies them into a session's plugin root) */
export function gateSources(base: string = import.meta.url): { entry: string; answer: string } {
  return { entry: gatePath(base), answer: fileBeside(base, 'gate-answer.mjs') }
}
