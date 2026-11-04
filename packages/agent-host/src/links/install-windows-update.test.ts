import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readSwitchStatus, type HostControl } from './update.js'
import { WIN_NODE_V, pwsh7ModulePath } from './windows-remote.test-helpers.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'
import { windowsRemote } from './install-windows.test-helpers.js'

/**
 * Updating a Windows machine: the switch the machine runs itself, and its failures.
 * (the setup is install-windows.test-helpers.ts; the suite was one file, install-windows.test.ts)
 */

// The install scripts ask the machine for its architecture, and only x64 Windows has a build
describe.runIf(process.platform === 'win32' && process.arch === 'x64')('installing on and updating a Windows machine over a fake ssh into a real PowerShell', () => {
  const w = windowsRemote()
  const { recorded, data, remote, events, running, tunnel, control, tell, update, startThere, installedAndRunning, switchNow, goneAfterHandover, killSwitcher } = w

  describe('updating, rolling back and uninstalling', () => {
    it('installs beside, hands the switch to the machine, which stops the old host, switches, starts and checks the new one, then prunes', async () => {
      await installedAndRunning()
      const { seen, done } = update('9.9.2')
      expect(await done).toMatchObject({ current: { version: '9.9.2', node: WIN_NODE_V }, previous: { version: '9.9.1', node: WIN_NODE_V } })
      // The old version stopped itself, through its own launcher, then the new one started
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2'])
      expect(running()).toBe('9.9.2')
      expect(seen.slice(0, 6)).toEqual(['preflight', 'registry', 'node', 'centralu', 'hold', 'stop'])
      expect(seen.at(-1)).toBe('prune')
      expect(switchNow()).toMatchObject({ outcome: 'done', seen: true })
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
      expect(readFileSync(remote('previous'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      // A third version removes the first only once it answered
      expect(await update('9.9.3').done).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' }, removed: ['9.9.1'] })
      expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.2', '9.9.3'])
    }, 180_000 * SLOW)

    it('names a version folder a running program holds, instead of failing, and removes it once the program is gone', async () => {
      await installedAndRunning()
      await update('9.9.2').done
      // A program running from 9.9.1's folder, as a host that has not yet stopped is: Windows will not remove a folder that is some program's working directory
      const holder = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: remote('versions', '9.9.1'), stdio: 'ignore' })
      try {
        const r = await update('9.9.3').done
        expect(r).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' } })
        expect(r.removed).not.toContain('9.9.1')
        expect(r.left).toContain('9.9.1')
        expect(existsSync(remote('versions', '9.9.3', 'install.json'))).toBe(true)
      } finally {
        holder.kill()
        await new Promise((r) => (holder.exitCode !== null ? r(null) : holder.once('exit', r)))
      }
      // The next update's prune takes it
      expect(await update('9.9.1').done).toMatchObject({ current: { version: '9.9.1' } })
    }, 240_000 * SLOW)

    it('puts the old version back and starts it when the new one does not answer, with the end of its log', async () => {
      await installedAndRunning()
      const { seen, done } = update('9.9.2', { FAKE_BROKEN: '9.9.2' })
      await expect(done).rejects.toThrow(
        /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\); it runs Centralu 9\.9\.1 again\. The end of its host\.log: host 9\.9\.2: the store was written by a newer Centralu/,
      )
      expect(seen).toContain('roll_back')
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2', 'stop - (for update)', 'start 9.9.1'])
      expect(running()).toBe('9.9.1')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('previous'))).toBe(false)
      expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.1', '9.9.2'])
    }, 180_000 * SLOW)

    /*
     * #1903: the new version's host took host.lock and hung before it listened. The put-back's stop found nothing on
     * the port and signalled nothing, and the old version then failed on the lock: no host at all
     */
    it('ends a new version that took the lock and hung, by the pid its lock names, and the old one runs again', async () => {
      await installedAndRunning()
      // Under PowerShell 7's module path, as the ssh session of a CI runner has it: the lock's holder must still be told
      const { done } = update('9.9.2', { FAKE_HANGS: '9.9.2', PSModulePath: pwsh7ModulePath(w.root) })
      const hung = () => Number(readFileSync(data('hung'), 'utf8'))
      try {
        await expect(done).rejects.toThrow(/Centralu 9\.9\.2 did not start on box \(the host did not answer within 30 s\); it runs Centralu 9\.9\.1 again\./)
        expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2', 'stop hung (for update)', 'start 9.9.1'])
        expect(running()).toBe('9.9.1')
        expect(() => process.kill(hung(), 0)).toThrow()
      } finally {
        // Only the process this test's fake started
        if (existsSync(data('hung'))) {
          try {
            process.kill(hung())
          } catch {
            // already gone
          }
        }
      }
    }, 180_000 * SLOW)

    it('does not say the old version runs again before it said hello, and says the stop before it failed', async () => {
      await installedAndRunning()
      const { done } = update('9.9.2', { FAKE_BROKEN: '9.9.2', FAKE_STOP_FAILS: '-', FAKE_SILENT: '9.9.1' })
      await expect(done).rejects.toThrow(
        /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\), and putting back Centralu 9\.9\.1 failed too: it did not answer within 30 s either \(after Centralu on box could not be stopped: the host on 127\.0\.0\.1:4141 is still running\)\./,
      )
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    /*
     * #1903: the link dropped between the stop and the start. With the hub running each step, no host ran until ssh came
     * back and the link started one. The machine runs the switch now: every command after the stop fails, as on a link
     * that is down for good, and the machine ends on the new version all the same
     */
    it('ends on the new version when the link drops once the old host stopped, with no command from the hub after it', async () => {
      await installedAndRunning()
      let down = false
      const t = tunnel()
      const exec: HostControl['exec'] = async (cmd) => {
        if (down) throw new Error('ssh: connect to host box port 22: Connection timed out')
        const r = await recorded(t)(cmd)
        // The link goes down once the stop has happened there, whichever command did it
        if (events().some((e) => e.startsWith('stop'))) down = true
        return r
      }
      const { done } = update('9.9.2', {}, { exec, followMs: 3_000 })
      await expect(done).rejects.toThrow(/could not be followed to its end from this computer; how it ended is shown once box is reached again/)
      await eventually(() => running() === '9.9.2' && switchNow().outcome === 'done', 60_000)
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2'])
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    /*
     * #1903: the hub died mid-update. Once the switch is handed over it never asks again; the machine finishes, and the
     * next hub that links reads how it ended, reported once
     */
    it('finishes when the hub is gone after the handover, and a hub that links later reads the outcome, once', async () => {
      await installedAndRunning()
      let gone = false
      const t = tunnel()
      const exec: HostControl['exec'] = async (cmd) => {
        if (gone) return new Promise<never>(() => {})
        const r = await recorded(t)(cmd)
        if (existsSync(remote('switch.json'))) gone = true
        return r
      }
      void update('9.9.2', {}, { exec }).done.catch(() => undefined)
      await eventually(() => existsSync(remote('switch.json')) && switchNow().outcome === 'done', 60_000)
      expect(running()).toBe('9.9.2')
      const next = control().c
      const first = await readSwitchStatus(next)
      expect(first).toMatchObject({ outcome: 'done', to: { version: '9.9.2' } })
      expect(first?.seen).toBeUndefined()
      // Reported: the hub marks it, and it is not reported again
      await readSwitchStatus(next, first!.id)
      expect(await readSwitchStatus(next)).toMatchObject({ outcome: 'done', seen: true })
    }, 180_000 * SLOW)

    // WMI blocked: the switch runs in the ssh session, and a link drop ends it like a crash; the reconnect brings a host back
    it('where nothing starts outside the session, a switch that ends with the session is finished by the reconnect', async () => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_WMI_BLOCKED: '1', FAKE_HOLD: 'start 9.9.2' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('start')
      tell({})
      await startThere()
      expect(switchNow()).toMatchObject({ outcome: 'put_back', interrupted: true })
      expect(running()).toBe('9.9.1')
    }, 180_000 * SLOW)

  })
})
