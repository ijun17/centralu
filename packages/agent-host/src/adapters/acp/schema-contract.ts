import { KNOWN_UPDATES } from './known-updates.js'

/** What the ACP adapter depends on, held to the SDK's published schema by `pnpm drift:acp-schema` (#2480, vendor-drift-checks.md) */

/** The methods the adapter sends or answers; `schema-contract.test.ts` fails when `acp/*.ts` names one that is not here */
export const ACP_METHODS = [
  'initialize',
  'authenticate',
  'session/new',
  'session/load',
  'session/resume',
  'session/list',
  'session/prompt',
  'session/cancel',
  'session/close',
  'session/update',
  'session/request_permission',
  'session/set_config_option',
] as const

/** The known updates without the two methods: a vendor's own kinds are in no schema */
export const ACP_UPDATE_KINDS: readonly string[] = [...KNOWN_UPDATES].filter((name) => !name.includes('/'))

/** The names the schema does not declare: a method is `"x-method": "<name>"`, a kind `"const": "<name>"`, and a mere property key (`plan`) is neither */
export function missingFromSchema(schemaText: string): string[] {
  const declared = (key: string, name: string) => new RegExp(`"${key}"\\s*:\\s*${JSON.stringify(name)}`).test(schemaText)
  return [...ACP_METHODS.filter((m) => !declared('x-method', m)), ...ACP_UPDATE_KINDS.filter((k) => !declared('const', k))]
}
