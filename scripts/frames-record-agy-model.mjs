#!/usr/bin/env node
/**
 * Runs `agy acp` for a recording with a model chosen (`scripts/frames-record-agy.mts`): the agent starts on its default, which is a
 * dearer model than a recording needs, and the ACP adapter sets none of its own. After the answer to `session/new` or `session/load`
 * this asks the agent for `session/set_model` and swallows the answer, so the adapter sees what it sees from a plain `agy acp` bar the
 * model the turns run on. Everything else goes through as it is, in both directions.
 *
 *   node frames-record-agy-model.mjs <model id> <command> [argument ...]
 */
import { spawn } from 'node:child_process'

const [model, command, ...args] = process.argv.slice(2)
const OWN_ID = 'recording-model'
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })

process.stdin.pipe(child.stdin)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code) => process.exit(code ?? 1))

let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end + 1)
    buffer = buffer.slice(end + 1)
    let frame = null
    try {
      frame = JSON.parse(line)
    } catch {
      // Not JSON: passed on as it is
    }
    if (frame?.id === OWN_ID) continue
    process.stdout.write(line)
    const sessionId = frame?.result?.sessionId
    if (typeof sessionId === 'string' && frame.result.models) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: OWN_ID, method: 'session/set_model', params: { sessionId, modelId: model } })}\n`)
    }
  }
})
