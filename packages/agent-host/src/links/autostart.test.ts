import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { autostartRemote, parseAutostartLine, removeAutostart } from './autostart.js'
import { autostartCommand, parseConnectionLine, type RemoteRun, type RemoteSpec } from './tunnel.js'

/**
 * Starting a linked machine's host at boot from the hub (docs/plans/remote-hub.md §10.4, owner decision 4): the
 * command per shell, the line the remote answers, and how the hub reads it. The remote side, `centralu serve
 * --autostart`, is tooling/launcher-autostart.test.ts.
 */

const decode = (cmd: string) => Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le')

describe('the autostart command per shell', () => {
  // Run by a real sh, as a POSIX remote would: the Centralu that answers is the one the link's lookup finds
  it.skipIf(process.platform === 'win32')('a POSIX remote asks the managed launcher first, through the link’s own lookup', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-autostart-lookup-'))
    try {
      const put = (file: string, word: string) => {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `#!/bin/sh\necho ${word} "$@"\n`)
        chmodSync(file, 0o755)
      }
      const run = (action: 'on' | 'off' | 'status') =>
        execFileSync('/bin/sh', ['-c', autostartCommand({ shell: 'posix' }, action)], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).trim()
      put(join(home, '.centralu', 'bin', 'centralu'), 'npm-launcher')
      expect(run('on')).toBe('npm-launcher serve --autostart on')
      put(join(home, '.centralu', 'remote', 'bin', 'centralu'), 'managed')
      expect(run('off')).toBe('managed serve --autostart off')
      expect(run('status')).toBe('managed serve --autostart status')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a Windows remote runs it through the managed launcher in PowerShell, a WSL one inside the distro', () => {
    expect(decode(autostartCommand({ shell: 'powershell' }, 'on'))).toContain('if (Test-Path $m) { & $m serve --autostart on }')
    const wsl = decode(autostartCommand({ shell: 'wsl', wslDistro: 'Ubuntu-24.04' }, 'off'))
    expect(wsl).toContain("wsl.exe -d 'Ubuntu-24.04' -- bash -lc")
    const inner = Buffer.from(/echo ([A-Za-z0-9+/=]+) \|/.exec(wsl)![1]!, 'base64').toString('utf8')
    expect(inner).toContain('then exec "$m" serve --autostart off;')
    // The distro's own Centralu, never Windows' npm shim through /mnt/c
    expect(inner).toContain("grep -v '^/mnt/'")
    for (const spec of [{ shell: 'powershell' }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04' }] as RemoteSpec[]) {
      expect(autostartCommand(spec, 'status')).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    }
  })

  it('a command of the person’s own runs as given', () => {
    expect(autostartCommand({ shell: 'posix', command: 'CC_DATA_DIR=/x node /src/centralu.mjs' }, 'on')).toBe('CC_DATA_DIR=/x node /src/centralu.mjs serve --autostart on')
  })
})

describe('what the remote answers', () => {
  it('the connection line says whether the machine starts at boot, field by field', () => {
    const line = (autostart: unknown) =>
      parseConnectionLine(JSON.stringify({ v: 1, port: 1, token: 't', version: '1', protocolVersion: 1, dataDir: '/d', hostRunning: true, autostart })).autostart
    expect(line({ on: true, how: 'systemd', linger: false })).toEqual({ on: true, how: 'systemd', linger: false })
    expect(line({ on: false, how: 'task', linger: null })).toEqual({ on: false, how: 'task', linger: null })
    // Nothing to start it with cannot be on
    expect(line({ on: true, how: 'launchd' })).toEqual({ on: false, how: null, linger: null })
    expect(line({ on: 'yes', how: 'systemd' })).toBeUndefined()
    expect(line(undefined)).toBeUndefined()
  })

  it('reads the --autostart line under anything else the shell printed, and nothing else', () => {
    expect(parseAutostartLine('motd\n{"v":1,"autostart":{"ok":true,"on":true,"how":"systemd","linger":true}}\n')).toEqual({ ok: true, state: { on: true, how: 'systemd', linger: true }, message: null })
    expect(parseAutostartLine('{"v":1,"autostart":{"ok":false,"on":false,"how":"task","linger":null,"message":"Access is denied."}}')).toEqual({
      ok: false,
      state: { on: false, how: 'task', linger: null },
      message: 'Access is denied.',
    })
    expect(parseAutostartLine('{"v":1,"stop":{"ok":true}}\nCENTRALU-NOT-FOUND\n')).toBeNull()
  })
})

describe('autostartRemote', () => {
  const c = (r: Partial<RemoteRun>) => {
    const sent: string[] = []
    return {
      sent,
      c: {
        exec: async (cmd: string) => {
          sent.push(cmd)
          return { code: 0, stdout: '', stderr: '', ...r }
        },
        spec: { shell: 'posix' } as RemoteSpec,
        target: 'box',
      },
    }
  }

  it('answers the machine’s state after the change', async () => {
    const { c: ok, sent } = c({ stdout: '{"v":1,"autostart":{"ok":true,"on":true,"how":"systemd","linger":false,"message":"systemd starts it when me logs in"}}\n' })
    expect(await autostartRemote(ok, 'on')).toEqual({ on: true, how: 'systemd', linger: false })
    expect(sent[0]).toContain('serve --autostart on')
  })

  it('says why in a sentence: refused there, not installed, too old, or no answer', async () => {
    await expect(autostartRemote(c({ stdout: '{"v":1,"autostart":{"ok":false,"on":false,"how":"task","linger":null,"message":"Task Scheduler did not take the task: Access is denied."}}' }).c, 'on')).rejects.toThrow(
      'Centralu on box could not be set to start at boot: Task Scheduler did not take the task: Access is denied.',
    )
    await expect(autostartRemote(c({ stdout: 'CENTRALU-NOT-FOUND\n', code: 127 }).c, 'status')).rejects.toMatchObject({ reason: 'not_found', message: 'Centralu is not installed on box' })
    await expect(autostartRemote(c({ code: 2, stderr: 'unknown option for serve: --autostart\n\ncentralu serve: …' }).c, 'on')).rejects.toMatchObject({
      reason: 'too_old',
      message: expect.stringMatching(/too old to start at boot; update it first/),
    })
    await expect(autostartRemote(c({ code: 1, stderr: 'Error: Cannot find module x' }).c, 'off')).rejects.toThrow('Centralu on box gave no answer about starting at boot: Error: Cannot find module x')
  })

  it('an uninstall passes by a machine that could not have one from here, and stops at one that would not remove it', async () => {
    expect(await removeAutostart(c({ stdout: '{"v":1,"autostart":{"ok":true,"on":false,"how":"systemd","linger":null}}' }).c)).toBe(true)
    expect(await removeAutostart(c({ code: 2, stderr: 'unknown option for serve: --autostart' }).c)).toBe(false)
    expect(await removeAutostart(c({ stdout: 'CENTRALU-NOT-FOUND' }).c)).toBe(false)
    await expect(removeAutostart(c({ stdout: '{"v":1,"autostart":{"ok":false,"on":true,"how":"task","linger":null,"message":"Access is denied."}}' }).c)).rejects.toThrow(
      'Centralu on box could not stop starting at boot: Access is denied.',
    )
  })
})
