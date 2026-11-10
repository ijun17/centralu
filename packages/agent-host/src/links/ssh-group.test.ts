import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartOptions } from '../os/port.js'

/**
 * Where a child stands in the process groups is decided by what it is (`StartOptions.contained`, os/port.ts): an ssh stays
 * in the host's group, so that whatever supervises the host ends it with the group (`host_proc.rs`'s `kill_group`), also when
 * the host crashed. The ssh of a tunnel and the one a command runs over ssh both started in a group of their own once they went
 * through the OS layer, and a forward outlived a host that was killed.
 */
const started: { command: string; options: StartOptions }[] = []
vi.mock('../os/real.js', () => ({
  realOs: () => ({
    processes: {
      start: (command: string, _args: readonly string[], options: StartOptions) => {
        started.push({ command, options })
        const child = Object.assign(new PassThrough(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, exitCode: null, signalCode: null, spawnedAt: Date.now(), kill: () => true, unref: () => {}, exited: new Promise(() => {}) })
        return child
      },
      stop: async () => ({ code: null, signal: null }),
    },
  }),
}))

describe('an ssh stays in the host group', () => {
  beforeEach(() => void (started.length = 0))

  it('the one a tunnel holds for its forward', async () => {
    const { SshTunnel } = await import('./tunnel.js')
    const tunnel = new SshTunnel({ target: 'box', ssh: 'fake-ssh', env: {} })
    void (tunnel as unknown as { forward(local: number, remote: number): Promise<void> }).forward(1, 2).catch(() => {})
    expect(started.map((s) => s.options.contained)).toEqual([false])
  })

  it('the one a command runs over', async () => {
    const { runSsh } = await import('./ssh-run.js')
    void runSsh({ ssh: 'fake-ssh', label: 'a command', args: ['box', 'true'], env: {}, timeoutMs: 50 }).catch(() => {})
    expect(started.map((s) => s.options.contained)).toEqual([false])
  })
})
