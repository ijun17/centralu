/**
 * The guard pass: ESLint's own run, from tooling/lint.ts, of the rules that took over a test's whole-tree guard
 * (`guard/*`, tooling/eslint-guards.js; `test-env/*`; `test-limits/*`; #1602, #1606, #1607), and of nothing else.
 *
 * It reads no comment as configuration (`noInlineConfig`): no `eslint rule: off` comment, no `eslint-disable`, in any file
 * kind or position (a JSX comment, the last line of a block), can turn a rule of this pass off, and a rule cannot switch
 * itself or another off. A unit test could not be skipped by a comment; these rules are the same guards, so they cannot
 * be either. What a rule lets through is a line of tooling/guard-exceptions.js (or the rule's own `EXCEPTIONS`), with its
 * reason, that only shrinks.
 *
 * The pass has its own configuration (`pnpm lint` runs it after the main one; the main configuration, eslint.config.js,
 * does not hold these rules, so an editor does not show them): it reads every file kind the guards read, the `.cjs`
 * files the main pass does not, and parses TypeScript without types.
 */
import tseslint from 'typescript-eslint'
import { IGNORES } from './eslint-ignores.js'
import testDataDir from './eslint-test-data-dir.js'
import testTimeLimits from './eslint-test-time-limits.js'
import { guardConfigs } from './eslint-guards.js'

const TEST_FILES = ['**/*.test.{ts,tsx}', '**/*test-helpers.ts', 'e2e/**/*']

/** The flat configuration of the guard pass */
export const guardPass = [
  { ignores: IGNORES },
  // TypeScript syntax and JSX, without a program: no rule here reads a type. Other kinds (.js, .mjs, .cjs) use ESLint's own parser.
  { files: ['**/*.{ts,tsx,mts,cts}'], languageOptions: { parser: tseslint.parser } },
  // Comments are text here: they configure nothing, and nothing is reported as an unused one
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' } },
  // A test file never writes CC_DATA_DIR by hand (tooling/eslint-test-data-dir.js)
  { files: TEST_FILES, plugins: { 'test-env': testDataDir }, rules: { 'test-env/data-dir': 'error' } },
  // A time limit a test sets for itself is scaled by SLOW (tooling/eslint-test-time-limits.js); these are the files the unit test read
  { files: ['packages/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'], plugins: { 'test-limits': testTimeLimits }, rules: { 'test-limits/scaled-by-slow': 'error' } },
  // Guards that were tests reading every source file of a folder (tooling/eslint-guards.js, exceptions in tooling/guard-exceptions.js)
  ...guardConfigs,
]

/** ESLint loads this file as the pass's configuration (`overrideConfigFile`): its threads each read it, as a config file is the one form that can be sent to them */
export default guardPass
