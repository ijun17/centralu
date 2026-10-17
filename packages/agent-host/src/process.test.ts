import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { alive } from './process.test-helpers.js'
import { eventually } from '../../../tooling/test-timing.js'

describe('alive(pid) in tests (#845)', () => {
  it('a process this test started is alive until it has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    const exited = new Promise((r) => child.once('exit', r))
    await new Promise((r) => child.once('spawn', r))
    expect(alive(child.pid!)).toBe(true)
    child.kill()
    await exited
    await eventually(() => !alive(child.pid!))
  })

  // A process that exists but may not be signalled answers EPERM: Windows' System process (pid 4) to a user, init
  // (pid 1) to anyone but root, who may signal it and gets the same answer
  it('a process that exists but may not be signalled is alive', () => {
    expect(alive(process.platform === 'win32' ? 4 : 1)).toBe(true)
  })
})
