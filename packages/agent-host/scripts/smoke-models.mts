/**
 * Measured: do both tools actually return a model list?
 *
 * There was a report that only "default" shows up in the UI, but looking at the screen alone
 * cannot tell whether the cause is the adapter, the RPC layer, or the UI. Calls the adapter
 * directly to tell which layer the break is at.
 */
import { ClaudeAdapter } from '../src/adapters/claude/index.js'
import { CodexAdapter } from '../src/adapters/codex/index.js'

const cwd = process.cwd()

async function tryClaude() {
  const a = new ClaudeAdapter()
  console.log('\n── claude ──')
  try {
    console.log('without a session:', (await a.listModels()).length, 'item(s)')
  } catch (e) {
    console.log('without a session: failed —', (e as Error).message)
  }
  // Start a session and try again
  const h = await a.createSession(
    { sessionId: 'smoke', cwd, permissionPreset: 'auto' },
    () => {},
  )
  await new Promise((r) => setTimeout(r, 1500))
  try {
    const models = await a.listModels()
    console.log('after the session comes up:', models.length, 'item(s)')
    for (const m of models) console.log('  ', m.id, '|', m.label, '| efforts:', m.efforts.join(',') || 'none')
  } catch (e) {
    console.log('after the session comes up: failed —', (e as Error).message)
  }
  await h.dispose()
}

async function tryCodex() {
  const a = new CodexAdapter()
  console.log('\n── codex ──')
  try {
    const models = await a.listModels()
    console.log(models.length, 'item(s)')
    for (const m of models) console.log('  ', m.id, '|', m.label, '| efforts:', m.efforts.join(',') || 'none')
  } catch (e) {
    console.log('failed —', (e as Error).message)
  }
}

await tryClaude()
await tryCodex()
process.exit(0)
