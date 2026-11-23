/**
 * `pnpm drift:acp-schema`: red when the latest published `@agentclientprotocol/sdk` has a `schema.json` that no longer carries
 * a method or update kind the ACP adapter depends on (`adapters/acp/schema-contract.ts`, #2480). The package is installed into
 * a temp folder, never the workspace; nothing is started.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { missingFromSchema } from '../packages/agent-host/src/adapters/acp/schema-contract.js'
import { execTool } from '../packages/agent-host/src/tool-run.js'

/** The schema the tools speak (protocol version 1), with the unstable methods and kinds the tools also send */
const SCHEMA = 'schema/v1/schema.unstable.json'

const dir = mkdtempSync(join(tmpdir(), 'acp-schema-'))
try {
  await execTool('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--ignore-scripts', '@agentclientprotocol/sdk@latest'], { timeoutMs: 300_000, maxBuffer: 64 * 1024 * 1024 })
  const root = join(dir, 'node_modules', '@agentclientprotocol', 'sdk')
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
  const missing = missingFromSchema(readFileSync(join(root, SCHEMA), 'utf8'))
  if (missing.length > 0) {
    console.error(`@agentclientprotocol/sdk ${version}: ${SCHEMA} no longer carries what the ACP adapter depends on:\n${missing.map((m) => `  ${m}`).join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`@agentclientprotocol/sdk ${version}: ${SCHEMA} carries every method and update kind of the ACP adapter`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
