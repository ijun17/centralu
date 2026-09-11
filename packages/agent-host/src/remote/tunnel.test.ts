import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { buildSshArgs, parseRemoteTunnelArgs, runRemoteTunnel, type RemoteTunnelRuntime } from './tunnel.js'

class FakeChild extends EventEmitter {
  readonly kill = vi.fn()
}

function makeRuntime(child = new FakeChild()) {
  const stdout: string[] = []
  const stderr: string[] = []
  const runtime: RemoteTunnelRuntime = {
    spawn: vi.fn(() => child),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    onSignal: vi.fn(),
    offSignal: vi.fn(),
  }
  return { runtime, child, stdout, stderr }
}

describe('remote tunnel argument parsing', () => {
  it('supports pnpm -- separator and defaults', () => {
    expect(parseRemoteTunnelArgs(['--', '--host', 'centralu-node-a'])).toEqual({ host: 'centralu-node-a', localPort: 5175, remotePort: 5175 })
  })

  it('returns help without requiring a host', () => {
    expect(parseRemoteTunnelArgs(['--help'])).toEqual({ help: true })
  })

  it('rejects unsafe hosts and ports', () => {
    expect(() => parseRemoteTunnelArgs([])).toThrow('Missing --host')
    expect(() => parseRemoteTunnelArgs(['--host', '-evil'])).toThrow('Invalid SSH host')
    expect(() => parseRemoteTunnelArgs(['--host', 'bad\nhost'])).toThrow('Invalid SSH host')
    expect(() => parseRemoteTunnelArgs(['--host', 'bad host'])).toThrow('Invalid SSH host')
    expect(() => parseRemoteTunnelArgs(['--host', 'node', '--local-port', '0'])).toThrow('1 to 65535')
    expect(() => parseRemoteTunnelArgs(['--host', 'node', '--remote-port', '65536'])).toThrow('1 to 65535')
    expect(() => parseRemoteTunnelArgs(['--host', 'node', '--local-port', 'abc'])).toThrow('1 to 65535')
    expect(() => parseRemoteTunnelArgs(['--host', 'node', '--ssh-option', 'StrictHostKeyChecking=no'])).toThrow('Unknown option')
  })
})

describe('remote tunnel ssh argv', () => {
  it('uses fixed OpenSSH policy without shells, remote commands, or tokens', () => {
    const args = buildSshArgs({ host: 'centralu-node-a', localPort: 56175, remotePort: 55175 })
    expect(args).toEqual([
      '-T',
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-L', '127.0.0.1:56175:127.0.0.1:55175',
      '--',
      'centralu-node-a',
    ])
    expect(args).not.toContain('sh')
    expect(args).not.toContain('-c')
    expect(args.join(' ')).not.toMatch(/token|StrictHostKeyChecking=no|0\.0\.0\.0/)
  })
})

describe('remote tunnel process lifecycle', () => {
  it('prints only the local browser URL and propagates success', async () => {
    const { runtime, child, stdout } = makeRuntime()
    const done = runRemoteTunnel({ host: 'centralu-node-a', localPort: 56175, remotePort: 55175 }, runtime)
    child.emit('exit', 0, null)
    await expect(done).resolves.toBe(0)
    expect(runtime.spawn).toHaveBeenCalledWith('ssh', buildSshArgs({ host: 'centralu-node-a', localPort: 56175, remotePort: 55175 }))
    expect(stdout.join('\n')).toContain('http://127.0.0.1:56175/?remote=1')
    expect(stdout.join('\n')).toContain('centralu-node-a')
    expect(stdout.join('\n')).not.toMatch(/token/i)
  })

  it('maps spawn failures and ssh stderr into actionable diagnostics', async () => {
    const first = makeRuntime()
    const missing = runRemoteTunnel({ host: 'centralu-node-a', localPort: 56175, remotePort: 55175 }, first.runtime)
    first.child.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }))
    await expect(missing).resolves.toBe(127)
    expect(first.stderr.join('\n')).toContain('OpenSSH ssh binary was not found')

    const second = makeRuntime()
    const failed = runRemoteTunnel({ host: 'centralu-node-a', localPort: 56175, remotePort: 55175 }, second.runtime)
    second.child.emit('stderr', Buffer.from('Host key verification failed.'))
    second.child.emit('exit', 255, null)
    await expect(failed).resolves.toBe(255)
    expect(second.stderr.join('\n')).toContain('Host key verification failed')
  })



  it('bounds raw ssh stderr diagnostics to 16 KiB', async () => {
    const { runtime, child, stderr } = makeRuntime()
    const failed = runRemoteTunnel({ host: 'centralu-node-a', localPort: 56175, remotePort: 55175 }, runtime)
    child.emit('stderr', Buffer.from('x'.repeat(20 * 1024)))
    child.emit('stderr', Buffer.from('tail'))
    child.emit('exit', 255, null)
    await expect(failed).resolves.toBe(255)
    const diagnostic = stderr[0] ?? ''
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(diagnostic).toMatch(/tail$/)
  })

  it('forwards termination to ssh and propagates exit code', async () => {
    const { runtime, child } = makeRuntime()
    const signalHandlers: Array<() => void> = []
    vi.mocked(runtime.onSignal).mockImplementation((_signal, handler) => { signalHandlers.push(handler) })
    const done = runRemoteTunnel({ host: 'centralu-node-a', localPort: 56175, remotePort: 55175 }, runtime)
    signalHandlers[0]?.()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', 130, null)
    await expect(done).resolves.toBe(130)
    expect(runtime.offSignal).toHaveBeenCalled()
  })
})
