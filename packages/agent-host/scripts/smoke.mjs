/**
 * G3 smoke test: verifies the host end-to-end against a real Claude session (WS client → RPC → SDK
 * → events).
 * Includes one approval round trip (checks whether the permission override verified in M0 also
 * works in the actual code).
 * Run with: node packages/agent-host/scripts/smoke.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHost } from './host-client.mjs'

const cwd = mkdtempSync(join(tmpdir(), 'cc-smoke-'))
const log = (...a) => console.log('[smoke]', ...a)

const client = await openHost({
  timeoutMs: 180000,
  onEvent: (e) => {
    if (e.type === 'approval_request') log('approval request received:', JSON.stringify(e.detail).slice(0, 100))
    if (e.type === 'tool_call') log('tool call:', e.summary.title)
    if (e.type === 'turn_complete') log('turn complete')
  },
})
const { events, ws, host, call: rpc } = client
log('host started, port =', client.port)

const fail = (m) => { console.error('❌', m); cleanup(1) }
const cleanup = (code) => { try { ws.close() } catch {} ; host.kill(); process.exit(code) }

try {
  const project = await rpc('projects.add', { path: cwd })
  log('project registered:', project.name)

  const caps = await rpc('agents.capabilities', { tool: 'claude' })
  if (!caps.approvals) fail('capabilities.approvals is false')

  const session = await rpc('agents.createSession', {
    projectId: project.id, cwd, tool: 'claude', model: 'haiku', permissionPreset: 'normal',
  })
  log('session created:', session.id)

  // Something requiring approval (M0: a safe command like echo gets auto-approved, so a file write
  // is used instead). The path is pinned as absolute to remove any chance of the model picking a
  // different file.
  const target = join(cwd, 'smoke.txt')
  await rpc('agents.send', {
    sessionId: session.id,
    text: `Use the Write tool to create the file ${target} with the exact content: OK. Do not read any other file. Then stop.`,
  })

  await client.next((e) => e.type === 'approval_request', 'approval request', 120000)
  const req = events.find((e) => e.type === 'approval_request')
  log('approval detail normalization check: kind =', req.detail.kind)
  if (!['file_edit', 'command', 'other'].includes(req.detail.kind)) fail(`unknown detail kind: ${req.detail.kind}`)
  if (req.detail.kind === 'file_edit' && !req.detail.path) fail('file_edit but path is empty')

  await rpc('agents.respondApproval', { sessionId: session.id, requestId: req.requestId, decision: 'allow' })
  log('approval sent')

  await client.next((e) => e.type === 'turn_complete', 'turn complete', 120000)

  const types = new Set(events.map((e) => e.type))
  log('collected event types:', [...types].join(', '))
  for (const need of ['approval_request', 'approval_resolved', 'tool_call', 'usage_update', 'turn_complete']) {
    if (!types.has(need)) fail(`missing required event: ${need}`)
  }

  const msgs = await rpc('messages.load', { sessionId: session.id, limit: 100 })
  if (msgs.length === 0) fail('messages were not persisted')
  log('persisted messages:', msgs.length, 'item(s)')

  const sessions = await rpc('sessions.list', {})
  log('session state:', sessions[0].state, '| name:', sessions[0].name)

  console.log('\n✅ G3 smoke passed — completed an approval round trip with a real SDK session')
  cleanup(0)
} catch (e) {
  fail(e.message)
}
