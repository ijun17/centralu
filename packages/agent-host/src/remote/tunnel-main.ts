import { parseRemoteTunnelArgs, REMOTE_TUNNEL_HELP, runRemoteTunnel } from './tunnel.js'

try {
  const parsed = parseRemoteTunnelArgs(process.argv.slice(2))
  if ('help' in parsed) {
    process.stdout.write(`${REMOTE_TUNNEL_HELP}\n`)
    process.exit(0)
  }
  process.exit(await runRemoteTunnel(parsed))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`${REMOTE_TUNNEL_HELP}\n`)
  process.exit(2)
}
