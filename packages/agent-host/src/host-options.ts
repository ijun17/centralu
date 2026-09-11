import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

export const HOST_HELP = `Usage: pnpm host [options]
  --port <0..65535>     Loopback port (default 5175; 0 chooses a free port)
  --db <path>           Local database; one host owns its data directory
  --memory              Ephemeral database for testing
  --token <value>        Local-mode capability (prefer --token-file)
  --token-file <path>    Read the capability from a private file
  --web-root <path>      Opt-in remote browser: serve built web assets
  --host-label <label>   Execution machine label in the remote browser
  --watch-parent        Exit when the supervising parent's stdin closes
  --help                Show this help
Remote mode requires a token of at least 32 characters via --token-file or
CC_HOST_TOKEN. It remains loopback-only; use pnpm remote for an SSH tunnel.`

export function parseHostOptions(args: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, options: {
    port: { type: 'string', default: '5175' },
    token: { type: 'string' },
    'token-file': { type: 'string' },
    db: { type: 'string' },
    'watch-parent': { type: 'boolean' },
    memory: { type: 'boolean', default: false },
    'web-root': { type: 'string' },
    'host-label': { type: 'string' },
    help: { type: 'boolean' },
  } })
  const port = Number(values.port)
  if (!/^\d+$/.test(values.port ?? '') || !Number.isInteger(port) || port > 65535) throw new Error('Invalid port: use an integer from 0 to 65535')
  let token = values.token ?? env.CC_HOST_TOKEN
  if (values['token-file']) {
    if (values.token) throw new Error('Use either --token or --token-file, not both')
    try { token = readFileSync(values['token-file'], 'utf8').trim() } catch { throw new Error('Cannot read token file') }
  }
  const webRoot = values['web-root']
  if (webRoot && !values.help) {
    if (values.token) throw new Error('Remote mode requires --token-file or CC_HOST_TOKEN, not a token in command arguments')
    if (!token || token.length < 32) throw new Error('Remote token must contain at least 32 characters')
  }
  const hostLabel = values['host-label'] ?? hostname()
  if (hostLabel.length > 80 || !hostLabel.trim() || [...hostLabel].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid host label: use 1 to 80 printable characters')
  return { port, token, webRoot, hostLabel, db: values.db, memory: values.memory, watchParent: values['watch-parent'], help: values.help }
}
