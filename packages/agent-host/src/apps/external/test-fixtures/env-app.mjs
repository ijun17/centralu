/**
 * The app used by the handover (M4 E) tests — a real MCP server started as a real child process
 * (same SDK, same shape as app.mjs). It is kept separate from app.mjs because that file is where
 * the broker (D) side is also edited, and if the secrets, imports and version tests leaned on it
 * too, two lines of change would collide in the same file.
 *
 *   node env-app.mjs [--env <name>] [--require-env] [--leak]
 *
 * --env          the `env` tool returns the environment variable of this name — the test sees the
 *                value the app **actually received** (not what the host claims it sent)
 * --require-env  if that variable is missing, writes one line to stderr and exits as soon as it
 *                starts (an app that cannot start because a key is missing)
 * --leak         an app that leaks the value it received: writes it to stderr on startup, and
 *                `leak_fail` carries it in the failure message
 *
 * The `version` tool returns the value it read from the app folder's (cwd) version.txt **once, at
 * startup** — a rollback test uses this to see "which code it started with" (the server code is
 * this one file, so what changes across a rollback is the folder's contents).
 */
import { existsSync, readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name) => process.argv.includes(`--${name}`)
const NAME = arg('env') ?? 'API_KEY'
const value = process.env[NAME]
const VERSION = existsSync('version.txt') ? readFileSync('version.txt', 'utf8').trim() : '(no version.txt)'

if (flag('require-env') && !value) {
  process.stderr.write(`env-app: ${NAME} is not set — cannot start\n`)
  process.exit(4)
}
if (flag('leak')) process.stderr.write(`env-app: starting with ${NAME}=${value ?? '(none)'}\n`)

const say = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

serveStdio(() => {
  const server = new McpServer({ name: 'env-app', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('env', { description: 'What this process received', annotations: { readOnlyHint: true } }, async () =>
    say(`${NAME}=${value ?? '(none)'} pid=${process.pid}`),
  )
  server.registerTool('version', { description: 'The version.txt this process started with', annotations: { readOnlyHint: true } }, async () =>
    say(VERSION),
  )
  server.registerTool('echo', { description: 'Echo', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => say(`echo: ${text}`))
  server.registerTool('leak_fail', { description: 'Fails, with what it received in the message' }, async () => {
    process.stderr.write(`env-app: about to fail holding ${value ?? '(none)'}\n`)
    return say(`could not use ${NAME}=${value ?? '(none)'}`, true)
  })
  return server
})
