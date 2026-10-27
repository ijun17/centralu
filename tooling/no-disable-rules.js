/**
 * The rules no comment may switch off (#1339): the type-aware ones the lists hold. Plain JavaScript so that both
 * tooling/lint-allowlist.ts (which fails `pnpm lint` on an eslint-disable of one) and the lint rule that reads comments
 * (`guard/no-rule-switch-comments`, tooling/eslint-guards-ts.js) share one list. The `guard/*`, `test-env/*` and `test-limits/*`
 * rules need none: they run in a pass that reads no comment as configuration (tooling/eslint-guard-pass.js).
 */
import tseslint from 'typescript-eslint'

/**
 * The rules a line of tooling/lint-allowlist/ may name: the type-aware ones eslint.config.js turned on (#1339). Any
 * other rule's findings were already errors before, and stay errors everywhere.
 */
export const LISTABLE_RULES = new Set([
  ...tseslint.configs.recommendedTypeCheckedOnly.flatMap((c) => Object.keys(c.rules ?? {})).filter((r) => r.startsWith('@typescript-eslint/')),
  '@typescript-eslint/consistent-type-assertions',
  '@typescript-eslint/no-non-null-assertion',
  '@typescript-eslint/no-unsafe-type-assertion',
])

/** The rules no comment may switch off */
export const NO_DISABLE_RULES = LISTABLE_RULES

/** May no comment switch this rule off? */
export const noDisable = (rule) => NO_DISABLE_RULES.has(rule)
