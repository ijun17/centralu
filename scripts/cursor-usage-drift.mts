/**
 * `pnpm drift:cursor-usage`: red when the installed Cursor CLI's bundle (the version the launcher would start) no longer
 * carries what reading its plan usage depends on (`adapters/cursor-agent/usage-contract.ts`, #2459). No login, no request.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findCursor } from '../packages/agent-host/src/adapters/cursor-agent/install.js'
import { missingFromBundle } from '../packages/agent-host/src/adapters/cursor-agent/usage-contract.js'

const install = findCursor()
if (!install) {
  console.error('Cursor CLI is not installed on this machine (https://cursor.com/install)')
  process.exit(1)
}
const dir = dirname(install.args[0] ?? install.command)
const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'))
const missing = missingFromBundle(files.map((f) => readFileSync(join(dir, f), 'utf8')))
if (missing.length > 0) {
  console.error(`agent ${install.version} no longer carries what Cursor's usage read depends on:\n${missing.map((m) => `  ${m}`).join('\n')}`)
  process.exit(1)
}
console.log(`agent ${install.version}: every name of the Cursor usage contract is in its bundle (${files.length} files)`)
