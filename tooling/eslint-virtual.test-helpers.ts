import { ESLint } from 'eslint'
import tseslint from 'typescript-eslint'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * ESLint with the repository's configuration, for linting code at a path no file is at. The type-aware
 * rules (#1339) need the file in the TypeScript program and refuse one that is not ("was not found by
 * the project service"), so they are left out here; the rules these tests check read no types.
 */
export const virtualFileLinter = () => new ESLint({ cwd: ROOT, overrideConfig: tseslint.configs.disableTypeChecked })
