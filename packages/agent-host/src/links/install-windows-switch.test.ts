import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installRemote, installScript } from './install.js'
import { SwitchUnderWay, type RemoteSpec } from './tunnel.js'
import { readSwitchStatus, rollbackRemote, uninstallRemote, updateRemote } from './update.js'
import { WIN_NODE_V, nodeWithoutEnv } from './windows-remote.test-helpers.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'
import { removeTree } from '../temp-dir.test-helpers.js'
import { windowsRemote } from './install-windows.test-helpers.js'

/**
 * A Windows machine whose switcher is killed or raced, and rolling back and uninstalling.
 * (the setup is install-windows.test-helpers.ts; the suite was one file, install-windows.test.ts)
 */

// The install scripts ask the machine for its architecture, and only x64 Windows has a build
describe.runIf(process.platform === 'win32' && process.arch === 'x64')('installing on and updating a Windows machine over a fake ssh into a real PowerShell', () => {
  const w = windowsRemote()
  const { data, remote, events, running, tunnel, control, tell, update, startThere, installedAndRunning, switchNow, goneAfterHandover, killSwitcher } = w

  describe('updating, rolling back and uninstalling (a killed or raced switch, rollback, uninstall)', () => {
    // §10.5a: a switcher that dies leaves its step; the next start there finishes it before it starts anything
    it('a switcher killed before the switch is finished by the next start: nothing was switched, the old version runs', async () => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_HOLD: 'stop' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('stop')
      tell({})
      await startThere()
      expect(switchNow()).toMatchObject({ outcome: 'failed', interrupted: true })
      expect(running()).toBe('9.9.1')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    it('a switcher killed between the switch and the check is finished by the next start: the old version is put back and runs', async () => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_HOLD: 'start 9.9.2' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('start')
      // `current` names the new version, whose --detach finishes the switch and has the old one serve
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
      tell({})
      await startThere()
      expect(switchNow()).toMatchObject({ outcome: 'put_back', interrupted: true })
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(running()).toBe('9.9.1')
      expect(events().at(-1)).toBe('start 9.9.1')
    }, 180_000 * SLOW)

    /*
     * #1907: killed once it wrote `check`, the new host already answering. A later start or status read (hours later)
     * found a switch with no outcome and put the old version back, stopping a host that worked
     */
    it.each(['a start there', 'a status read'])('a switcher killed at the check while the new version answers is finished forward by %s: it keeps serving', async (by) => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_HOLD: 'connection 9.9.2' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('check')
      tell({})
      if (by === 'a start there') await startThere()
      else expect(await readSwitchStatus(control().c)).toMatchObject({ outcome: 'done', interrupted: true })
      expect(switchNow()).toMatchObject({ outcome: 'done', interrupted: true })
      expect(running()).toBe('9.9.2')
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.2'])
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    /*
     * #1907: a version from before the switch asks no switch before it starts. Started between the stop and the new
     * start (the sign-in task, the person, a hub on it), it held the folder; the new version did not answer and the old
     * one was put back
     */
    it('stops a host of the old version that was started during the switch by one that does not ask, and the update goes through', async () => {
      await installedAndRunning()
      const { done } = update('9.9.2', { FAKE_HOLD: 'stopped', FAKE_NO_GATE: '9.9.1' })
      await eventually(() => existsSync(data('holding')), 60_000)
      expect(switchNow().step).toBe('stop')
      await startThere()
      expect(running()).toBe('9.9.1')
      writeFileSync(data('release'), 'go')
      expect(await done).toMatchObject({ current: { version: '9.9.2' } })
      expect(running()).toBe('9.9.2')
      expect(events()).toEqual(['stop 9.9.1 (for update)', 'start 9.9.1', 'stop 9.9.1 (for update)', 'start 9.9.2'])
      expect(switchNow()).toMatchObject({ outcome: 'done', startedMeanwhile: '9.9.1' })
    }, 240_000 * SLOW)

    /*
     * #1907: a switcher died at the start and nobody finished its switch; then someone started the old version with its
     * own CLI, which asks no switch. The next reader stopped that host and started it again. It now leaves it serving
     */
    it('a reader finishing a dead switch leaves serving an old host someone started meanwhile, and puts the pointers back', async () => {
      await installedAndRunning()
      void update('9.9.2', { FAKE_HOLD: 'start 9.9.2' }, { exec: goneAfterHandover() }).done.catch(() => undefined)
      await killSwitcher('start')
      tell({})
      // 9.9.1 started by hand: a fake version's host is its `running` file
      writeFileSync(data('running'), '9.9.1')
      const before = events()
      expect(await readSwitchStatus(control().c)).toMatchObject({ outcome: 'put_back', kept: '9.9.1', interrupted: true })
      // Nothing stopped, nothing started again
      expect(events()).toEqual(before)
      expect(running()).toBe('9.9.1')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    it('refuses a second update, and starts no host, while a live switcher is between its stop and its start', async () => {
      await installedAndRunning()
      const first = update('9.9.2', { FAKE_HOLD: 'stop' })
      await eventually(() => existsSync(data('holding')), 60_000)
      const runner = readFileSync(remote('switch.runner'), 'utf8')
      const second = update('9.9.3', { FAKE_HOLD: 'stop' })
      await expect(second.done).rejects.toThrow(/^An update of box started from \S+ at \d\d:\d\d is still running; try again when it ends$/)
      // #1907: refused before it held its link or said `stop`, and the machine's record of who reads the switch is as it was
      expect(second.seen).not.toContain('hold')
      expect(second.seen).not.toContain('stop')
      expect(readFileSync(remote('switch.runner'), 'utf8')).toBe(runner)
      await expect(tunnel().startHost()).rejects.toBeInstanceOf(SwitchUnderWay)
      writeFileSync(data('release'), 'go')
      expect(await first.done).toMatchObject({ current: { version: '9.9.2' } })
      expect(running()).toBe('9.9.2')
    }, 240_000 * SLOW)
    it('refuses to switch between two versions from before the machine ran its own switch, and leaves both as they were', async () => {
      await installedAndRunning('9.9.8')
      await expect(update('9.9.9').done).rejects.toThrow('Update box first: both versions there predate updates the machine runs itself')
      expect(running()).toBe('9.9.8')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.8 ${WIN_NODE_V}\n`)
      expect(events()).toEqual([])
    }, 180_000 * SLOW)

    // So a link can drive a temporary folder on a machine whose own installation it must not touch
    it('installs, starts and updates in the data folder the link names, not the one its ssh session has (#1903)', async () => {
      // Named as a Windows temp folder may be: an 8.3 short name (a CI runner's), `$` and parentheses, read as written
      const other = join(w.root, 'OTHER~1 $data (1)')
      try {
        const spec: RemoteSpec = { shell: 'powershell', dataDir: other }
        const first = control({}, { spec })
        await installRemote({ exec: first.c.exec, spec, target: 'box', version: '9.9.1', runtime: w.runtime, script: installScript(), registry: { registry: w.reg.url }, nodeDist: `${w.reg.url}/dist` })
        nodeWithoutEnv(other)
        await startThere(spec)
        tell({}, other)
        const { c } = control({}, { spec })
        expect(await updateRemote(c, { version: '9.9.2', runtime: w.runtime, registry: { registry: w.reg.url }, nodeDist: `${w.reg.url}/dist` })).toMatchObject({ current: { version: '9.9.2' } })
        expect(readFileSync(join(other, 'events'), 'utf8').trim().split('\n')).toEqual(['start 9.9.1', 'stop 9.9.1 (for update)', 'start 9.9.2'])
        expect(readFileSync(join(other, 'remote', 'current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
        // The folder the ssh session names (its CC_DATA_DIR) was not touched
        expect(existsSync(data())).toBe(false)
      } finally {
        await removeTree(other)
      }
    }, 180_000 * SLOW)

    it('rolls back one step, run by the version that runs now: previous becomes current, and there is no previous left to go back to', async () => {
      await installedAndRunning()
      await update('9.9.2').done
      rmSync(data('events'))
      const { c, seen } = control()
      const r = await rollbackRemote(c, { current: { version: '9.9.2', node: WIN_NODE_V }, previous: { version: '9.9.1', node: WIN_NODE_V } })
      expect(r).toMatchObject({ current: { version: '9.9.1', node: WIN_NODE_V }, previous: null })
      expect(seen.at(0)).toBe('hold')
      expect(events()).toEqual(['stop 9.9.2 (for update)', 'start 9.9.1'])
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('previous'))).toBe(false)
      expect(readFileSync(remote('switch.runner'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
    }, 180_000 * SLOW)

    it('uninstalls: stops the host, removes <data>\\remote, keeps the rest of the data', async () => {
      await installedAndRunning()
      writeFileSync(data('serve.json'), '{"token":"t"}')
      writeFileSync(data('autostart'), 'on')
      const { c, seen } = control()
      expect(await uninstallRemote(c)).toEqual({ stopped: true })
      expect(seen).toEqual(['hold', 'stop', 'autostart', 'remove'])
      // The boot entry goes, through the Centralu it would start, after the host stopped and before its files go
      expect(events()).toEqual(['stop 9.9.1', 'autostart remove'])
      expect(existsSync(data('autostart'))).toBe(false)
      expect(existsSync(remote())).toBe(false)
      expect(existsSync(data('serve.json'))).toBe(true)
      expect(running()).toBeNull()
    }, 120_000 * SLOW)
  })
})
