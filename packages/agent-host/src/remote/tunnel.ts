import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

export type RemoteTunnelOptions = Readonly<{ host: string; localPort: number; remotePort: number }>
export type RemoteTunnelChild = Readonly<{
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): RemoteTunnelChild
  on(event: 'error', listener: (error: Error) => void): RemoteTunnelChild
  on(event: 'stderr', listener: (data: Buffer) => void): RemoteTunnelChild
  kill(signal: NodeJS.Signals): boolean
}>

export type RemoteTunnelRuntime = Readonly<{
  spawn(command: string, args: readonly string[]): RemoteTunnelChild
  stdout(line: string): void
  stderr(line: string): void
  onSignal(signal: NodeJS.Signals, handler: () => void): void
  offSignal(signal: NodeJS.Signals, handler: () => void): void
}>

export const REMOTE_TUNNEL_HELP = `Usage: pnpm remote -- --host <ssh-target> [--local-port 5175] [--remote-port 5175]

Creates a foreground OpenSSH local-forward tunnel:
  browser 127.0.0.1:<local-port> -> ssh -> remote 127.0.0.1:<remote-port>

Start pnpm remote:serve on the execution host first. Host keys must already be trusted.`


export function parseRemoteTunnelArgs(argv: readonly string[]): RemoteTunnelOptions | { readonly help: true } {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const hostFlagIndex = args.indexOf('--host')
  if (hostFlagIndex >= 0 && args[hostFlagIndex + 1]?.startsWith('-')) throw new Error('Invalid SSH host')
  const { values } = parseArgs({
    args: [...args],
    options: {
      host: { type: 'string' },
      'local-port': { type: 'string', default: '5175' },
      'remote-port': { type: 'string', default: '5175' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.help) return { help: true }
  const host = values.host
  if (!host) throw new Error('Missing --host')
  if (host.startsWith('-') || hasWhitespace(host) || hasControlCharacter(host)) throw new Error('Invalid SSH host')
  return { host, localPort: parsePort(values['local-port'], 'local'), remotePort: parsePort(values['remote-port'], 'remote') }
}

export function buildSshArgs(options: RemoteTunnelOptions): readonly string[] {
  return [
    '-T',
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${options.localPort}:127.0.0.1:${options.remotePort}`,
    '--',
    options.host,
  ]
}

export function runRemoteTunnel(options: RemoteTunnelOptions, runtime: RemoteTunnelRuntime = nodeRuntime): Promise<number> {
  runtime.stdout(`Centralu remote tunnel for ${options.host}: http://127.0.0.1:${options.localPort}/?remote=1`)
  runtime.stdout('Start pnpm remote:serve on the execution host first; keep this foreground process open.')
  const child = runtime.spawn('ssh', buildSshArgs(options))
  const terminate = () => { child.kill('SIGTERM') }
  runtime.onSignal('SIGINT', terminate)
  runtime.onSignal('SIGTERM', terminate)
  return new Promise((resolve) => {
    let stderrBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let finished = false
    const finish = (code: number) => {
      if (finished) return
      finished = true
      runtime.offSignal('SIGINT', terminate)
      runtime.offSignal('SIGTERM', terminate)
      resolve(code)
    }
    child.on('stderr', (chunk: Buffer) => { stderrBuffer = appendBounded(stderrBuffer, chunk, SSH_STDERR_BUFFER_BYTES) })
    child.on('error', (error: Error) => {
      if ('code' in error && error.code === 'ENOENT') runtime.stderr('OpenSSH ssh binary was not found')
      else runtime.stderr(error.message)
      finish(127)
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      emitDiagnostic(stderrBuffer.toString('utf8'), runtime)
      finish(code ?? signalExitCode(signal))
    })
  })
}


const nodeRuntime: RemoteTunnelRuntime = {
  spawn: (command, args) => {
    const child = spawn(command, [...args], { stdio: ['inherit', 'inherit', 'pipe'] })
    const wrapped: RemoteTunnelChild = {
      on: (event, listener) => {
        if (event === 'stderr') child.stderr.on('data', listener)
        else child.on(event, listener)
        return wrapped
      },
      kill: (signal) => child.kill(signal),
    }
    return wrapped
  },
  stdout: (line) => { process.stdout.write(`${line}\n`) },
  stderr: (line) => { if (line) console.error(line) },
  onSignal: (signal, handler) => process.on(signal, handler),
  offSignal: (signal, handler) => process.off(signal, handler),
}

function parsePort(value: string | undefined, name: string): number {
  const port = Number(value)
  if (!value || !/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name} port: use an integer from 1 to 65535`)
  }
  return port
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return 1
}

const SSH_STDERR_BUFFER_BYTES = 16 * 1024

function appendBounded(current: Buffer, chunk: Buffer, limit: number): Buffer {
  const combined = Buffer.concat([current, chunk])
  return combined.length > limit ? combined.subarray(combined.length - limit) : combined
}

function emitDiagnostic(stderrText: string, runtime: RemoteTunnelRuntime): void {
  const text = stderrText.trim()
  if (!text) return
  if (/host key verification failed|no matching host key|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    runtime.stderr('Host key verification failed. Add or fix the host in known_hosts; this launcher will not disable StrictHostKeyChecking.')
    return
  }
  if (/permission denied|authentication failed/i.test(text)) {
    runtime.stderr('SSH authentication failed. Configure key-based access for BatchMode=yes before retrying.')
    return
  }
  if (/address already in use|cannot listen|bind.*failed|port.*forwarding failed/i.test(text)) {
    runtime.stderr('SSH local forward failed to bind. Choose a different --local-port or stop the existing listener.')
    return
  }
  runtime.stderr(text)
}

function hasWhitespace(value: string): boolean {
  return /\s/.test(value)
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}
