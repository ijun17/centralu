import type { Linter } from 'eslint'

/** The `guard` plugin: the rules tooling/eslint-guards.js defines */
export const guards: { rules: Record<string, unknown> }
/** The configuration blocks that switch the rules on, each with the files it reads */
export const guardConfigs: (Linter.Config & { rules: Record<string, unknown> })[]
