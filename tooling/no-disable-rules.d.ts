/** The rules a line of tooling/lint-allowlist/ may name: the type-aware ones eslint.config.js turned on */
export const LISTABLE_RULES: ReadonlySet<string>
/** The rules no comment may switch off */
export const NO_DISABLE_RULES: ReadonlySet<string>
/** May no comment switch this rule off? */
export const noDisable: (rule: string) => boolean
