/** Types of tooling/eslint-platform-checks.js, plain JavaScript so that eslint.config.js can import it */
import type { ESLint, Rule } from 'eslint'

export declare const platformChecks: Rule.RuleModule
export declare const osImports: Rule.RuleModule
declare const plugin: ESLint.Plugin
export default plugin
