import { describe, expect, it } from 'vitest'
import type { RemoteRun } from './tunnel.js'
import { diedSilently, execThroughSilentDeath, FAKE_SSH_MARK } from './windows-remote.test-helpers.js'

/** The stand-in remote's way of failing without a word (#1244), and the one rerun it gets */

const silent: RemoteRun = { code: 1, stdout: '', stderr: '' }
const ok: RemoteRun = { code: 0, stdout: '{"v":1,"stop":{"ok":true,"wasRunning":true}}\n', stderr: '' }
// What Windows PowerShell writes to stderr when it ran: a header and progress records, no error among them
const progressOnly: RemoteRun = {
  code: 1,
  stdout: '',
  stderr: '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>',
}

/** An exec that answers each call with the next of `answers`, and counts the calls */
function script(...answers: Array<RemoteRun | Error>) {
  const calls: string[] = []
  const exec = async (c: unknown) => {
    calls.push(String(c))
    const a = answers[calls.length - 1] ?? answers.at(-1)!
    if (a instanceof Error) throw a
    return a
  }
  return { exec, calls }
}

describe('a command on the stand-in remote that ended without a word', () => {
  it('is a non-zero exit with nothing on stdout and no error on stderr', () => {
    expect(diedSilently(silent)).toBe(true)
    expect(diedSilently(progressOnly)).toBe(true)
    expect(diedSilently({ code: null, stdout: '', stderr: '' })).toBe(true)
    // The fake ssh's own word that it could not run the command, or that the command was ended, is not an answer either
    expect(diedSilently({ code: 1, stdout: '', stderr: `${FAKE_SSH_MARK}spawnSync cmd.exe EPERM\r\n` })).toBe(true)
  })

  it('is not one that printed anything, or exited 0', () => {
    expect(diedSilently(ok)).toBe(false)
    expect(diedSilently({ code: 1, stdout: 'CENTRALU-INSTALL fail script\r\n', stderr: '' })).toBe(false)
    expect(diedSilently({ code: 1, stdout: '', stderr: 'Centralu: no version is installed in C:\\x' })).toBe(false)
    expect(diedSilently({ code: 1, stdout: '', stderr: '#< CLIXML\r\n<Objs><S S="Error">boom_x000D__x000A_</S></Objs>' })).toBe(false)
    expect(diedSilently({ code: 0, stdout: '', stderr: '' })).toBe(false)
  })

  it('is run again, and the answer of the second run is the one returned', async () => {
    const s = script(silent, ok)
    const died: number[] = []
    expect(await execThroughSilentDeath(s.exec, 'serve --stop', { onDied: (_, n) => void died.push(n) })).toEqual(ok)
    expect(s.calls).toEqual(['serve --stop', 'serve --stop'])
    expect(died).toEqual([1])
  })

  it('is run again at most twice more, and then fails as it did, with the last run as the answer', async () => {
    const last: RemoteRun = { code: 2, stdout: '', stderr: '' }
    const s = script(silent, progressOnly, last, ok)
    const died: number[] = []
    expect(await execThroughSilentDeath(s.exec, 'serve --stop', { onDied: (_, n) => void died.push(n) })).toBe(last)
    expect(s.calls).toHaveLength(3)
    expect(died).toEqual([1, 2])
  })

  it('is not run again when it said something, even failing', async () => {
    const failed: RemoteRun = { code: 1, stdout: 'CENTRALU-INSTALL fail node_hash x\r\n', stderr: '' }
    const s = script(failed, ok)
    expect(await execThroughSilentDeath(s.exec, 'install')).toEqual(failed)
    expect(s.calls).toHaveLength(1)
  })

  it('is not run again when the command could not be run at all', async () => {
    const s = script(new Error('ssh could not reach box'), ok)
    await expect(execThroughSilentDeath(s.exec, 'install')).rejects.toThrow('ssh could not reach box')
    expect(s.calls).toHaveLength(1)
  })
})
